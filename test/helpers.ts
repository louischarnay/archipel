import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import knex from 'knex';
import { create } from 'tar';
import { createPlatform } from '../packages/server/src/platform.js';
import { loadConfig } from '../packages/server/src/config/config.js';
import type { Restart } from '../packages/server/src/config/tokens.js';
import type { Config } from '../packages/server/src/types.js';
import { writeInstance } from '../packages/server/src/config/instance.js';

const SAMPLES = new URL('../samples/', import.meta.url).pathname;
// `ARCHIPEL_TEST_PG=postgres://.../postgres npm test` replays the whole suite on PostgreSQL.
const TEST_PG = process.env.ARCHIPEL_TEST_PG;

// A fresh database per platform, like the temporary folder for SQLite.
export async function freshPostgres(admin: string = TEST_PG ?? '') {
  const name = `archipel_test_${randomBytes(6).toString('hex')}`;
  const db = knex({ client: 'pg', connection: admin });
  await db.raw('create database ??', [name]);
  await db.destroy();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

// A failed assertion skips the `stop()` written at the end of a test. The open database would then keep
// the process alive, and the run would hang instead of failing: whatever is still running stops here.
const running = new Set<() => Promise<void>>();
after(async () => {
  for (const stop of [...running]) await stop().catch(() => {});
});

// `fresh` leaves the instance without a finished setup, as on the very first launch.
export type TestPlatform = Awaited<ReturnType<typeof startPlatform>>;

export async function startPlatform(
  env: Record<string, string> = {},
  { fresh = false, restart = null }: { fresh?: boolean; restart?: Restart } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-test-'));
  if (!fresh) writeInstance(dir, { setup: { completedAt: new Date().toISOString(), by: 'test' } });
  const database = TEST_PG ? { DB_CLIENT: 'pg', DB_URL: await freshPostgres() } : {};
  const sandbox = process.env.ARCHIPEL_TEST_CONTAINER ? 'container' : 'process';
  const settings = { ARCHIPEL_AUTH: 'dev', ARCHIPEL_DATA_DIR: dir, ARCHIPEL_SANDBOX: sandbox, ...database, ...env };
  const config = loadConfig(settings, { allowProcessSandbox: true });
  const platform = await createPlatform(config, { restart });
  const api = createClient(platform.app, config);
  const stop = async () => {
    running.delete(stop);
    await platform.app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  running.add(stop);
  if (config.auth.mode === 'dev') await api.signIn();
  return { ...platform, api, config, dir, stop };
}

type Headers = Record<string, string>;

function createClient(app: NestFastifyApplication, config: Config) {
  let cookie: string | undefined;
  const auth = () => (cookie ? { cookie, origin: config.publicUrl } : { origin: config.publicUrl });
  const client = {
    async signIn() {
      const response = await app.inject({ url: '/auth/local' });
      const session = response.cookies.find((item) => item.name.endsWith('archipel_session'));
      if (!session) throw new Error(`No session cookie: ${response.body}`);
      cookie = `${session.name}=${session.value}`;
    },
    get: (url: string) => app.inject({ url, headers: auth() }),
    post: (url: string, body: object | string = {}, headers: Headers = {}) =>
      app.inject({ method: 'POST', url, headers: { ...auth(), ...headers }, payload: body }),
    put: (url: string, body: object | string = {}, headers: Headers = {}) =>
      app.inject({ method: 'PUT', url, headers: { ...auth(), ...headers }, payload: body }),
    delete: (url: string) => app.inject({ method: 'DELETE', url, headers: auth() }),
    useCookie(value: string | undefined) {
      cookie = value;
    },

    // Submits an app folder as the form would, then waits for the pipeline to finish.
    async submit(folder: string, headers: Headers = {}): Promise<any> {
      const archive = join(folder, '..', `${Math.random().toString(36).slice(2)}.tgz`);
      await create({ gzip: true, file: archive, cwd: folder }, ['.']);
      const boundary = '----archipel';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="app.tgz"\r\nContent-Type: application/gzip\r\n\r\n`,
        ),
        readFileSync(archive),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/releases/archive',
        headers: { ...auth(), ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      return client.waitFor(response.json().id);
    },

    async waitFor(id: string): Promise<any> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const release = (await client.get(`/api/releases/${id}`)).json();
        if (release.status !== 'processing') return release;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Pipeline stuck for ${id}`);
    },

    // App token as injected into the frontend.
    async appToken(path: string): Promise<string> {
      const html = (await client.get(path)).body;
      const match = /,t="([^"]+)"/.exec(html);
      if (!match) throw new Error(`No app token in ${path}`);
      return match[1]!;
    },
  };
  return client;
}

// Copies a sample app, applies file changes, returns its folder.
export function sampleCopy(name: string, edits: Record<string, string | ((text: string) => string)> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'archipel-app-')), 'app');
  cpSync(join(SAMPLES, name), dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(dir, file);
    writeFileSync(path, typeof edit === 'function' ? edit(readFileSync(path, 'utf8')) : edit);
  }
  return dir;
}

export function bareApp(manifest: string, files: Record<string, string> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'archipel-app-')), 'app');
  cpSync(join(SAMPLES, 'customers/assets'), join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'app.manifest.yaml'), manifest);
  for (const [file, content] of Object.entries(files)) {
    cpSync(join(SAMPLES, 'customers/web'), join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

export async function installLive(platform: TestPlatform, folder: string) {
  const release = await platform.api.submit(folder);
  if (release.status !== 'in_review') {
    throw new Error(`Version not reviewed: ${JSON.stringify(release.report)}`);
  }
  const response = await platform.api.post(`/api/releases/${release.id}/approve`, { comment: 'ok' });
  if (response.statusCode !== 200) throw new Error(response.body);
  return release;
}
