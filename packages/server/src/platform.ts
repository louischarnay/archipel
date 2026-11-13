import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Knex } from 'knex';
import { AppModule } from './app.module.js';
import { AuthCookies } from './auth/cookies.js';
import { identifyRequests } from './auth/identity.js';
import { Sessions } from './auth/sessions.js';
import { Setup } from './auth/setup.js';
import type { Restart } from './config/tokens.js';
import { DATABASE } from './database/database.js';
import { Store } from './database/store.js';
import { registerOpenApi } from './http/openapi.js';
import { guardPerimeter, logDenials } from './http/perimeter.js';
import { withRequest } from './http/request-context.js';
import { holdDuringSetup } from './http/setup-gate.js';
import { Pipeline } from './pipeline/pipeline.js';
import { Registry } from './runtime/registry.js';
import { prepareSandbox } from './runtime/sandbox/launchers.js';
import type { Config } from './types.js';
import { VERSION } from './version.js';

const CONNECTION_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 2 * 60_000;

interface Options {
  logger?: FastifyServerOptions['logger'];
  restart?: Restart;
}

// The HTTP server underneath NestJS. Its options and plugins are set here because they apply to every route.
async function createServer(config: Config, logger: Options['logger']) {
  const fastify = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
    // An extra field is an error, not data to strip silently.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, verbose: true } },
  });
  fastify.addHook('onRequest', (request, reply, done) => withRequest(request, done));
  await fastify.register(cookie);
  if (config.limits.requestsPerMinute > 0) {
    await fastify.register(rateLimit, {
      max: config.limits.requestsPerMinute,
      timeWindow: '1 minute',
      errorResponseBuilder: (request, { statusCode, after }) =>
        Object.assign(new Error(`Too many requests: try again in ${after}.`), { statusCode }),
    });
  }
  await fastify.register(multipart, { limits: { fileSize: config.limits.uploadBytes, files: 1 } });
  await registerOpenApi(fastify, VERSION);
  // Fastify is typed by its logger: the default one is what the rest of the code expects.
  return fastify as unknown as FastifyInstance;
}

// Builds the whole platform without listening: `main.ts` and the tests both start from here.
export async function createPlatform(config: Config, { logger = false, restart = null }: Options = {}) {
  await prepareSandbox(config);
  const fastify = await createServer(config, logger);
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.with(config, restart), new FastifyAdapter(fastify), {
    logger: logger ? ['error', 'warn'] : false,
    // Fastify already parses JSON, with the limits set above.
    bodyParser: false,
    // A failed start is reported to the caller, which decides whether the process stops.
    abortOnError: false,
  });

  const store = app.get(Store);
  const sessions = app.get(Sessions);
  const pipeline = app.get(Pipeline);

  // These apply to every request, matched by a route or not, so they are hooks of the server and not guards.
  // Order matters: the origin is checked before anyone is identified, and identity before the setup gate.
  guardPerimeter(fastify, config);
  logDenials(fastify, store);
  identifyRequests(fastify, { config, store, sessions, cookies: app.get(AuthCookies) });
  holdDuringSetup(fastify, config);
  // An action without options is sent without a body: the route schema covers its options, not their presence.
  fastify.addHook('preValidation', async (request) => {
    if (request.body === undefined && request.routeOptions.schema?.body) request.body = {};
  });

  await pipeline.resume();
  await app.init();
  await fastify.ready();

  return {
    app,
    store,
    sessions,
    pipeline,
    registry: app.get(Registry),
    setup: app.get(Setup),
    db: app.get<Knex>(DATABASE),
  };
}
