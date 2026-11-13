import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateTypes, parseManifest, validateManifest, type Manifest } from '@archipel/manifest-schema';
import ts from 'typescript';
import { bareApp, installLive, sampleCopy, startPlatform } from './helpers.js';

const CLI = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const SDK = fileURLToPath(new URL('../packages/sdk/index.d.ts', import.meta.url));
const TICKETS = fileURLToPath(new URL('../samples/tickets', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../samples', import.meta.url));

const manifestText = readFileSync(join(TICKETS, 'app.manifest.yaml'), 'utf8');
const ticketTypes = generateTypes(parseManifest(manifestText).manifest as Manifest);

// Compiles a controller against the real SDK and the generated types of `tickets`.
function compile(controller) {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-sdk-'));
  writeFileSync(join(dir, 'app.types.d.ts'), ticketTypes);
  const file = join(dir, 'controller.ts');
  writeFileSync(
    file,
    `import type { Controller } from '@archipel/sdk';\nimport type { Tables } from './app.types';\n${controller}`,
  );
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { '@archipel/sdk': [SDK] },
  });
  const found = ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
  rmSync(dir, { recursive: true, force: true });
  return found;
}

const controller = (body) => `const c: Controller<Tables, { id: string }> = async (ctx) => {\n${body}\n};\nexport default c;`;

function membersOf(name: string) {
  const source = ts.createSourceFile('index.d.ts', readFileSync(SDK, 'utf8'), ts.ScriptTarget.ES2023);
  const declaration = source.statements.find(
    (item): item is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(item) && item.name.text === name,
  );
  if (!declaration) throw new Error(`No interface ${name} in the SDK`);
  return declaration.members.map((member) => (member.name as ts.Identifier).text).sort();
}

describe('SDK: types', () => {
  test('a correct controller compiles', () => {
    assert.deepEqual(
      compile(
        controller(`
      const ticket = await ctx.db.table('ticket').get(ctx.params.id);
      if (!ticket) throw ctx.error(404, 'Ticket not found');
      ctx.log.info(ticket.title, ctx.user.roles);
      await ctx.db.table('ticket').insert({ title: 'x' });
      await ctx.db.table('shared.customer').list({ limit: 1 });
      const response = await ctx.fetch('https://api.example.com');
      return { title: ticket.title, ok: response.ok };
    `),
      ),
      [],
    );
  });

  test('an unknown table, column or value is refused', () => {
    assert.equal(compile(controller(`await ctx.db.table('nope').list();`)).length, 1);
    assert.equal(compile(controller(`await ctx.db.table('ticket').insert({});`)).length, 1);
    assert.equal(compile(controller(`await ctx.db.table('ticket').update('1', { status: 'nope' });`)).length, 1);
    assert.equal(compile(controller(`await ctx.db.table('ticket').list({ where: { nope: 'x' } });`)).length, 1);
    assert.equal(compile(controller(`const t = await ctx.db.table('ticket').get('1'); return t.title;`)).length, 1);
    assert.equal(compile(controller(`return ctx.params.nope;`)).length, 1);
  });

  test('without generated types, the SDK stays usable', () => {
    const source = `const c: Controller = async (ctx) => (await ctx.db.table('free').get('1'))?.column;\nexport default c;`;
    assert.deepEqual(
      compile(source).filter((message) => !message.includes('Tables')),
      [],
    );
  });
});

describe('SDK: contract with the sandbox', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
  });
  after(() => platform.stop());

  test('ctx has exactly the members declared by the SDK', async () => {
    const manifest = `manifest: 1
id: probe
name: Probe
version: 1.0.0
frontend: { dir: ./web, route: /probe }
tables:
  item:
    columns: { id: { type: uuid, pk: true } }
controllers:
  - { path: GET /probe, handler: ./probe.js }
`;
    const probe = `export default async (ctx) => ({
      context: Object.keys(ctx).sort(),
      log: Object.keys(ctx.log).sort(),
      database: Object.keys(ctx.db).sort(),
      table: Object.keys(ctx.db.table('item')).sort(),
      user: Object.keys(ctx.user).sort(),
    });`;
    await installLive(platform, bareApp(manifest, { 'probe.js': probe }));
    const { status, body } = await platform.registry.dispatch(platform.registry.get('probe'), {
      method: 'GET',
      path: '/probe',
      user: { sub: 's', name: 'Probe', roles: ['admin'] },
    });
    assert.equal(status, 200);
    assert.deepEqual(body.context, membersOf('Context'));
    assert.deepEqual(body.log, membersOf('Log'));
    assert.deepEqual(body.database, membersOf('Database'));
    assert.deepEqual(body.table, membersOf('TableClient'));
    assert.deepEqual(body.user, membersOf('User'));
  });

  test('the tickets sample runs with its compiled JavaScript, without scan warnings', async () => {
    await installLive(platform, sampleCopy('customers'));
    const release = await installLive(platform, sampleCopy('tickets'));
    const findings = release.report.scan?.findings ?? [];
    assert.equal(
      findings.some((finding) => finding.id === 'deps.import'),
      false,
    );
  });
});

