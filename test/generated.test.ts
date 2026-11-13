import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appOpenApi as describeApp,
  generateTypes,
  parseManifest,
  rowSchema,
  type Column,
  type Manifest,
  type Table,
} from '@archipel/manifest-schema';
import ts from 'typescript';
import { issueAgentToken } from '../packages/server/src/auth/agent-tokens.js';
import { installLive, sampleCopy, startPlatform } from './helpers.js';

const CLI = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const sample = (name: string) => fileURLToPath(new URL(`../samples/${name}`, import.meta.url));
const manifestOf = (name: string) =>
  parseManifest(readFileSync(join(sample(name), 'app.manifest.yaml'), 'utf8')).manifest as Manifest;
// The tests look deep into the generated document, whose paths are typed loosely.
const appOpenApi = (...args: Parameters<typeof describeApp>): any => describeApp(...args);

const base = { manifest: 1, id: 'demo', name: 'Demo', version: '1.0.0' } as const;
const columns: Record<string, Column> = {
  id: { type: 'uuid', pk: true },
  title: { type: 'string', required: true },
  status: { type: 'enum', values: ['open', 'done'], default: 'open' },
  size: { type: 'integer' },
  done: { type: 'boolean', required: true, default: false },
  data: { type: 'json' },
};
const manifest: Manifest = { ...base, tables: { ticket: { columns, crud: true }, 'shared.big_item': { columns, crud: true } } };

function diagnostics(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-types-'));
  const file = join(dir, 'check.ts');
  writeFileSync(file, source);
  const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, types: [] });
  const found = ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
  rmSync(dir, { recursive: true, force: true });
  return found;
}

