import type { FastifyInstance } from 'fastify';
import type { Config } from '../types.js';

// The only routes open while no provider is configured.
const OPEN_DURING_SETUP = /^\/(setup$|ui\/|health$|auth\/(callback|test\/)|api\/(setup|settings)(\/|$))/;

// Without a provider nobody can sign in: everything else waits for the setup wizard.
export function holdDuringSetup(fastify: FastifyInstance, config: Config) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (config.auth.mode !== 'setup' || OPEN_DURING_SETUP.test(request.routeOptions.url ?? '')) return;
    if (request.url.startsWith('/api/')) return reply.code(503).send({ error: 'Setup in progress', setup: true });
    return reply.redirect('/setup', 302);
  });
}
