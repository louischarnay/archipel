import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sign, verify } from '../packages/server/src/auth/tokens.js';
import { loadConfig, loadStorage, rotateSecret } from '../packages/server/src/config/config.js';
import { hasPlainSecrets, readInstance, writeInstance } from '../packages/server/src/config/instance.js';
import { installLive, sampleCopy, startPlatform, type TestPlatform } from './helpers.js';
import { startIdp } from './idp.js';

const ADMIN = { sub: 'u1', name: 'Sam', email: null, groups: [], admin: true };
const tempDir = () => mkdtempSync(join(tmpdir(), 'archipel-secure-'));
const hour = 3600_000;
const origin = (platform) => ({ origin: platform.config.publicUrl });
const RELEASE = 'rel000000000000';

describe('sessions', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
    await installLive(platform, sampleCopy('customers'));
  });
  after(() => platform.stop());

  const open = async (user = ADMIN, options?: Parameters<TestPlatform['sessions']['open']>[1]) =>
    (await platform.sessions.open(user, options)).token;
  const me = (token) => platform.app.inject({ url: '/api/me', cookies: { archipel_session: token } });
  const age = (id, patch) => platform.db('platform_sessions').update(patch).where({ id });

  test('only the cookie hash is stored', async () => {
    const token = await open();
    assert.equal((await me(token)).statusCode, 200);
    const rows = await platform.db('platform_sessions');
    assert.equal(JSON.stringify(rows).includes(token), false);
  });

  test('signing out revokes the cookie, even replayed', async () => {
    const token = await open();
    const cookies = { archipel_session: token };
    assert.equal((await me(token)).statusCode, 200);
    await platform.app.inject({ method: 'POST', url: '/auth/logout', cookies, headers: origin(platform) });
    assert.equal((await me(token)).statusCode, 401);
  });

  test('a forged cookie is worthless', async () => {
    const forged = sign(ADMIN, platform.config.secrets, 'session', 3600);
    assert.equal((await me(forged)).statusCode, 401);
  });

  test('inactivity and the absolute duration close the session', async () => {
    const idle = await platform.sessions.open(ADMIN);
    await age(idle.id, { last_seen_at: new Date(Date.now() - 2 * hour).toISOString() });
    assert.equal((await me(idle.token)).statusCode, 401);

    const expired = await platform.sessions.open(ADMIN);
    await age(expired.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await me(expired.token)).statusCode, 401);
  });

  test('a new sign-in replaces the previous session', async () => {
    const first = (await platform.app.inject({ url: '/auth/local' })).cookies[0].value;
    const second = await platform.app.inject({ url: '/auth/local', cookies: { archipel_session: first } });
    assert.equal((await me(first)).statusCode, 401);
    assert.equal((await me(second.cookies[0].value)).statusCode, 200);
  });

  test('an administrator lists and revokes, and the app token drops at once', async () => {
    const user = { ...ADMIN, sub: 'u2', name: 'Alex', admin: false };
    const { id, token } = await platform.sessions.open(user, { ip: '10.0.0.8', userAgent: 'x'.repeat(500) });
    const html = (await platform.app.inject({ url: '/customers/', cookies: { archipel_session: token } })).body;
    const appToken = /,t="([^"]+)"/.exec(html)[1];
    const run = () =>
      platform.app.inject({ url: '/run/customers/data/shared.customer', headers: { authorization: `Bearer ${appToken}` } });
    assert.equal((await run()).statusCode, 200);

    const listed = (await platform.api.get('/api/sessions')).json().sessions.find((session) => session.id === id);
    assert.equal(listed.ip, '10.0.0.8');
    assert.equal(listed.user_agent.length, 200);
    assert.equal(JSON.stringify(listed).includes('token'), false);

    assert.equal((await platform.api.post(`/api/sessions/${id}/revoke`)).statusCode, 200);
    assert.equal((await me(token)).statusCode, 401);
    assert.equal((await run()).statusCode, 401);
    assert.equal((await platform.api.post(`/api/sessions/${id}/revoke`)).statusCode, 404);
  });

  test('listing and revoking are reserved for administrators', async () => {
    const cookies = { archipel_session: await open({ ...ADMIN, admin: false }) };
    const target = await platform.sessions.open(ADMIN);
    assert.equal((await platform.app.inject({ url: '/api/sessions', cookies })).statusCode, 403);
    const response = await platform.app.inject({
      method: 'POST',
      url: `/api/sessions/${target.id}/revoke`,
      cookies,
      headers: origin(platform),
    });
    assert.equal(response.statusCode, 403);
    assert.equal((await me(target.token)).statusCode, 200);
    assert.equal((await platform.api.post('/api/sessions/nope/revoke')).statusCode, 400);
  });
});

