import type { FastifyInstance } from 'fastify';
import type { Store } from '../database/store.js';
import type { Config, User } from '../types.js';
import { hashAgentToken } from './agent-tokens.js';
import { SESSION_COOKIE, type AuthCookies } from './cookies.js';
import type { Sessions } from './sessions.js';

const BEARER = /^bearer\s+(\S+)$/i;

export const DEV_USER: User = {
  sub: 'dev',
  name: 'Local developer',
  email: null,
  groups: ['archipel-admin'],
  admin: true,
};

// The person who entered the setup code: only exists in setup mode.
const SETUP_USER: User = {
  sub: 'setup',
  name: 'Installation',
  email: null,
  groups: [],
  admin: true,
};

interface Dependencies {
  config: Config;
  store: Store;
  sessions: Sessions;
  cookies: AuthCookies;
}

// Runs before any route: says who is calling, a person (`request.user`) or an agent (`request.agent`).
// The access rules of each route are then checked by `AccessGuard`.
export function identifyRequests(fastify: FastifyInstance, { config, store, sessions, cookies }: Dependencies) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('agent', null);
  fastify.decorateRequest('session', null);

  fastify.addHook('onRequest', async (request, reply) => {
    // An agent never has a `request.user`: any route reserved for a person refuses it by construction,
    // even if the request also carries a session cookie.
    const bearer = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (bearer && request.routeOptions.url?.startsWith('/api/')) {
      request.agent = await store.findAgentToken(hashAgentToken(bearer));
      if (!request.agent) return reply.code(401).send({ error: 'Invalid, expired or revoked agent token' });
      await store.touchAgentToken(request.agent);
      return;
    }
    if (config.auth.mode === 'setup') {
      request.user = cookies.hasSetupSession(request) ? SETUP_USER : null;
      return;
    }
    const token = cookies.read(request, SESSION_COOKIE);
    request.session = token ? await sessions.resolve(token) : null;
    request.user = request.session?.user ?? null;
  });
}
