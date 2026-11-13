import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Store } from '../database/store.js';
import type { Config } from '../types.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PLATFORM_ROUTE = /^\/(api|auth)\//;
const BEARER = /^bearer\s/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// `HOST=0.0.0.0` without a public address: the access address is only known once setup is done.
const WILDCARD = new Set(['0.0.0.0', '[::]']);
const HSTS = 'max-age=31536000';

const GLOBAL_HEADERS = {
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
// Not for apps: a sandboxed page does not open under COOP, and an opaque origin loads nothing under CORP.
const SHELL_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function parseHost(value: string) {
  try {
    return new URL(`http://${value}`);
  } catch {
    return null;
  }
}

function hostAccepted(config: Config, host: string) {
  const expected = new URL(config.publicUrl);
  if (WILDCARD.has(expected.hostname)) return true;
  const received = parseHost(host);
  return received !== null && (received.host === expected.host || LOOPBACK.has(received.hostname));
}

function originAccepted(config: Config, request: FastifyRequest, origin: string) {
  const expected = new URL(config.publicUrl);
  if (origin === expected.origin) return true;
  try {
    const url = new URL(origin);
    // Without a public address, only the machine itself: the origin stays the one the browser loaded.
    return (WILDCARD.has(expected.hostname) || LOOPBACK.has(url.hostname)) && url.host === request.host?.toLowerCase();
  } catch {
    return false;
  }
}

// A Bearer token is not sent on its own: only a cookie exposes requests forged from another site.
function requestAccepted(config: Config, request: FastifyRequest) {
  const { origin, authorization } = request.headers;
  const site = request.headers['sec-fetch-site'];
  if (origin) return originAccepted(config, request, origin);
  if (site) return site === 'same-origin';
  return BEARER.test(authorization ?? '') && request.routeOptions.url!.startsWith('/api/');
}

// Refuses requests that do not come from the platform's own address, and sets the security headers.
export function guardPerimeter(fastify: FastifyInstance, config: Config) {
  fastify.addHook('onRequest', async (request, reply) => {
    // `/health`: a probe often targets the container's internal address.
    if (request.routeOptions.url !== '/health' && !hostAccepted(config, request.host)) {
      return reply.code(421).send({ error: "Unknown host: use the platform's public address." });
    }
    if (!MUTATING.has(request.method)) return;
    // The resolved route, not the raw URL: `/%61pi/...` lands on the same route as `/api/...`.
    if (!PLATFORM_ROUTE.test(request.routeOptions.url ?? '')) return;
    if (!requestAccepted(config, request)) return reply.code(403).send({ error: 'Origin refused' });
  });

  fastify.addHook('onSend', async (request, reply) => {
    reply.headers(GLOBAL_HEADERS);
    reply.header('x-request-id', request.id);
    if (config.publicUrl.startsWith('https://')) reply.header('strict-transport-security', HSTS);
    const sandboxed = String(reply.getHeader('content-security-policy') ?? '').startsWith('sandbox');
    if (!sandboxed && !reply.hasHeader('access-control-allow-origin')) reply.headers(SHELL_HEADERS);
    // Without this, going back serves a stale response, and private data stays on disk.
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
}

// Refusals are part of the audit trail: a token being tried, a person reaching for an administrator's route.
export function logDenials(fastify: FastifyInstance, store: Store) {
  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    if (!PLATFORM_ROUTE.test(route)) return;
    const refused = reply.statusCode === 403 || (reply.statusCode === 401 && request.headers.authorization);
    if (!refused) return;
    const actor = request.user?.name ?? (request.agent ? `agent:${request.agent.name}` : 'anonyme');
    await store
      .audit(actor, 'access.denied', { detail: { method: request.method, route, status: reply.statusCode } })
      .catch((error: unknown) => request.log.error(error));
  });
}