describe('generated types', () => {
  test('the types follow the columns', () => {
    const source = generateTypes(manifest);
    assert.match(source, /export interface Ticket \{/);
    assert.match(source, /status: "open" \| "done" \| null;/);
    assert.match(source, /export interface TicketInsert \{\n {2}id\?: string;\n {2}title: string;/);
    assert.match(source, /export interface SharedBigItem \{/);
    assert.match(source, /"shared\.big_item": \{ row: SharedBigItem;/);
  });

  test('the file compiles and refuses an incorrect row', () => {
    const source = generateTypes(manifest);
    assert.deepEqual(diagnostics(source), []);
    assert.deepEqual(diagnostics(`${source}\nconst ok: TicketInsert = { title: 'x' };\nexport { ok };`), []);
    assert.equal(diagnostics(`${source}\nconst bad: TicketInsert = {};\nexport { bad };`).length, 1);
    assert.equal(diagnostics(`${source}\nconst bad: TicketInsert = { title: 'x', status: 'nope' };\nexport { bad };`).length, 1);
  });

  test('an enum value cannot inject code', () => {
    const values = ['a"; export const pwned = 1; //', 'b'];
    const source = generateTypes({
      ...base,
      tables: { t: { columns: { id: { type: 'uuid', pk: true }, v: { type: 'enum', values } } } },
    });
    assert.deepEqual(diagnostics(source), []);
    assert.equal(diagnostics(`${source}\nimport { pwned } from './check';`).length > 0, true);
  });

  test('a table from another app stays a dictionary', () => {
    const source = generateTypes(manifestOf('tickets'));
    assert.match(source, /"shared\.customer": \{ row: Record<string, unknown>/);
    assert.deepEqual(diagnostics(source), []);
  });
});

describe("an app's contract", () => {
  test('describes the CRUD and the controllers, with a single row definition', () => {
    const document = appOpenApi(manifestOf('tickets'));
    assert.equal(document.servers[0].url, '/run/tickets');
    const collection = document.paths['/data/ticket'];
    assert.ok(collection.get && collection.post);
    assert.deepEqual(
      collection.post.requestBody.content['application/json'].schema,
      rowSchema(manifestOf('tickets').tables.ticket),
    );
    const item = document.paths['/data/ticket/{id}'];
    assert.ok(item.get && item.patch && item.delete);
    assert.equal(document.paths['/tickets/{id}/close'].post.operationId, 'close_ticket');
    assert.deepEqual(document.paths['/tickets/{id}/close'].post['x-archipel-needs'], ['ticket.write']);
    assert.equal(document.paths['/data/shared.customer'].post, undefined);
    assert.ok(document.paths['/data/shared.customer'].get);
  });

  test('a table without crud does not appear', () => {
    const document = appOpenApi({ ...base, tables: { secret: { columns: { id: { type: 'uuid', pk: true } } } } });
    assert.equal(document.paths['/data/secret'], undefined);
  });

  test('on the server side, a shared table is described', () => {
    const shared: Table = { columns: { id: { type: 'uuid', pk: true }, name: { type: 'string' } }, crud: true };
    const document = appOpenApi({ ...base, permissions: { writes: ['shared.customer'] } }, { sharedTable: () => shared });
    const list = document.paths['/data/shared.customer'];
    assert.ok(list.post);
    assert.ok(list.get.responses[200].content['application/json'].schema.items.properties.name);
  });
});

describe('on the platform', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
    await installLive(platform, sampleCopy('customers'));
    await installLive(platform, sampleCopy('tickets'));
  });
  after(() => platform.stop());

  test('GET /api/apps/:id/openapi.json follows the live app', async () => {
    const document = (await platform.api.get('/api/apps/tickets/openapi.json')).json();
    assert.equal(document.info.version, '1.0.0');
    const schema = document.paths['/data/shared.customer'].get.responses[200].content['application/json'].schema;
    assert.ok(schema.items.properties.id);
    assert.equal((await platform.api.get('/api/apps/nope-nope/openapi.json')).statusCode, 404);
  });

  test('an agent limited to another app has no access', async () => {
    const { token } = await issueAgentToken(platform.store, { name: 'x', apps: ['customers'] });
    const call = (id) =>
      platform.app.inject({ url: `/api/apps/${id}/openapi.json`, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await call('customers')).statusCode, 200);
    assert.equal((await call('tickets')).statusCode, 403);
    assert.equal((await platform.app.inject({ url: '/api/apps/tickets/openapi.json' })).statusCode, 401);
  });

  test('a CRUD error gives the path, the received and the expected value', async () => {
    const token = await platform.api.appToken('/tickets/');
    const response = await platform.app.inject({
      method: 'POST',
      url: '/run/tickets/data/ticket',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'x', statu: 'open' },
    });
    assert.equal(response.statusCode, 400);
    const { details, issues } = response.json();
    assert.deepEqual(details, ['Unknown field: statu']);
    assert.equal(issues[0].path, 'body.statu');
    assert.match(issues[0].hint, /Did you mean "status"/);
  });
});

describe('CLI', () => {
  const run = (...args: string[]) =>
    new Promise<{ code: number; json: any }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], (error, stdout) =>
        resolve({ code: error ? Number(error.code) : 0, json: JSON.parse(stdout) }),
      );
    });

  test('types writes a file that compiles', async () => {
    const folder = sampleCopy('tickets');
    const { code, json } = await run('types', folder);
    assert.equal(code, 0);
    assert.equal(json.file, join(folder, 'app.types.d.ts'));
    assert.deepEqual(json.tables, ['ticket']);
    assert.deepEqual(diagnostics(readFileSync(json.file, 'utf8')), []);
  });

  test('types and openapi refuse an invalid manifest, without writing anything', async () => {
    const folder = sampleCopy('tickets', { 'app.manifest.yaml': (text: string) => text.replace('manifest: 1', 'manifest: 2') });
    const types = await run('types', folder, '--out', 'x.d.ts');
    assert.deepEqual([types.code, types.json.written], [1, false]);
    assert.equal((await run('openapi', folder)).code, 1);
  });

  test('openapi returns the contract without a server', async () => {
    const { code, json } = await run('openapi', sample('tickets'));
    assert.equal(code, 0);
    assert.ok(json.paths['/data/ticket']);
  });
});