describe('reauthentication', () => {
  let idp;
  let platform;
  before(async () => {
    idp = await startIdp();
    platform = await startPlatform({
      ARCHIPEL_AUTH: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'archipel',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_HTTP: '1',
    });
  });
  after(async () => {
    await platform.stop();
    idp.close();
  });

  const createToken = async (authTime) => {
    const { token } = await platform.sessions.open(ADMIN, { authTime });
    return platform.app.inject({
      method: 'POST',
      url: '/api/agent-tokens',
      cookies: { archipel_session: token },
      headers: origin(platform),
      payload: { name: 'ci' },
    });
  };

  async function reauthenticate(authTime) {
    idp.state.authTime = authTime;
    const start = await platform.app.inject({ url: '/auth/login?reauth=1&returnTo=/%23/settings' });
    const authorize = new URL(start.headers.location);
    const pending = start.cookies.find((item) => item.name === 'archipel_login');
    const redirect = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(redirect.headers.get('location'));
    const response = await platform.app.inject({
      url: callback.pathname + callback.search,
      cookies: { archipel_login: pending.value },
    });
    delete idp.state.authTime;
    return { authorize, response };
  }

  test('a sensitive action requires a recent sign-in', async () => {
    const stale = await createToken(Date.now() - hour);
    assert.equal(stale.statusCode, 403);
    assert.equal(stale.json().reauth_required, true);
    assert.equal((await createToken(Date.now() - 60_000)).statusCode, 201);
  });

  test('all decisions are covered', async () => {
    const { token } = await platform.sessions.open(ADMIN, { authTime: Date.now() - hour });
    const cookies = { archipel_session: token };
    const routes: [string, string, object][] = [
      ['POST', `/api/releases/${RELEASE}/approve`, {}],
      ['POST', '/api/apps/tickets/rollback', { releaseId: RELEASE }],
      ['POST', '/api/apps/tickets/uninstall', {}],
      ['POST', '/api/agent-tokens', { name: 'ci' }],
      ['PUT', '/api/settings', {}],
    ];
    for (const [method, url, payload] of routes) {
      const response = await platform.app.inject({ method, url, cookies, payload, headers: origin(platform) });
      assert.equal(response.json().reauth_required, true, url);
    }
  });

  test('the provider must ask for the identity again', async () => {
    const { authorize, response } = await reauthenticate(Math.floor(Date.now() / 1000));
    assert.equal(authorize.searchParams.get('prompt'), 'login');
    assert.equal(authorize.searchParams.get('max_age'), '0');
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/#/settings');
  });

  test('a provider that asks nothing again is refused', async () => {
    const { response } = await reauthenticate(Math.floor((Date.now() - hour) / 1000));
    assert.equal(response.statusCode, 403);
    assert.equal(
      response.cookies.find((item) => item.name === 'archipel_session'),
      undefined,
    );
  });

  test('signing out goes back to the provider when it allows it', async () => {
    const logout = async () => {
      const { token } = await platform.sessions.open(ADMIN);
      const response = await platform.app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { archipel_session: token },
        headers: origin(platform),
      });
      return response.json().redirect;
    };
    assert.equal(await logout(), null);

    idp.state.endSession = true;
    const other = await startPlatform({
      ARCHIPEL_AUTH: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'archipel',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_HTTP: '1',
    });
    const { token } = await other.sessions.open(ADMIN);
    const response = await other.app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { archipel_session: token },
      headers: origin(other),
    });
    const redirect = new URL(response.json().redirect);
    assert.equal(redirect.origin + redirect.pathname, `${idp.issuer}/logout`);
    assert.equal(redirect.searchParams.get('client_id'), 'archipel');
    await other.stop();
    delete idp.state.endSession;
  });
});

describe('cookies over https', () => {
  test('the __Host- prefix is set then read back', async () => {
    const platform = await startPlatform({ ARCHIPEL_PUBLIC_URL: 'https://archipel.example' });
    const response = await platform.app.inject({ url: '/auth/local' });
    const cookie = response.cookies.find((item) => item.name === '__Host-archipel_session');
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.path, '/');
    assert.equal(cookie.domain, undefined);
    const me = await platform.app.inject({ url: '/api/me', cookies: { [cookie.name]: cookie.value } });
    assert.equal(me.statusCode, 200);
    await platform.stop();
  });
});

