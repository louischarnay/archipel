import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';

const DOCUMENTED = /^\/api\//;

// Register before the routes: the plugin records them as they are declared.
export async function registerOpenApi(fastify: FastifyInstance, version: string) {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Archipel API', version },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'archipel_session' },
          agent: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ session: [] }, { agent: [] }],
    },
    transform: ({ schema, url }) => ({ schema: { ...schema, hide: schema?.hide || !DOCUMENTED.test(url) }, url }),
  });
}
