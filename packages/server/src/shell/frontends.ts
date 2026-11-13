import { statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { rolesFor } from '../auth/roles.js';
import { sign } from '../auth/tokens.js';
import { browserSource } from '@archipel/manifest-schema';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Mount } from '../runtime/registry.js';
import type { Config } from '../types.js';
import { contentType, readText, resolveInside, sendFile } from '../http/files.js';

// The mount's rules, not the manifest's: a preview frontend only reaches what is already approved.
function networkSources(mount: Mount) {
  return mount.network.map(browserSource).join(' ');
}

// An app's frontend is generated code: it runs in an opaque origin, without access to the launchpad
// session. It only talks to its own API, with a token limited to this app.
export const APP_TOKEN_TTL_S = 3600;

function sandboxCsp(mount: Mount, request: FastifyRequest) {
  // In a sandboxed document, 'self' no longer means anything in WebKit: the origin must be explicit.
  const origin = /^[a-z0-9.:[\]-]+$/i.test(request.host ?? '') ? `${request.protocol}://${request.host}` : '';
  const hosts = `${origin} ${networkSources(mount)}`.trim();
  return [
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
    `default-src 'self' ${hosts}`,
    `script-src 'self' 'unsafe-inline' ${hosts}`,
    `style-src 'self' 'unsafe-inline' ${hosts}`,
    `img-src 'self' data: blob: ${hosts}`,
    `connect-src 'self' ${hosts}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

function bootstrapScript(mount: Mount, request: FastifyRequest, config: Config) {
  const user = request.user!;
  const session = request.session!;
  const roles = rolesFor(user, mount.manifest);
  const token = sign(
    { sub: user.sub, name: user.name, roles, key: mount.key, sid: session.id },
    config.secrets,
    'app',
    APP_TOKEN_TTL_S,
  );
  const data = {
    app: mount.appId,
    version: mount.manifest.version,
    preview: mount.preview,
    user: { name: user.name, roles },
    apiBase: mount.apiBase,
  };
  const safe = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  return `<script>(function(){var d=${safe(data)},t=${safe(token)};d.api=function(p,o){o=o||{};var h=new Headers(o.headers);h.set('Authorization','Bearer '+t);if(o.body&&typeof o.body!=='string'){o.body=JSON.stringify(o.body);h.set('Content-Type','application/json');}return fetch(d.apiBase+p,Object.assign({},o,{headers:h})).then(function(r){if(r.status===204)return null;return r.json().then(function(b){if(!r.ok){var e=new Error(b.error||r.statusText);e.status=r.status;e.details=b.details;throw e;}return b;});});};window.archipel=d;})();</script>`;
}

function injectBootstrap(html: string, script: string) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  return script + html;
}

export function serveFrontend(mount: Mount, subpath: string, request: FastifyRequest, reply: FastifyReply, config: Config) {
  const root = join(mount.root, mount.manifest.frontend!.dir);
  let file = resolveInside(root, subpath || 'index.html');
  if (file && statSync(file).isDirectory()) file = resolveInside(root, join(subpath, 'index.html'));
  // Without a file or extension, let the app's client-side routing do its job.
  if (!file && !extname(subpath)) file = resolveInside(root, 'index.html');
  if (!file) return reply.code(404).send({ error: 'File not found' });

  const headers = { 'content-security-policy': sandboxCsp(mount, request), 'cache-control': 'no-cache' };
  if (!contentType(file).startsWith('text/html')) {
    return sendFile(reply, file, { ...headers, 'access-control-allow-origin': '*' });
  }

  if (!request.user) {
    if (request.headers['sec-fetch-dest'] === 'iframe') {
      return reply
        .code(401)
        .headers({ ...headers, 'content-type': 'text/html; charset=utf-8' })
        .send('<!doctype html><meta charset="utf-8"><p>Session expired: reload the launchpad.</p>');
    }
    return reply.redirect(`/login?returnTo=${encodeURIComponent(request.url)}`, 302);
  }
  if (mount.preview && !request.user.admin) return reply.code(403).send({ error: 'Preview reserved for reviewers' });

  return reply
    .headers({ ...headers, 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' })
    .send(injectBootstrap(readText(file), bootstrapScript(mount, request, config)));
}
