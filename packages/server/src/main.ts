import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from './config/config.js';
import { hasPlainSecrets } from './config/instance.js';
import { createPlatform } from './platform.js';

let running: NestFastifyApplication;

// Switching databases reopens everything: the registry, the pipeline and the store hold it for their whole life.
async function restart(): Promise<void> {
  await running.close();
  await start();
}

async function start(): Promise<void> {
  const config = loadConfig();
  const { app, setup } = await createPlatform(config, {
    logger: { level: process.env.LOG_LEVEL || 'info' },
    restart: () =>
      restart().catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      }),
  });
  running = app;

  await app.listen({ host: config.host, port: config.port });
  const { log } = app.getHttpAdapter().getInstance();
  if (config.auth.mode === 'dev') {
    log.warn('Local development session: no OIDC authentication.');
  }
  if (config.sandbox.mode !== 'container') {
    log.warn('Apps not isolated: they run in a plain process, reserved for development.');
  }
  if (!config.masterKey && hasPlainSecrets(config.dataDir)) {
    log.warn('Plain-text secrets in data/instance.json: set ARCHIPEL_MASTER_KEY to encrypt them.');
  }
  if (setup.code) {
    log.warn(`Setup: open ${config.publicUrl}/setup and enter the code ${setup.code}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => running.close().then(() => process.exit(0)));
}

await start();
