import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { loadConfig, loadStorage } from '../packages/server/src/config/config.js';
import { openDatabase } from '../packages/server/src/database/database.js';
import { readInstance } from '../packages/server/src/config/instance.js';
import { RESERVED_ROUTES } from '@archipel/manifest-schema';
import { freshPostgres, startPlatform } from './helpers.js';
import { startIdp } from './idp.js';

const TEST_PG = process.env.ARCHIPEL_TEST_PG;
const PNG = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64')}`;
const HEAVY = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e47', 'hex'), Buffer.alloc(300 * 1024)]).toString('base64')}`;
const SVG = `data:image/png;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;

const production = { ARCHIPEL_AUTH: 'oidc' };
// Cancels the database imposed by `ARCHIPEL_TEST_PG`: it would lock the tested section.
const sqlite = { DB_CLIENT: '', DB_URL: '' };

async function unlock(platform) {
  const response = await platform.api.post('/api/setup/unlock', { code: platform.setup.code });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = response.cookies.find((item) => item.name === 'archipel_setup');
  platform.api.useCookie(`${cookie.name}=${cookie.value}`);
}

// Replays what the browser does: test page, provider, return.
async function testLogin(platform, idp, overrides = {}) {
  const { app, api } = platform;
  const created = await api.post('/api/settings/identity/test', {
    issuer: idp.issuer,
    clientId: 'archipel',
    clientSecret: 'client-secret',
    publicUrl: 'http://127.0.0.1:3000',
    ...overrides,
  });
  assert.equal(created.statusCode, 200, created.body);
  const { id, ok, error } = created.json();
  assert.ok(ok, error);

  const start = await app.inject({ url: `/auth/test/${id}` });
  assert.equal(start.statusCode, 302, start.body);
  const pending = start.cookies.find((item) => item.name === 'archipel_login');
  const redirect = await fetch(start.headers.location, { redirect: 'manual' });
  const callback = new URL(redirect.headers.get('location'));
  const back = await app.inject({ url: callback.pathname + callback.search, cookies: { archipel_login: pending.value } });
  assert.equal(back.headers.location, '/ui/oidc-test.html');
  assert.equal(
    back.cookies.find((item) => item.name === 'archipel_session'),
    undefined,
  );
  return id;
}

describe('setup without a provider', () => {
  let platform;
  let idp;

  before(async () => {
    idp = await startIdp();
    platform = await startPlatform(production, { fresh: true });
  });
  after(async () => {
    await platform.stop();
    idp.close();
  });

  test('everything is closed outside the wizard', async () => {
    const { app } = platform;
    assert.equal((await app.inject({ url: '/' })).headers.location, '/setup');
    assert.equal((await app.inject({ url: '/login' })).headers.location, '/setup');
    assert.equal((await app.inject({ url: '/api/launchpad' })).statusCode, 503);
    assert.equal((await app.inject({ url: '/api/apps' })).statusCode, 503);
    assert.equal((await app.inject({ url: '/auth/login' })).statusCode, 302);
    assert.equal((await app.inject({ url: '/auth/local' })).statusCode, 302);
    assert.equal((await app.inject({ url: '/setup' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
  });

  test('the code shown in the logs is required', async () => {
    const { app, setup } = platform;
    assert.match(setup.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal((await app.inject({ url: '/api/settings' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/setup/state' })).json().unlocked, false);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/setup/unlock',
      headers: { origin: platform.config.publicUrl },
      payload: { code: 'AAAAA-AAAAA-AAAAA' },
    });
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.cookies.length, 0);
    const forged = await app.inject({ url: '/api/settings', cookies: { archipel_setup: 'e30.AAAA' } });
    assert.equal(forged.statusCode, 401);

    await unlock(platform);
    assert.equal((await platform.api.get('/api/setup/state')).json().unlocked, true);
    assert.equal((await platform.api.get('/api/settings')).json().mode, 'setup');
  });

  test('the wizard does not finish without a checked provider', async () => {
    const skipped = await platform.api.put('/api/settings', { completeSetup: true });
    assert.equal(skipped.statusCode, 409);
    const invented = await platform.api.put('/api/settings', { identity: { testId: 'unknown' }, completeSetup: true });
    assert.equal(invented.statusCode, 409);
    assert.equal(existsSync(join(platform.dir, 'instance.json')), false);
  });

  test('an account outside the admin group cannot activate the provider', async () => {
    idp.state.groups = ['helpdesk'];
    const id = await testLogin(platform, idp);
    const status = (await platform.api.get(`/api/settings/identity/test/${id}`)).json();
    assert.equal(status.status, 'refused');
    assert.deepEqual(status.user.groups, ['helpdesk']);
    assert.equal((await platform.api.put('/api/settings', { identity: { testId: id } })).statusCode, 409);
    assert.equal(platform.config.auth.mode, 'setup');
    idp.state.groups = ['archipel-admin'];
  });

  test('a successful test finishes setup and opens OIDC sign-in', async () => {
    const id = await testLogin(platform, idp, { providerName: 'Pocket ID' });
    assert.equal((await platform.api.get(`/api/settings/identity/test/${id}`)).json().status, 'ok');

    const finished = await platform.api.put('/api/settings', {
      identity: { testId: id },
      launchpad: { name: 'My platform', accent: 'foret' },
      completeSetup: true,
    });
    assert.equal(finished.statusCode, 200, finished.body);

    // The file keeps the secret, the API never returns it.
    const file = join(platform.dir, 'instance.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).oidc.clientSecret, 'client-secret');

    // The setup session dies with setup mode.
    assert.equal((await platform.api.get('/api/settings')).statusCode, 401);
    assert.equal((await platform.api.post('/api/setup/unlock', { code: platform.setup.code })).statusCode, 409);

    const login = await platform.app.inject({ url: '/login' });
    assert.match(login.body, /Welcome to My platform/);
    assert.match(login.body, /Continue with Pocket ID/);
    assert.match(login.body, /data-accent="foret"/);
    assert.match(login.body, /class="login-alt"[^>]* hidden>/);
    assert.match(login.body, /class="dev-bar" hidden>/);
    assert.equal((await platform.app.inject({ url: '/auth/login' })).headers.location.startsWith(idp.issuer), true);

    const reloaded = loadConfig({ ...production, ARCHIPEL_DATA_DIR: platform.dir });
    assert.equal(reloaded.auth.mode, 'oidc');
    assert.equal(reloaded.auth.issuer, idp.issuer);
    assert.equal(reloaded.publicUrl, 'http://127.0.0.1:3000');
  });
});

describe('first sign-in', () => {
  let platform;
  afterEach(() => platform.stop());

  test('the wizard opens once, and can be skipped', async () => {
    platform = await startPlatform({}, { fresh: true });
    const { api } = platform;
    assert.equal((await api.get('/')).headers.location, '/setup');
    assert.equal((await api.get('/setup')).statusCode, 200);

    assert.equal((await api.put('/api/settings', { completeSetup: true })).statusCode, 200);
    assert.equal((await api.get('/')).statusCode, 200);
    assert.equal((await api.get('/setup')).headers.location, '/');
    assert.equal(platform.config.auth.mode, 'dev');
  });

  test('a visitor cannot reach it without a session', async () => {
    platform = await startPlatform({}, { fresh: true });
    assert.equal((await platform.app.inject({ url: '/setup' })).headers.location, '/login?returnTo=/setup');
  });

  test('a provider given by the environment does not require a code', async () => {
    platform = await startPlatform({ ...production, OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'x' }, { fresh: true });
    assert.equal(platform.setup.code, null);
    assert.equal((await platform.app.inject({ url: '/' })).headers.location, '/login');
  });
});

describe('settings', () => {
  let platform;
  let idp;
  let other;

  before(async () => {
    idp = await startIdp();
    other = await startIdp();
    platform = await startPlatform();
  });
  after(async () => {
    await platform.stop();
    idp.close();
    other.close();
  });

  test('the launchpad is customised and applies everywhere', async () => {
    const { api, app } = platform;
    const saved = await api.put('/api/settings', {
      launchpad: {
        name: ' Café <b>green</b> ',
        title: 'My tools',
        welcome: 'Hello',
        loginMessage: 'Internal account',
        accent: 'prune',
        background: 'plain',
        showGroups: false,
        openMode: 'tab',
        logo: PNG,
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);

    const { branding } = (await api.get('/api/me')).json();
    assert.equal(branding.name, 'Café <b>green</b>');
    assert.equal(branding.openMode, 'tab');
    assert.equal(branding.hasLogo, true);
    assert.equal(branding.logo, undefined);

    const anonymous = await app.inject({ url: '/login' });
    assert.match(anonymous.body, /Café &#60;b&#62;green/);
    assert.match(anonymous.body, /Internal account/);
    assert.match(anonymous.body, /data-background="plain"/);
    assert.doesNotMatch(anonymous.body, /class="dev-bar" hidden/);

    const logo = await app.inject({ url: '/ui/logo' });
    assert.equal(logo.headers['content-type'], 'image/png');
    assert.equal(logo.headers['x-content-type-options'], 'nosniff');
    assert.match((await app.inject({ url: '/ui/mark.svg' })).body, /#6b3fa0/);

    assert.equal((await api.put('/api/settings', { launchpad: { logo: null } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/ui/logo' })).headers.location, '/ui/mark.svg');
  });

  test('invalid values are refused without changing anything', async () => {
    const { api } = platform;
    const before = readInstance(platform.dir);
    for (const launchpad of [
      { name: '' },
      { name: 'x'.repeat(41) },
      { accent: 'fluo' },
      { background: 'url(evil)' },
      { openMode: 'popup' },
      { logo: SVG },
      { logo: 'https://evil.example/logo.png' },
      { logo: HEAVY },
    ]) {
      assert.equal((await api.put('/api/settings', { launchpad })).statusCode, 400, JSON.stringify(launchpad).slice(0, 60));
    }
    assert.deepEqual(readInstance(platform.dir), before);
  });

  test('identity is reconfigured on the fly and the secret does not leak', async () => {
    const { api, app } = platform;
    const first = await testLogin(platform, idp, { providerName: 'Premier' });
    assert.equal((await api.put('/api/settings', { identity: { testId: first } })).statusCode, 200);
    assert.ok((await app.inject({ url: '/auth/login' })).headers.location.startsWith(idp.issuer));

    const settings = await api.get('/api/settings');
    assert.equal(settings.json().identity.hasClientSecret, true);
    assert.equal(settings.body.includes('client-secret'), false);

    // Without re-entering it, the secret follows the same provider...
    const same = await testLogin(platform, idp, { clientSecret: '' });
    assert.ok(same);
    assert.match(idp.state.clientSecret, /client-secret|^Basic /);

    // ...but never goes to another issuer.
    other.state.clientSecret = 'never-seen';
    await testLogin(platform, other, { clientSecret: '' });
    assert.equal(other.state.clientSecret, null);

    const second = await testLogin(platform, other, { clientSecret: 'other-secret' });
    assert.equal((await api.put('/api/settings', { identity: { testId: second } })).statusCode, 200);
    assert.ok((await app.inject({ url: '/auth/login' })).headers.location.startsWith(other.issuer));
    // A test is only used once.
    assert.equal((await api.put('/api/settings', { identity: { testId: second } })).statusCode, 409);
  });

  test('npm run dev keeps the local session next to the provider', async () => {
    const { app } = platform;
    const local = await app.inject({ url: '/auth/local?returnTo=/%23/apps' });
    assert.equal(local.headers.location, '/#/apps');
    const login = await app.inject({ url: '/login' });
    assert.match(login.body, /class="login-alt" href="\/auth\/local\?returnTo=%2F" >/);
  });

  test('a remote http or unreachable issuer is reported', async () => {
    const { api } = platform;
    const http = await api.post('/api/settings/identity/test', {
      issuer: 'http://id.example',
      clientId: 'x',
      publicUrl: 'http://127.0.0.1:3000',
    });
    assert.equal(http.statusCode, 400);
    const down = await api.post('/api/settings/identity/test', {
      issuer: 'http://127.0.0.1:1',
      clientId: 'x',
      publicUrl: 'http://127.0.0.1:3000',
    });
    assert.equal(down.json().ok, false);
  });

  test('an agent token never reaches the settings', async () => {
    const { api, app } = platform;
    const { token } = (await api.post('/api/agent-tokens', { name: 'ci' })).json();
    const authorization = `Bearer ${token}`;
    assert.equal((await app.inject({ url: '/api/settings', headers: { authorization } })).statusCode, 403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization },
      payload: { launchpad: { name: 'x' } },
    });
    assert.equal(put.statusCode, 403);
    const crossOrigin = await api.put('/api/settings', { launchpad: { name: 'x' } }, { origin: 'null' });
    assert.equal(crossOrigin.statusCode, 403);
  });

  test('API responses do not stay in the browser cache', async () => {
    const { api } = platform;
    for (const url of ['/api/me', '/api/settings', '/api/setup/state']) {
      assert.equal((await api.get(url)).headers['cache-control'], 'no-store', url);
    }
  });

  test('/setup is a reserved route', () => {
    assert.ok(RESERVED_ROUTES.includes('/setup'));
  });
});

describe('environment first', () => {
  test('identity and database from the environment are locked', async () => {
    const platform = await startPlatform({
      ARCHIPEL_AUTH: 'dev',
      OIDC_ISSUER: 'http://127.0.0.1:1',
      OIDC_CLIENT_ID: 'x',
      DB_CLIENT: process.env.ARCHIPEL_TEST_PG ? 'pg' : 'better-sqlite3',
    });
    const { api } = platform;

    const settings = (await api.get('/api/settings')).json();
    assert.equal(settings.identity.locked, true);
    assert.equal(settings.database.locked, true);
    assert.equal(
      (await api.post('/api/settings/identity/test', { issuer: 'http://127.0.0.1:1', clientId: 'x' })).statusCode,
      409,
    );
    assert.equal((await api.post('/api/settings/database/test', { client: 'better-sqlite3' })).statusCode, 409);
    assert.equal((await api.put('/api/settings', { identity: { testId: 'x' } })).statusCode, 409);
    assert.equal((await api.put('/api/settings', { database: { client: 'better-sqlite3' } })).statusCode, 409);
    await platform.stop();
  });

  test('DB_URL takes precedence over the instance file', () => {
    const storage = loadStorage({ ARCHIPEL_DATA_DIR: '/tmp/archipel-cfg', DB_CLIENT: 'pg', DB_URL: 'postgres://h/d' });
    assert.equal(storage.db.client, 'pg');
    assert.equal(storage.db.connection, 'postgres://h/d');
  });
});

describe('database', () => {
  let platform;
  afterEach(() => platform.stop());

  test('an invalid URL or an unreachable server is reported without leaking', async () => {
    platform = await startPlatform(sqlite);
    const { api } = platform;
    assert.equal((await api.post('/api/settings/database/test', { client: 'mysql' })).statusCode, 400);
    assert.equal((await api.post('/api/settings/database/test', { client: 'pg', url: 'file:///etc/passwd' })).statusCode, 400);

    const down = await api.post('/api/settings/database/test', { client: 'pg', url: 'postgres://u:s3cret@127.0.0.1:1/x' });
    assert.equal(down.statusCode, 200);
    assert.equal(down.json().ok, false);
    assert.equal(down.body.includes('s3cret'), false);

    const applied = await api.put('/api/settings', { database: { client: 'pg', url: 'postgres://u:s3cret@127.0.0.1:1/x' } });
    assert.equal(applied.statusCode, 400);
    assert.equal(applied.body.includes('s3cret'), false);
    assert.equal(readInstance(platform.dir).db, undefined);
  });

  test('without a change, nothing restarts', async () => {
    let restarted = 0;
    platform = await startPlatform(sqlite, {
      restart: () => {
        restarted += 1;
      },
    });
    const response = await platform.api.put('/api/settings', { database: { client: 'better-sqlite3' } });
    assert.equal(response.json().restart, null);
    assert.equal(restarted, 0);
  });

  test('PostgreSQL is checked, prepared and applied at restart', { skip: !TEST_PG }, async () => {
    let restarted = 0;
    platform = await startPlatform(sqlite, {
      restart: () => {
        restarted += 1;
      },
    });
    const { api, dir } = platform;
    assert.equal((await api.get('/api/settings')).json().database.client, 'better-sqlite3');

    const url = await freshPostgres(TEST_PG);
    const check = (await api.post('/api/settings/database/test', { client: 'pg', url })).json();
    assert.equal(check.ok, true, check.error);
    assert.match(check.version, /^PostgreSQL/);
    assert.equal(check.apps, null);

    const applied = await api.put('/api/settings', { database: { client: 'pg', url } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().restart, 'running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(restarted, 1);

    const storage = loadStorage({ ARCHIPEL_DATA_DIR: dir });
    assert.equal(storage.db.client, 'pg');
    const db = await openDatabase(storage);
    assert.equal(await db.schema.hasTable('platform_apps'), true);
    await db.destroy();

    assert.equal((await api.post('/api/settings/database/test', { client: 'pg', url })).json().apps, 0);
  });

  test('going back to SQLite removes the connection from the file', { skip: !TEST_PG }, async () => {
    platform = await startPlatform(sqlite);
    const { api, dir } = platform;
    const url = await freshPostgres(TEST_PG);
    assert.equal((await api.put('/api/settings', { database: { client: 'pg', url } })).json().restart, 'manual');
    await platform.app.close();

    const restarted = await startPlatform({ ...sqlite, ARCHIPEL_DATA_DIR: dir });
    assert.equal(restarted.config.db.client, 'pg');
    assert.equal((await restarted.api.put('/api/settings', { database: { client: 'better-sqlite3' } })).statusCode, 200);
    assert.equal(readInstance(dir).db, undefined);
    platform = restarted;
  });
});
