import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../packages/server/src/config/config.js';
import { startPlatform } from './helpers.js';
import { startIdp } from './idp.js';

describe('OIDC', () => {
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

  async function login() {
    const { app } = platform;
    const start = await app.inject({ url: '/auth/login?returnTo=/%23/review' });
    assert.equal(start.statusCode, 302);
    const authorize = new URL(start.headers.location);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');

    const pending = start.cookies.find((item) => item.name === 'archipel_login');
    const redirect = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(redirect.headers.get('location'));
    return { app, callback, pending };
  }

  test('the full flow opens a session with the groups', async () => {
    const { app, callback, pending } = await login();
    const response = await app.inject({
      url: callback.pathname + callback.search,
      cookies: { archipel_login: pending.value },
    });
    assert.equal(response.statusCode, 302, response.body);
    assert.equal(response.headers.location, '/#/review');

    const session = response.cookies.find((item) => item.name === 'archipel_session');
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Lax');
    const me = await app.inject({ url: '/api/me', cookies: { archipel_session: session.value } });
    assert.equal(me.json().user.name, 'Camille');
    assert.equal(me.json().user.admin, true);
    assert.deepEqual(me.json().user.groups, ['archipel-admin', 'helpdesk']);
  });

  test('without the admin group, management is refused', async () => {
    idp.state.groups = ['helpdesk'];
    const { app, callback, pending } = await login();
    const response = await app.inject({ url: callback.pathname + callback.search, cookies: { archipel_login: pending.value } });
    const session = response.cookies.find((item) => item.name === 'archipel_session');
    const cookies = { archipel_session: session.value };
    assert.equal((await app.inject({ url: '/api/launchpad', cookies })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/apps', cookies })).statusCode, 403);
    idp.state.groups = ['archipel-admin'];
  });

  test('a forged state is rejected', async () => {
    const { app, callback, pending } = await login();
    callback.searchParams.set('state', 'falsifie');
    const response = await app.inject({ url: callback.pathname + callback.search, cookies: { archipel_login: pending.value } });
    assert.ok(response.statusCode >= 400);
    assert.equal(
      response.cookies.find((item) => item.name === 'archipel_session'),
      undefined,
    );
  });

  test('a callback without a sign-in session is rejected', async () => {
    const response = await platform.app.inject({ url: '/auth/callback?code=x&state=y' });
    assert.equal(response.statusCode, 400);
  });

  test('a sign-in return to another site is neutralised', async () => {
    const start = await platform.app.inject({ url: '/auth/login?returnTo=https://evil.example' });
    const pending = start.cookies.find((item) => item.name === 'archipel_login');
    const payload = JSON.parse(Buffer.from(pending.value.split('.')[1], 'base64url').toString());
    assert.equal(payload.returnTo, '/');
  });

  test('without a session, the API answers 401 and the shell sends to login', async () => {
    assert.equal((await platform.app.inject({ url: '/api/me' })).statusCode, 401);
    const shell = await platform.app.inject({ url: '/' });
    assert.equal(shell.headers.location, '/login');
  });
});

test('the sign-in page names the provider, without injection or external redirect', async () => {
  const platform = await startPlatform({
    ARCHIPEL_AUTH: 'oidc',
    OIDC_ISSUER: 'http://127.0.0.1:1',
    OIDC_CLIENT_ID: 'archipel',
    OIDC_PROVIDER_NAME: 'Entra <b>ID</b>',
  });
  const page = await platform.app.inject({ url: '/login?returnTo=/%23/review' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Continue with Entra &#60;b&#62;ID&#60;\/b&#62;/);
  assert.match(page.body, /href="\/auth\/login\?returnTo=%2F%23%2Freview"/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);

  const external = await platform.app.inject({ url: '/login?returnTo=https://evil.example' });
  assert.match(external.body, /href="\/auth\/login\?returnTo=%2F"/);
  await platform.stop();
});

test('startup refuses dev mode outside local', () => {
  assert.throws(
    () => loadConfig({ ARCHIPEL_AUTH: 'dev', HOST: '0.0.0.0', ARCHIPEL_DATA_DIR: '/tmp/archipel-cfg' }),
    /reserved for a local listener/,
  );
});