describe('SDK: validate', () => {
  const run = (...args: string[]) =>
    new Promise<{ code: number; json: any }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], (error, stdout) =>
        resolve({ code: error ? Number(error.code) : 0, json: JSON.parse(stdout) }),
      );
    });

  // In the repository: typescript and @archipel/sdk resolve there, as in an app that installed them.
  function localCopy(t) {
    const parent = mkdtempSync(join(SAMPLES, '.tmp-'));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, 'tickets');
    cpSync(TICKETS, dir, { recursive: true });
    return dir;
  }

  test('the sample passes, types included', async () => {
    const { code, json } = await run('validate', TICKETS);
    assert.deepEqual([code, json.errors, json.warnings], [0, [], []]);
  });

  test('a type error blocks and gives its location', async (t) => {
    const dir = localCopy(t);
    const file = join(dir, 'src/close.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("{ status: 'done' }", "{ status: 'fini' }"));
    const { code, json } = await run('validate', dir);
    assert.equal(code, 1);
    assert.match(json.errors[0].path, /^src\/close\.ts:\d+:\d+$/);
    assert.match(json.errors[0].hint, /TS\d+/);
  });

  test('deploy sends nothing on a type error', async (t) => {
    const dir = localCopy(t);
    writeFileSync(join(dir, 'src/health.ts'), 'const x: number = "a"; export default x;');
    const result = await new Promise<{ code: unknown; json: any }>((resolve) => {
      execFile(
        process.execPath,
        [CLI, 'deploy', dir],
        { env: { ...process.env, ARCHIPEL_URL: 'http://127.0.0.1:9', ARCHIPEL_TOKEN: 'x' } },
        (error, stdout) => resolve({ code: error?.code, json: JSON.parse(stdout) }),
      );
    });
    assert.deepEqual([result.code, result.json.status], [1, 'invalid']);
  });

  test('types behind the manifest are reported', async (t) => {
    const dir = localCopy(t);
    const file = join(dir, 'app.manifest.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'title: { type: string, required: true }',
        'title: { type: string, required: true }\n      note: { type: string }',
      ),
    );
    const { code, json } = await run('validate', dir);
    assert.equal(code, 0);
    assert.match(json.warnings[0].message, /behind the manifest/);
  });

  test('without TypeScript installed, validate says so without blocking', async () => {
    const { code, json } = await run('validate', sampleCopy('tickets'));
    assert.equal(code, 0);
    assert.match(json.warnings[0].message, /TypeScript not found/);
  });

  test('an app without tsconfig is not concerned', async () => {
    const { code, json } = await run('validate', join(SAMPLES, 'customers'));
    assert.deepEqual([code, json.warnings], [0, []]);
  });

  test('a real SDK import is refused, a type comment is not', () => {
    const manifest = {
      manifest: 1,
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      controllers: [{ path: 'GET /x', handler: './h.js' }],
    };
    const check = (source) => {
      const dir = mkdtempSync(join(tmpdir(), 'archipel-handler-'));
      writeFileSync(join(dir, 'h.js'), source);
      const { errors } = validateManifest(manifest, dir);
      rmSync(dir, { recursive: true, force: true });
      return errors;
    };
    assert.match(check(`import { x } from '@archipel/sdk';\nexport default x;`)[0].hint, /import type/);
    assert.match(check(`import '@archipel/sdk';\nexport default () => 1;`)[0].message, /SDK/);
    assert.deepEqual(check(`/** @param {import('@archipel/sdk').Context} ctx */\nexport default async (ctx) => ctx.user;`), []);
  });

  test("the committed JavaScript follows the sample's TypeScript", () => {
    for (const name of ['close', 'health']) {
      const { outputText } = ts.transpileModule(readFileSync(join(TICKETS, `src/${name}.ts`), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      });
      assert.equal(readFileSync(join(TICKETS, `api/${name}.js`), 'utf8'), outputText);
    }
  });
});
