import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manifestSchema, parseManifest, validateManifest } from '@archipel/manifest-schema';

const root = fileURLToPath(new URL('../samples/tickets', import.meta.url));
const base = { manifest: 1, id: 'demo', name: 'Demo', version: '1.0.0' };

const validate = (manifest: object, context?: Parameters<typeof validateManifest>[2]): any[] =>
  validateManifest(manifest, root, context).errors;

test('a minimal manifest is valid', () => {
  assert.deepEqual(validate({ ...base, tables: { a: { columns: { id: { type: 'uuid', pk: true } } } } }), []);
});

test('each error says where and how to fix it', () => {
  const [error] = validate({ manifest: 1, id: 'demo', version: '1.0.0' });
  assert.equal(error.message, 'Missing field "name"');
  assert.ok(error.hint.includes('name'));
});

test('refuses an unknown field', () => {
  const errors = validate({ ...base, nmae: 'x' });
  assert.match(errors[0].message, /Unknown field "nmae"/);
});

test('refuses reserved routes and those taken by another app', () => {
  const frontend = (route) => ({ ...base, frontend: { dir: './web', route } });
  assert.match(validate(frontend('/api'))[0].message, /reserved/);
  assert.match(validate(frontend('/x'), { routes: { '/x': 'other' } })[0].message, /already used/);
  assert.deepEqual(validate(frontend('/x'), { routes: { '/x': 'demo' } }), []);
});

test('refuses a path that leaves the app', () => {
  const errors = validate({ ...base, controllers: [{ path: 'GET /x', handler: '../../etc/passwd' }] });
  assert.match(errors[0].message, /outside the app folder/);
});

test('requires a single pk', () => {
  const errors = validate({ ...base, tables: { a: { columns: { name: { type: 'string' } } } } });
  assert.match(errors[0].message, /exactly one pk column/);
});

test('a shared reference must be declared in the permissions', () => {
  const tables = {
    a: { columns: { id: { type: 'uuid', pk: true }, c: { type: 'ref', to: 'shared.customer' } } },
  };
  assert.match(validate({ ...base, tables })[0].message, /not declared in permissions/);
  assert.deepEqual(validate({ ...base, tables, permissions: { reads: ['shared.customer'] } }), []);
});

test('needs, health, exposes and MCP tools must point to declared items', () => {
  assert.match(
    validate({ ...base, controllers: [{ path: 'GET /x', handler: './api/health.js', needs: ['nope.read'] }] })[0].message,
    /Unknown table "nope"/,
  );
  assert.match(validate({ ...base, health: '/h' })[0].message, /No "GET \/h" controller/);
  assert.match(validate({ ...base, exposes: { data: ['nope'] } })[0].message, /Unknown exposed data/);
  assert.match(
    validate({ ...base, exposes: { mcp: [{ name: 'x', description: 'y', calls: 'POST /nope' }] } })[0].message,
    /No "POST \/nope" controller/,
  );
});

test('an error gives the exact path, the received value and the expected value', () => {
  const [missing] = validate({ ...base, frontend: { dir: './web' } });
  assert.equal(missing.path, 'frontend.route');

  const [badEnum] = validate({ ...base, tables: { a: { columns: { id: { type: 'uuidd', pk: true } } } } });
  assert.equal(badEnum.path, 'tables.a.columns.id.type');
  assert.equal(badEnum.received, 'uuidd');
  assert.ok(badEnum.expected.includes('uuid'));

  const [badType] = validate({ ...base, name: 12 });
  assert.deepEqual([badType.path, badType.received, badType.expected], ['name', 12, 'string']);

  const [badPattern] = validate({ ...base, id: 'Demo' });
  assert.deepEqual([badPattern.path, badPattern.received], ['id', 'Demo']);
  assert.match(badPattern.expected, /\^\[a-z\]/);
});

test('a misspelt field suggests the right name', () => {
  const [error] = validate({ ...base, helth: '/h' });
  assert.equal(error.path, 'helth');
  assert.match(error.hint, /Did you mean "health"/);
  assert.ok(error.expected.includes('health'));
  assert.doesNotMatch(validate({ ...base, zzzzzz: 1 })[0].hint, /Did you mean/);
});

test('an invalid table name is named, without a duplicate error', () => {
  const errors = validate({ ...base, tables: { 'Bad-Name': { columns: { id: { type: 'uuid', pk: true } } } } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'tables.Bad-Name');
  assert.equal(errors[0].received, 'Bad-Name');
});

test('a received value that is too long is truncated', () => {
  const [error] = validate({ ...base, id: 'X'.repeat(5000) });
  assert.ok(error.received.length < 300);
  assert.ok(error.received.endsWith('…'));
});

test('consistency errors also carry the received value', () => {
  const [route] = validate({ ...base, frontend: { dir: './web', route: '/api' } });
  assert.equal(route.received, '/api');
  const [health] = validate({ ...base, health: '/h' });
  assert.equal(health.received, '/h');
  const [handler] = validate({ ...base, controllers: [{ path: 'GET /x', handler: './absent.js' }] });
  assert.equal(handler.received, './absent.js');
});

test('the published JSON Schema follows the source', () => {
  const file = new URL('../packages/manifest-schema/app.manifest.schema.json', import.meta.url);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(JSON.stringify(manifestSchema)));
});

test('unreadable YAML produces a usable error', () => {
  const { errors } = parseManifest('a: [');
  assert.equal(errors[0].message, 'Unreadable YAML');
});
