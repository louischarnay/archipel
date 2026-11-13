import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Sessions } from '../auth/sessions.js';
import { verify } from '../auth/tokens.js';
import { CONFIG } from '../config/tokens.js';
import type { Config } from '../types.js';
import { Registry } from './registry.js';

interface AppClaims {
  sub: string;
  name: string;
  roles: string[];
  key: string;
  sid: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '600',
};

// The apps' API. It only accepts a Bearer token limited to the app, never the session cookie:
// so it is open to the opaque origin of frontends without exposing the launchpad.
@Controller('run')
export class RunController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly registry: Registry,
    private readonly sessions: Sessions,
  ) {}

  @All('*')
  async run(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (!METHODS.has(request.method)) return reply.code(404).send({ error: 'Page not found' });
    reply.headers(CORS);
    if (request.method === 'OPTIONS') return reply.code(204).send();

    const url = new URL(request.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    const key = parts[0] === 'p' ? parts[1] : parts[0];
    const path = `/${parts.slice(parts[0] === 'p' ? 2 : 1).join('/')}`;

    const mount = key && this.registry.get(key);
    if (!mount) return reply.code(404).send({ error: 'App not found or stopped' });

    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    const token = verify<AppClaims>(bearer, this.config.secrets, 'app');
    if (!token || !(await this.sessions.isActive(token.sid))) {
      return reply.code(401).send({ error: 'App token missing or expired: reload the app' });
    }
    if (token.key !== mount.key) return reply.code(403).send({ error: 'This token is not valid for this app' });

    const response = await this.registry.dispatch(mount, {
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: request.body,
      user: { sub: token.sub, name: token.name, roles: token.roles },
    });
    mount.log(response.status >= 500 ? 'error' : 'info', `${request.method} ${path} → ${response.status} (${token.name})`);
    if (response.status === 204) return reply.code(204).send();
    return reply.code(response.status).send(response.body);
  }
}