describe('keys', () => {
  const current = randomBytes(32).toString('hex');
  const previous = randomBytes(32).toString('hex');

  test('one key per use', () => {
    const token = sign({ sub: 'x' }, current, 'session', 60);
    assert.equal(verify<{ sub: string }>(token, current, 'session').sub, 'x');
    assert.equal(verify(token, current, 'app'), null);
    const [kid, body, mac] = token.split('.');
    assert.equal(verify(`${sign({ sub: 'x' }, current, 'app', 60).split('.')[0]}.${body}.${mac}`, current, 'app'), null);
    assert.equal(verify(`${kid}.${body}.`, current, 'session'), null);
    assert.equal(verify('a.b', current, 'session'), null);
  });

  test('a token signed with the old key stays accepted during the rotation', () => {
    const token = sign({ sub: 'x' }, previous, 'app', 60);
    assert.equal(verify<{ sub: string }>(token, [current, previous], 'app').sub, 'x');
    assert.equal(verify(token, [current], 'app'), null);
    assert.equal(verify<{ sub: string }>(sign({ sub: 'x' }, [current, previous], 'app', 60), [current], 'app').sub, 'x');
  });

  test('an expired token is refused', () => {
    assert.equal(verify(sign({}, current, 'app', -1), current, 'app'), null);
  });

  test('rotation keeps a single old key', () => {
    const dir = tempDir();
    const env = { ARCHIPEL_DATA_DIR: dir, ARCHIPEL_AUTH: 'dev', ARCHIPEL_SANDBOX: 'process' };
    const options = { allowProcessSandbox: true };
    const first = loadConfig(env, options).secrets;
    assert.equal(first.length, 1);
    rotateSecret(dir);
    const second = loadConfig(env, options).secrets;
    assert.equal(second[1], first[0]);
    assert.notEqual(second[0], first[0]);
    rotateSecret(dir);
    const third = loadConfig(env, options).secrets;
    assert.deepEqual(third.slice(1), [second[0]]);
    assert.equal(statSync(join(dir, 'secret')).mode & 0o777, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a secret that is too short is refused', () => {
    const dir = tempDir();
    const env = { ARCHIPEL_DATA_DIR: dir, ARCHIPEL_AUTH: 'dev', ARCHIPEL_SANDBOX: 'process' };
    assert.throws(() => loadConfig({ ...env, ARCHIPEL_SECRET: 'short' }, { allowProcessSandbox: true }), /32 characters/);
    assert.throws(
      () => loadConfig({ ...env, ARCHIPEL_SECRET: current, ARCHIPEL_SECRET_PREVIOUS: 'short' }, { allowProcessSandbox: true }),
      /32 characters/,
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('secrets at rest', () => {
  const key = randomBytes(32);
  const instance = {
    oidc: { issuer: 'https://idp.example', clientSecret: 'value-to-protect' },
    db: { client: 'pg', url: 'postgres://user:value-to-protect@db/archipel' },
  };

  test('with a key, the file no longer contains anything readable', () => {
    const dir = tempDir();
    writeInstance(dir, instance, key);
    const raw = readFileSync(join(dir, 'instance.json'), 'utf8');
    assert.equal(raw.includes('value-to-protect'), false);
    assert.match(raw, /https:\/\/idp\.example/);
    assert.deepEqual(readInstance(dir, key), instance);
    assert.equal(hasPlainSecrets(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('without the right key, startup fails clearly', () => {
    const dir = tempDir();
    writeInstance(dir, instance, key);
    assert.throws(() => readInstance(dir), /ARCHIPEL_MASTER_KEY/);
    assert.throws(() => readInstance(dir, randomBytes(32)), /not the right key/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a moved field does not decrypt', () => {
    const dir = tempDir();
    writeInstance(dir, instance, key);
    const raw = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8'));
    raw.db.url = raw.oidc.clientSecret;
    writeFileSync(join(dir, 'instance.json'), JSON.stringify(raw));
    assert.throws(() => readInstance(dir, key), /not the right key/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a key added later encrypts the existing content at startup', () => {
    const dir = tempDir();
    writeInstance(dir, instance);
    assert.equal(hasPlainSecrets(dir), true);
    const { instance: loaded } = loadStorage({ ARCHIPEL_DATA_DIR: dir, ARCHIPEL_MASTER_KEY: key.toString('hex') });
    assert.deepEqual(loaded, instance);
    assert.equal(hasPlainSecrets(dir), false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a key of the wrong size is refused', () => {
    const dir = tempDir();
    assert.throws(() => loadStorage({ ARCHIPEL_DATA_DIR: dir, ARCHIPEL_MASTER_KEY: 'abcd' }), /32 bytes/);
    const file = join(dir, 'key');
    writeFileSync(file, `${key.toString('base64')}\n`);
    assert.ok(loadStorage({ ARCHIPEL_DATA_DIR: dir, ARCHIPEL_MASTER_KEY_FILE: file }).masterKey.equals(key));
    rmSync(dir, { recursive: true, force: true });
  });

  test('data/ and its files are closed to other accounts, including on an existing instance', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'instance.json'), '{}', { mode: 0o644 });
    writeFileSync(join(dir, 'archipel.db'), '', { mode: 0o644 });
    loadStorage({ ARCHIPEL_DATA_DIR: dir });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'instance.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'archipel.db')).mode & 0o777, 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
