import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { issueAgentToken } from '../packages/server/src/auth/agent-tokens.js';
import { installLive, sampleCopy, startPlatform } from './helpers.js';

describe('API contract', () => {
  let platform;
  let api;
  before(async () => {
    platform = await startPlatform();
    api = platform.api;
    await installLive(platform, sampleCopy('customers'));
  });
  after(() => platform.stop());

  const visitor = async () => {
    const { token } = await platform.sessions.open({ sub: 'u1', name: 'Sam', email: null, groups: [], admin: false });
    return { archipel_session: token };
  };

  test('an extra field gives its path and a fix', async () => {
    const response = await api.post('/api/agent-tokens', { nam: 'x' });
    assert.equal(response.statusCode, 400);
    const [issue] = response.json().issues;
    assert.equal(issue.path, 'body.nam');
    assert.match(issue.hint, /Did you mean "name"/);
    assert.ok(issue.expected.includes('name'));
  });

  test('an invalid value gives what was received and what is expected', async () => {
    const [type] = (await api.post('/api/agent-tokens', { name: 12 })).json().issues;
    assert.deepEqual([type.path, type.received, type.expected], ['body.name', 12, 'string']);

    const response = await api.post('/api/sessions/nope/revoke');
    assert.equal(response.statusCode, 400);
    const [pattern] = response.json().issues;
    assert.deepEqual([pattern.path, pattern.received], ['params.id', 'nope']);
  });

  test('an error does not copy a sensitive value', async () => {
    const response = await api.post('/api/settings/identity/test', { clientSecret: 123456789 });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().issues[0].path, 'body.clientSecret');
    assert.equal(response.body.includes('123456789'), false);
  });

  test('a JS route keeps the same error format', async () => {
    const response = await api.post('/api/releases/git', { url: 12 });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().issues[0].path, 'body.url');
  });

  test('a response only contains what its schema declares', async () => {
    await api.post('/api/agent-tokens', { name: 'ci' });
    const { tokens } = (await api.get('/api/agent-tokens')).json();
    assert.deepEqual(Object.keys(tokens[0]).sort(), [
      'apps',
      'created_at',
      'expires_at',
      'id',
      'last_used_at',
      'name',
      'revoked_at',
    ]);
  });

  test('a date read from the database comes out as ISO text, whatever the driver', async () => {
    const { id, token } = await issueAgentToken(platform.store, { name: 'dates' });
    await platform.app.inject({ url: '/api/releases', headers: { authorization: `Bearer ${token}` } });
    const row = (await api.get('/api/agent-tokens')).json().tokens.find((item) => item.id === id);
    assert.equal(Number.isNaN(Date.parse(row.last_used_at)), false);
    assert.equal(Number.isNaN(Date.parse(row.created_at)), false);
  });

  test('OpenAPI is reserved for administrators', async () => {
    assert.equal((await platform.app.inject({ url: '/api/openapi.json' })).statusCode, 401);
    assert.equal((await platform.app.inject({ url: '/api/openapi.json', cookies: await visitor() })).statusCode, 403);
    const { token } = await issueAgentToken(platform.store, { name: 'x' });
    const agent = await platform.app.inject({ url: '/api/openapi.json', headers: { authorization: `Bearer ${token}` } });
    assert.equal(agent.statusCode, 403);
  });

  test('OpenAPI describes the platform API, and only that', async () => {
    const document = (await api.get('/api/openapi.json')).json();
    assert.equal(document.openapi, '3.1.0');
    const paths = Object.keys(document.paths);
    assert.ok(paths.includes('/api/agent-tokens'));
    assert.ok(paths.includes('/api/apps'));
    assert.ok(paths.includes('/api/sessions/{id}/revoke'));
    assert.equal(
      paths.some((path) => !path.startsWith('/api/')),
      false,
    );
    assert.equal(paths.includes('/api/openapi.json'), false);

    const created = document.paths['/api/agent-tokens'].post;
    assert.ok(created.requestBody.content['application/json'].schema.properties.name);
    assert.ok(created.responses['201'].content['application/json'].schema.properties.token);
  });
});
