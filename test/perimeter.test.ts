import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../packages/server/src/config/config.js';
import { sampleCopy, startPlatform } from './helpers.js';
import { startIdp } from './idp.js';

const PUBLIC = 'https://archipel.example';
const ADMIN = { sub: 'u1', name: 'Sam', email: null, groups: [], admin: true };

describe('origin of mutations', () => {
  let platform;
  let cookies;
  const HOST = 'archipel.example';
  before(async () => {
    platform = await startPlatform({ ARCHIPEL_PUBLIC_URL: PUBLIC });
    cookies = { '__Host-archipel_session': (await platform.sessions.open(ADMIN)).token };
  });
  after(() => platform.stop());

  const mutate = (headers) =>
    platform.app.inject({
      method: 'POST',
      url: '/api/agent-tokens',
      cookies,
      headers: { host: HOST, ...headers },
      payload: { name: 'ci' },
    });

  test('a cookie without proof of origin is refused', async () => {
    assert.equal((await mutate({})).statusCode, 403);
  });

  test('the public address is the only accepted origin', async () => {
    assert.equal((await mutate({ origin: PUBLIC })).statusCode, 201);
    assert.equal((await mutate({ origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await mutate({ origin: 'null' })).statusCode, 403);
  });

  test('the origin is not compared with Host', async () => {
    const response = await mutate({ origin: 'http://localhost:9999', host: 'localhost:8080' });
    assert.equal(response.statusCode, 403);
  });

  test('Sec-Fetch-Site is enough if Origin is missing', async () => {
    assert.equal((await mutate({ 'sec-fetch-site': 'same-origin' })).statusCode, 201);
    assert.equal((await mutate({ 'sec-fetch-site': 'same-site' })).statusCode, 403);
    assert.equal((await mutate({ 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  });

  test('an encoded path does not get around the rule', async () => {
    const response = await platform.app.inject({
      method: 'POST',
      url: '/%61pi/agent-tokens',
      cookies,
      headers: { host: HOST },
      payload: { name: 'ci' },
    });
    assert.equal(response.statusCode, 403);
  });

  test('signing out too', async () => {
    const response = await platform.app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies,
      headers: { host: HOST, authorization: 'Bearer x' },
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('host', () => {
  test('an unknown Host is refused, which closes DNS rebinding', async () => {
    const platform = await startPlatform({ ARCHIPEL_PUBLIC_URL: PUBLIC });
    const host = async (value, url = '/login') => (await platform.app.inject({ url, headers: { host: value } })).statusCode;
    assert.equal(await host('evil.example'), 421);
    assert.equal(await host('archipel.example'), 200);
    assert.equal(await host('localhost:3000'), 200);
    assert.equal(await host('10.1.2.3:3000', '/health'), 200);
    await platform.stop();
  });

  test('without a known public address, setup stays possible from the local network', async () => {
    const platform = await startPlatform({ ARCHIPEL_AUTH: '', HOST: '0.0.0.0' }, { fresh: true });
    const { app, config } = platform;
    assert.equal((await app.inject({ url: '/setup', headers: { host: '192.168.1.10:3000' } })).statusCode, 200);
    const unlock = (origin) =>
      app.inject({
        method: 'POST',
        url: '/api/setup/unlock',
        headers: { host: '192.168.1.10:3000', origin },
        payload: { code: 'AAAAA-AAAAA-AAAAA' },
      });
    assert.equal((await unlock('http://192.168.1.10:3000')).statusCode, 403);
    assert.match((await unlock('http://192.168.1.10:3000')).json().error, /code/i);
    assert.match((await unlock('http://evil.example')).json().error, /Origin/);
    assert.equal(config.publicUrl, 'http://0.0.0.0:3000');
    await platform.stop();
  });
});

describe('proxy', () => {
  test('X-Forwarded-For is only read if the proxy is declared', async (t) => {
    const platform = await startPlatform();
    t.after(() => platform.stop());
    await platform.app.inject({ method: 'POST', url: '/auth/logout', headers: { 'x-forwarded-for': '203.0.113.7' } });
    await platform.store.auditSettled();
    const [row] = await platform.db('platform_audit').where({ action: 'access.denied' });
    assert.notEqual(row.ip, '203.0.113.7');
  });

  test('the client address and the host come from the declared proxy', async (t) => {
    const platform = await startPlatform({ ARCHIPEL_PUBLIC_URL: PUBLIC, ARCHIPEL_TRUST_PROXY: '127.0.0.1' });
    t.after(() => platform.stop());
    const forwarded = { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-host': 'archipel.example', 'x-forwarded-proto': 'https' };
    const response = await platform.app.inject({ url: '/api/sessions', headers: { ...forwarded, host: 'archipel:3000' } });
    assert.equal(response.statusCode, 401);
    const denied = await platform.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...forwarded, host: 'archipel:3000' },
    });
    assert.equal(denied.statusCode, 403);
    await platform.store.auditSettled();
    const [row] = await platform.db('platform_audit').where({ action: 'access.denied' });
    assert.equal(row.ip, '203.0.113.7');
  });

  test('trusting any proxy is refused', () => {
    for (const value of ['true', '1']) {
      assert.throws(
        () => loadConfig({ ARCHIPEL_AUTH: 'dev', ARCHIPEL_TRUST_PROXY: value }, { allowProcessSandbox: true }),
        /ARCHIPEL_TRUST_PROXY/,
      );
    }
  });
});

describe('headers', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
    await platform.api.submit(sampleCopy('customers'));
  });
  after(() => platform.stop());

  test('the shell and the API are locked down', async () => {
    for (const url of ['/login', '/api/me', '/ui/app.js', '/absent/page/unknown']) {
      const { headers } = await platform.api.get(url);
      assert.equal(headers['x-content-type-options'], 'nosniff', url);
      assert.equal(headers['cross-origin-opener-policy'], 'same-origin', url);
      assert.equal(headers['cross-origin-resource-policy'], 'same-origin', url);
      assert.match(headers['permissions-policy'], /camera=\(\)/, url);
      assert.match(headers['x-request-id'], /^[0-9a-f-]{36}$/, url);
      assert.equal(headers['strict-transport-security'], undefined, url);
    }
  });

  test('a sandboxed frontend keeps loading in an opaque origin', async () => {
    const [release] = (await platform.api.get('/api/releases?view=queue')).json().releases;
    const { headers } = await platform.api.get(`/preview/${release.id}/`);
    assert.match(headers['content-security-policy'], /^sandbox/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cross-origin-opener-policy'], undefined);
    assert.equal(headers['cross-origin-resource-policy'], undefined);
  });

  test('HSTS only over https', async () => {
    const secure = await startPlatform({ ARCHIPEL_PUBLIC_URL: PUBLIC });
    const { headers } = await secure.app.inject({ url: '/login' });
    assert.match(headers['strict-transport-security'], /max-age=31536000/);
    await secure.stop();
  });
});

describe('limited agent tokens', () => {
  let platform;
  let api;
  before(async () => {
    platform = await startPlatform();
    api = platform.api;
  });
  after(() => platform.stop());

  const issue = async (body) => (await api.post('/api/agent-tokens', { name: 'ci', ...body })).json();
  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  test('a token only submits for its apps', async () => {
    const { token } = await issue({ apps: ['customers'] });
    assert.equal((await api.submit(sampleCopy('customers'), bearer(token))).status, 'in_review');

    const refused = await api.submit(sampleCopy('tickets'), bearer(token));
    assert.equal(refused.status, 'failed');
    const error = refused.report.validation.errors.find((item) => item.path === 'id');
    assert.match(error.hint, /customers/);
    assert.equal(await platform.store.getApp('tickets'), undefined);
  });

  test('it only reads their schema', async () => {
    const { token } = await issue({ apps: ['customers'] });
    const schema = (id) => platform.app.inject({ url: `/api/apps/${id}/schema`, headers: bearer(token) });
    assert.equal((await schema('customers')).statusCode, 200);
    assert.equal((await schema('tickets')).statusCode, 403);
  });

  test('without a list, the token stays on all apps, and this shows', async () => {
    const { id, token, apps } = await issue({});
    assert.equal(apps, null);
    assert.equal((await platform.app.inject({ url: '/api/apps/tickets/schema', headers: bearer(token) })).statusCode, 200);
    const row = (await api.get('/api/agent-tokens')).json().tokens.find((item) => item.id === id);
    assert.equal(row.apps, null);
  });

  test('an invalid list is refused', async () => {
    assert.equal((await api.post('/api/agent-tokens', { name: 'ci', apps: ['Not Valid'] })).statusCode, 400);
  });

  test('the last use is tracked', async () => {
    const { id, token } = await issue({});
    const seen = async () => (await api.get('/api/agent-tokens')).json().tokens.find((item) => item.id === id).last_used_at;
    assert.equal(await seen(), null);
    await platform.app.inject({ url: '/api/releases', headers: bearer(token) });
    assert.ok(await seen());
  });
});

describe('audit', () => {
  let idp;
  let platform;
  before(async () => {
    idp = await startIdp();
    platform = await startPlatform();
  });
  after(async () => {
    await platform.stop();
    idp.close();
  });

  const entries = (action) => platform.db('platform_audit').where({ action }).orderBy('id', 'desc');

  test('the author comes from the verified identity', async () => {
    await platform.api.post('/api/agent-tokens', { name: 'by-a-person' });
    const [row] = await entries('agent_token.create');
    assert.equal(row.actor_type, 'user');
    assert.equal(row.actor_id, 'dev');
    assert.ok(row.ip);
    assert.match(row.request_id, /^[0-9a-f-]{36}$/);
  });

  test('an agent is identified by its token, not by its name', async () => {
    const { id, token } = (await platform.api.post('/api/agent-tokens', { name: 'ci' })).json();
    await platform.api.submit(sampleCopy('customers'), { authorization: `Bearer ${token}` });
    const [row] = await entries('release.submit');
    assert.equal(row.actor_type, 'agent');
    assert.equal(row.actor_id, id);
  });

  test('refusals are logged', async () => {
    const { token } = (await platform.api.post('/api/agent-tokens', { name: 'ci' })).json();
    await platform.app.inject({ url: '/api/settings', headers: { authorization: `Bearer ${token}` } });
    await platform.app.inject({ url: '/api/releases', headers: { authorization: 'Bearer arc_faux' } });
    await platform.app.inject({ method: 'POST', url: '/api/alerts/1/ack' });
    await platform.store.auditSettled();
    const rows = await entries('access.denied');
    const details = rows.map((row) => JSON.parse(row.detail));
    assert.ok(details.some((item) => item.route === '/api/settings' && item.status === 403));
    assert.ok(details.some((item) => item.route === '/api/releases' && item.status === 401));
    assert.ok(details.some((item) => item.method === 'POST' && item.status === 403));
    assert.equal(
      rows.some((row) => JSON.stringify(row).includes('arc_faux')),
      false,
    );
  });

  test('closing waits for lines being written', async () => {
    const closing = await startPlatform();
    const written = closing.store.audit('Sam', 'test.closing');
    await closing.stop();
    await written;
  });

  test('a successful or refused sign-in is logged', async () => {
    const oidc = await startPlatform({
      ARCHIPEL_AUTH: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'archipel',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOW_HTTP: '1',
    });
    const start = await oidc.app.inject({ url: '/auth/login' });
    const cookies = { archipel_login: start.cookies.find((item) => item.name === 'archipel_login').value };
    const redirect = await fetch(new URL(start.headers.location), { redirect: 'manual' });
    const callback = new URL(redirect.headers.get('location'));

    const forged = await oidc.app.inject({ url: `/auth/callback?code=x&state=forged&iss=${idp.issuer}`, cookies });
    assert.equal(forged.statusCode, 401);
    assert.equal(
      forged.cookies.find((item) => item.name === 'archipel_session'),
      undefined,
    );
    const [failure] = await oidc.db('platform_audit').where({ action: 'auth.failure' });
    assert.ok(failure.detail);

    await oidc.app.inject({ url: callback.pathname + callback.search, cookies });
    const [login] = await oidc.db('platform_audit').where({ action: 'auth.login' });
    assert.equal(login.actor_id, 'user-1');
    await oidc.stop();
  });

  describe('hash chain', () => {
    let chained;
    const audit = (index) => chained.store.audit('x', `test.${index}`, { detail: { index } });
    before(async () => {
      chained = await startPlatform();
    });
    after(() => chained.stop());

    test('simultaneous writes keep a valid chain', async () => {
      await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(audit));
      const result = await chained.store.verifyAudit();
      assert.equal(result.broken, null);
      assert.ok(result.entries >= 8);
    });

    test('a modified line shows', async () => {
      const [target] = await chained.db('platform_audit').where({ action: 'test.3' });
      await chained.db('platform_audit').where({ id: target.id }).update({ actor: 'someone-else' });
      assert.equal((await chained.store.verifyAudit()).broken, target.id);
      await chained.db('platform_audit').where({ id: target.id }).update({ actor: 'x' });
      assert.equal((await chained.store.verifyAudit()).broken, null);
    });

    test('a removed line shows', async () => {
      const [target] = await chained.db('platform_audit').where({ action: 'test.4' });
      await chained.db('platform_audit').where({ id: target.id }).del();
      assert.ok((await chained.store.verifyAudit()).broken > target.id);
      await chained.db('platform_audit').insert(target);
      assert.equal((await chained.store.verifyAudit()).broken, null);
    });

    test('recomputing a hash without the secret does not fool anyone', async () => {
      const [target] = await chained.db('platform_audit').where({ action: 'test.5' });
      const hash = target.hash;
      await chained
        .db('platform_audit')
        .where({ id: target.id })
        .update({ hash: `${hash.split('.')[0]}.${'A'.repeat(43)}` });
      assert.equal((await chained.store.verifyAudit()).broken, target.id);
      await chained.db('platform_audit').where({ id: target.id }).update({ hash });
    });

    test('lines from before the chain are counted separately', async () => {
      await chained.db('platform_audit').insert({ at: new Date().toISOString(), actor: 'legacy', action: 'old', hash: null });
      const result = await chained.store.verifyAudit();
      assert.equal(result.broken, null);
      assert.equal(result.unchained, 1);
    });
  });
});
