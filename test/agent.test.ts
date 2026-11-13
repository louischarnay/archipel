import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Parser } from 'tar';
import { issueAgentToken } from '../packages/server/src/auth/agent-tokens.js';
import { sampleCopy, startPlatform, type TestPlatform } from './helpers.js';

const CLI = fileURLToPath(new URL('../packages/cli/src/cli.ts', import.meta.url));
const TOKEN_COMMAND = fileURLToPath(new URL('../packages/server/src/scripts/token.ts', import.meta.url));
const SKILL_BUNDLE = fileURLToPath(new URL('../packages/cli/scripts/bundle.ts', import.meta.url));

const bump = (version: string) => ({
  'app.manifest.yaml': (text: string) => text.replace('version: 1.0.0', `version: ${version}`),
});

// Never the saved connection of the person running the tests.
const NO_SAVED_CONNECTION = mkdtempSync(join(tmpdir(), 'archipel-config-'));

// Runs the real command: the server runs in this process, so it must stay asynchronous.
interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function execute(file: string, args: string[], env: Record<string, string>, input?: string) {
  return new Promise<Run>((resolve) => {
    const { ARCHIPEL_URL, ARCHIPEL_TOKEN, ...clean } = process.env;
    const child = execFile(
      process.execPath,
      [file, ...args],
      { env: { ...clean, XDG_CONFIG_HOME: NO_SAVED_CONNECTION, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

async function cli(env: Record<string, string>, ...args: string[]) {
  const { code, stdout } = await execute(CLI, args, env);
  return { code, json: JSON.parse(stdout) as any };
}

function entriesOf(archive: Buffer) {
  return new Promise<string[]>((resolve, reject) => {
    const entries: string[] = [];
    const parser = new Parser({
      onReadEntry: (entry) => {
        entries.push(entry.path);
        entry.resume();
      },
    });
    parser.on('end', () => resolve(entries)).on('error', reject);
    parser.end(archive);
  });
}

describe('commands without a server', () => {
  test('validate accepts a correct app, offline', async () => {
    const { code, json } = await cli({}, 'validate', sampleCopy('tickets'));
    assert.equal(code, 0);
    assert.equal(json.valid, true);
  });

  test('validate returns actionable errors', async () => {
    const folder = sampleCopy('tickets', { 'app.manifest.yaml': (text) => text.replace('./api/close.js', './api/absent.js') });
    const { code, json } = await cli({}, 'validate', folder);
    assert.equal(code, 1);
    assert.equal(json.errors[0].path, 'controllers.1.handler');
    assert.ok(json.errors[0].hint);
  });

  test('validate reports a folder without a manifest', async () => {
    const { code, json } = await cli({}, 'validate', mkdtempSync(join(tmpdir(), 'archipel-empty-')));
    assert.equal(code, 2);
    assert.match(json.error, /app\.manifest\.yaml/);
  });

  test('deploy without a token explains how to get one', async () => {
    const { code, json } = await cli({}, 'deploy', sampleCopy('tickets'), '--preview');
    assert.equal(code, 2);
    assert.match(json.error, /ARCHIPEL_TOKEN/);
  });

  test('deploy sends nothing if the manifest is invalid', async () => {
    const folder = sampleCopy('tickets', { 'app.manifest.yaml': (text) => text.replace('manifest: 1', 'manifest: 2') });
    const { code, json } = await cli({ ARCHIPEL_URL: 'http://127.0.0.1:9', ARCHIPEL_TOKEN: 'x' }, 'deploy', folder);
    assert.equal(code, 1);
    assert.equal(json.status, 'invalid');
  });

  test('an unknown command shows the help', async () => {
    const { code, stdout } = await execute(CLI, ['approve', 'rel1'], {});
    assert.equal(code, 2);
    assert.match(stdout, /Usage/);
  });
});

describe('agent tokens', () => {
  test('the server command creates, lists and revokes a token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archipel-token-'));
    const env = { ARCHIPEL_DATA_DIR: dir };
    const created = JSON.parse((await execute(TOKEN_COMMAND, ['create', 'claude', '--days', '7'], env)).stdout);
    assert.match(created.token, /^arc_/);

    const listed = JSON.parse((await execute(TOKEN_COMMAND, ['list'], env)).stdout);
    assert.deepEqual(
      listed.map((row) => row.name),
      ['claude'],
    );
    assert.equal(JSON.stringify(listed).includes(created.token), false);

    assert.equal((await execute(TOKEN_COMMAND, ['revoke', created.id], env)).code, 0);
    assert.equal((await execute(TOKEN_COMMAND, ['revoke', created.id], env)).code, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('only the token hash is stored', async () => {
    const platform = await startPlatform();
    const { token } = await issueAgentToken(platform.store, { name: 'x' });
    const rows = await platform.db('platform_agent_tokens');
    assert.equal(JSON.stringify(rows).includes(token), false);
    await platform.stop();
  });
});

describe('agent against the platform', () => {
  let platform: TestPlatform;
  let api: TestPlatform['api'];
  let env: Record<string, string>;
  let agentToken: string;

  const asAgent = (
    method: string,
    url: string,
    { token = agentToken, headers = {}, payload }: { token?: string; headers?: Record<string, string>; payload?: object } = {},
  ) => platform.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, payload });

  before(async () => {
    platform = await startPlatform();
    api = platform.api;
    await platform.app.listen({ host: '127.0.0.1', port: 0 });
    const address = await platform.app.getUrl();
    agentToken = (await issueAgentToken(platform.store, { name: 'claude' })).token;
    env = { ARCHIPEL_URL: address, ARCHIPEL_TOKEN: agentToken };
  });
  after(() => platform.stop());

  async function deploy(name: string, edits?: Parameters<typeof sampleCopy>[1]) {
    const { code, json } = await cli(env, 'deploy', sampleCopy(name, edits), '--preview');
    assert.equal(json.status, 'in_review', JSON.stringify(json));
    assert.equal(code, 0);
    return json;
  }

  const approve = (id, body = { comment: 'ok' }) => api.post(`/api/releases/${id}/approve`, body);

  test('a person creates a token from the interface, and revokes it', async () => {
    const created = await api.post('/api/agent-tokens', { name: '  ci  ', days: 30 });
    assert.equal(created.statusCode, 201);
    const { id, name, token } = created.json();
    assert.equal(name, 'ci');
    assert.equal((await asAgent('GET', '/api/releases', { token })).statusCode, 200);

    const { tokens } = (await api.get('/api/agent-tokens')).json();
    assert.ok(tokens.some((row) => row.id === id && !row.revoked_at));
    assert.equal(JSON.stringify(tokens).includes(token), false);
    assert.equal(JSON.stringify(tokens).includes('hash'), false);

    assert.equal((await api.post(`/api/agent-tokens/${id}/revoke`)).statusCode, 200);
    assert.equal((await api.post(`/api/agent-tokens/${id}/revoke`)).statusCode, 404);
    assert.equal((await asAgent('GET', '/api/releases', { token })).statusCode, 401);

    const audit = platform.db('platform_audit').whereNot('action', 'access.denied').orderBy('id', 'desc').limit(2);
    const actions = (await audit).map((row) => row.action);
    assert.deepEqual(actions, ['agent_token.revoke', 'agent_token.create']);
  });

  test('a token requires a name and a reasonable duration, and cannot be issued from an app', async () => {
    assert.equal((await api.post('/api/agent-tokens', { name: '  ' })).statusCode, 400);
    assert.equal((await api.post('/api/agent-tokens', { name: 'x', days: 0 })).statusCode, 400);
    assert.equal((await api.post('/api/agent-tokens', { name: 'x', days: 4000 })).statusCode, 400);
    assert.equal((await api.post('/api/agent-tokens', { name: 'x' }, { origin: 'null' })).statusCode, 403);
  });

  test('login checks the token before saving it, and the next commands use it', async () => {
    const config = mkdtempSync(join(tmpdir(), 'archipel-login-'));
    const file = join(config, 'archipel', 'config.json');
    const home = { XDG_CONFIG_HOME: config };

    const refused = await execute(CLI, ['login', env.ARCHIPEL_URL], home, 'arc_faux\n');
    assert.equal(refused.code, 2);
    assert.equal(existsSync(file), false);

    const login = await execute(CLI, ['login', `${env.ARCHIPEL_URL}/ignored/path`], home, `${agentToken}\n`);
    assert.equal(login.code, 0, login.stdout);
    assert.equal(JSON.parse(login.stdout).agent, 'claude');
    assert.doesNotMatch(login.stdout, new RegExp(agentToken));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url: env.ARCHIPEL_URL, token: agentToken });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(config, 'archipel')).mode & 0o777, 0o700);

    const whoami = await cli(home, 'whoami');
    assert.equal(whoami.code, 0);
    assert.deepEqual([whoami.json.agent, whoami.json.apps, whoami.json.source], ['claude', 'all', file]);

    // The environment wins as a whole: the file's token is not sent to another address.
    const mixed = await cli({ ...home, ARCHIPEL_URL: 'http://127.0.0.1:9' }, 'whoami');
    assert.equal(mixed.code, 2);
    assert.match(mixed.json.error, /No connection/);

    assert.equal((await cli(home, 'logout')).code, 0);
    assert.equal(existsSync(file), false);
    assert.equal((await cli(home, 'whoami')).code, 2);
  });

  test('the agent identity is only readable with its token', async () => {
    const response = await asAgent('GET', '/api/agent/me');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.json()).sort(), ['apps', 'id', 'name']);
    assert.equal(response.json().name, 'claude');
    assert.equal((await api.get('/api/agent/me')).statusCode, 403);
  });

  test('the skill downloads without a session, with its instructions and the CLI', async () => {
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [SKILL_BUNDLE], (error) => (error ? reject(error) : resolve()));
    });
    const response = await platform.app.inject({ url: '/agent/skill.tar.gz' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/gzip');
    const entries = await entriesOf(response.rawPayload);
    for (const file of ['archipel/SKILL.md', 'archipel/references/review.md', 'archipel/scripts/archipel.mjs']) {
      assert.ok(entries.includes(file), `${file} absent de ${entries.join(', ')}`);
    }
    assert.ok(entries.every((entry) => entry.startsWith('archipel/')));
  });

  test('an unknown, revoked or expired token is refused', async () => {
    const revoked = await issueAgentToken(platform.store, { name: 'old' });
    await platform.store.revokeAgentToken(revoked.id);
    const expired = await issueAgentToken(platform.store, { name: 'past', days: -1 });
    for (const token of ['arc_nope', revoked.token, expired.token]) {
      assert.equal((await asAgent('GET', '/api/releases', { token })).statusCode, 401);
    }
  });

  test('an app whose shared table is missing returns a readable error', async () => {
    const { code, json } = await cli(env, 'deploy', sampleCopy('tickets'), '--preview');
    assert.equal(code, 1);
    assert.equal(json.status, 'failed');
    assert.match(json.report.validation.errors[0].message, /Shared table shared\.customer not found/);
    assert.ok(json.next);
  });

  test('deploy puts in preview, without putting anything live', async () => {
    const release = await deploy('customers');
    assert.equal(release.submitted_by, 'agent:claude');
    assert.ok(release.report.checks.ok);
    assert.ok(release.previewUrl.startsWith(env.ARCHIPEL_URL));
    assert.equal('decision_comment' in release, true);
    assert.deepEqual((await api.get('/api/launchpad')).json().apps, []);
  });

  test('an agent token can never decide or touch what is live', async () => {
    const { id } = await deploy('customers', bump('1.0.1'));
    const routes: [string, string, object | undefined][] = [
      ['POST', `/api/releases/${id}/approve`, { allowDestructive: true }],
      ['POST', `/api/releases/${id}/request-changes`, { comment: 'x' }],
      ['POST', `/api/releases/${id}/reject`, { comment: 'x' }],
      ['POST', '/api/apps/customers/rollback', { releaseId: id }],
      ['POST', '/api/apps/customers/disable', {}],
      ['POST', '/api/apps/customers/enable', {}],
      ['POST', '/api/apps/customers/uninstall', {}],
      ['POST', '/api/alerts/1/ack', {}],
      ['POST', '/api/releases/git', { url: 'https://example.com/r.git' }],
      ['PATCH', '/api/groups/support', { name: 'x' }],
      ['GET', '/api/agent-tokens', undefined],
      ['POST', '/api/agent-tokens', { name: 'x' }],
      ['POST', '/api/agent-tokens/agt000000000000/revoke', {}],
    ];
    for (const [method, url, payload] of routes) {
      const response = await asAgent(method, url, { payload });
      assert.equal(response.statusCode, 403, url);
      assert.equal(response.json().human_required, true, url);
    }
    assert.equal((await api.get(`/api/releases/${id}`)).json().status, 'in_review');
    assert.equal((await platform.store.getApp('customers')).live_release_id, null);
  });

  test('a session cookie does not lend its rights to a token call', async () => {
    const { id } = await deploy('customers', bump('1.0.2'));
    const session = ((await platform.app.inject({ url: '/auth/local' })).headers['set-cookie'] as string).split(';')[0];
    const headers = { cookie: session };
    assert.equal((await asAgent('POST', `/api/releases/${id}/approve`, { headers, payload: {} })).statusCode, 403);
    assert.equal(
      (await asAgent('POST', `/api/releases/${id}/approve`, { token: 'arc_nope', headers, payload: {} })).statusCode,
      401,
    );
    assert.equal((await asAgent('POST', `/%61pi/releases/${id}/approve`, { headers, payload: {} })).statusCode, 403);
    assert.equal((await api.get(`/api/releases/${id}`)).json().status, 'in_review');
  });

  test('promote reports the review without changing anything', async () => {
    const { id } = await deploy('customers', bump('1.0.3'));
    const { code, json } = await cli(env, 'promote', id);
    assert.equal(code, 3);
    assert.deepEqual([json.promoted, json.awaiting_human, json.status], [false, true, 'in_review']);
    assert.match(json.reviewUrl, new RegExp(`#/review/${id}$`));
    assert.equal((await api.get(`/api/releases/${id}`)).json().status, 'in_review');
  });

  test('promote --wait returns at the deadline, then after the human decision', async () => {
    const { id } = await deploy('customers', bump('1.0.4'));
    assert.equal((await cli(env, 'promote', id, '--wait', '0.1')).code, 3);

    const waiting = cli(env, 'promote', id, '--wait', '10');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await approve(id)).statusCode, 200);
    const { code, json } = await waiting;
    assert.equal(code, 0);
    assert.deepEqual([json.promoted, json.status, json.decided_by], [true, 'live', 'Local developer']);
  });

  test('the reviewer comment comes back to the agent', async () => {
    const { id } = await deploy('customers', bump('1.0.5'));
    await api.post(`/api/releases/${id}/request-changes`, { comment: 'Rename the column' });

    const report = await cli(env, 'report', id);
    assert.equal(report.code, 0);
    assert.equal(report.json.decision_comment, 'Rename the column');

    const promote = await cli(env, 'promote', id);
    assert.equal(promote.code, 1);
    assert.equal(promote.json.status, 'changes_requested');
    assert.match(promote.json.next, /decision_comment/);
  });

  test('samples/tickets deploys in preview and its report reads without the interface', async () => {
    const { id, report } = await deploy('tickets');
    assert.ok(report.stages.every((stage) => stage.status === 'ok'));
    assert.ok(report.checks.smoke.length > 0);

    const reread = await cli(env, 'report', id);
    assert.deepEqual(reread.json.report.checks, report.checks);
    await approve(id);
  });

  test('db:schema describes the app and the shared tables, without data', async () => {
    const { code, json } = await cli(env, 'db:schema', 'tickets');
    assert.equal(code, 0);
    assert.equal(json.status, 'live');
    assert.ok(json.tables.ticket.columns.title);
    assert.equal(json.shared['shared.customer'].owner, 'customers');

    const fresh = await cli(env, 'db:schema', 'not-there-yet');
    assert.deepEqual([fresh.code, fresh.json.status], [0, null]);
    assert.ok(fresh.json.shared['shared.customer']);
  });

  test("logs returns the errors of a version or of an app's latest version", async () => {
    const folder = sampleCopy('customers', bump('1.0.7'));
    mkdirSync(join(folder, 'api'));
    writeFileSync(join(folder, 'api', 'boom.js'), 'export default () => { throw new Error("boom"); };');
    appendFileSync(join(folder, 'app.manifest.yaml'), '\ncontrollers:\n  - path: GET /boom\n    handler: ./api/boom.js\n');

    const deployed = (await cli(env, 'deploy', folder)).json;
    assert.equal(deployed.status, 'in_review', JSON.stringify(deployed));
    const mount = platform.registry.get(deployed.id);
    const user = { sub: 't', name: 't', roles: ['admin'] };
    await platform.registry.dispatch(mount, { method: 'GET', path: '/boom', user });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const byRelease = await cli(env, 'logs', deployed.id, '--level', 'error');
    assert.ok(byRelease.json.logs.some((line) => line.message.includes('boom')));
    const byApp = await cli(env, 'logs', 'customers');
    assert.equal(byApp.json.id, deployed.id);
  });

  test("a token does not read another token's versions", async () => {
    const { token } = await issueAgentToken(platform.store, { name: 'other' });
    const { id } = await deploy('customers', bump('1.0.8'));
    assert.equal((await asAgent('GET', `/api/releases/${id}`, { token })).statusCode, 404);
    assert.deepEqual((await asAgent('GET', '/api/releases', { token })).json().releases, []);
    assert.equal((await asAgent('POST', '/api/apps/customers/rollback-request', { token, payload: {} })).statusCode, 404);
    assert.equal((await api.get(`/api/releases/${id}`)).statusCode, 200);
  });

  test('deploy ships neither .git, node_modules, .env nor .mcp.json', async () => {
    const folder = sampleCopy('customers', bump('1.0.9'));
    writeFileSync(join(folder, '.env'), 'KEY=AKIAABCDEFGHIJKLMNOP\n');
    writeFileSync(join(folder, '.mcp.json'), '{ "ARCHIPEL_TOKEN": "arc_jetondetestfactice" }\n');
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'config'), 'x');
    mkdirSync(join(folder, 'node_modules'));
    writeFileSync(join(folder, 'node_modules', 'dep.js'), 'x');
    const { json } = await cli(env, 'deploy', folder);
    assert.equal(json.status, 'in_review', JSON.stringify(json));
    const paths = json.report.scan.files.map((file) => file.path);
    assert.deepEqual(
      paths.filter((path) => /\.env|\.git|\.mcp\.json|node_modules/.test(path)),
      [],
    );
  });

  test('rollback only asks: going back online stays human', async () => {
    const previous = (await platform.store.getApp('customers')).live_release_id;
    const { id } = await deploy('customers', bump('1.1.0'));
    await approve(id);

    const { code, json } = await cli(env, 'rollback', 'customers', '--reason', 'Health failed');
    assert.equal(code, 3);
    assert.deepEqual([json.requested, json.rolled_back, json.target.id], [true, false, previous]);
    assert.equal((await platform.store.getApp('customers')).live_release_id, id);

    const activity = (await api.get('/api/activity')).json();
    const [alert] = activity.alerts;
    assert.match(alert.message, /agent:claude asks to roll .* back to version 1\.0\.4: Health failed/);
    assert.equal(
      activity.events.some((event) => event.type === 'rollback_request'),
      false,
    );

    const audit = await platform.store.auditFor('customers');
    assert.equal(audit[0].action, 'release.rollback_request');

    assert.equal((await api.post(`/api/alerts/${alert.id}/ack`)).statusCode, 200);
    const seen = (await api.get('/api/activity')).json();
    assert.equal(
      seen.alerts.some((item) => item.id === alert.id),
      false,
    );
    assert.equal(
      seen.events.some((event) => event.type === 'rollback_request'),
      true,
    );

    assert.equal((await api.post('/api/apps/customers/rollback', { releaseId: previous })).statusCode, 200);
    assert.equal((await platform.store.getApp('customers')).live_release_id, previous);
  });

  test('agent activity stays reserved for administrators and only counts agents', async () => {
    assert.equal((await asAgent('GET', '/api/activity')).statusCode, 403);

    await platform.store.createRelease({
      id: 'human-lookalike',
      status: 'in_review',
      stage: 'review',
      source_type: 'archive',
      source_label: 'a.zip',
      submitted_by: 'agent:claude',
      submitted_token: null,
    });
    await platform.store.audit('agent:claude', 'app.disable', { appId: 'customers' });

    const { code } = await cli(env, 'rollback', 'customers', '--reason', 'x'.repeat(800));
    assert.equal(code, 3);
    const { id } = await deploy('customers', bump('1.2.0'));

    for (const alert of (await api.get('/api/activity')).json().alerts) await api.post(`/api/alerts/${alert.id}/ack`);
    const { events } = (await api.get('/api/activity')).json();
    assert.ok(events.length <= 8);
    const [submit, request] = events;
    assert.deepEqual(
      [submit.type, submit.agent, submit.release.id, submit.release.status],
      ['submit', 'claude', id, 'in_review'],
    );
    assert.deepEqual([request.type, request.agent, request.app.id], ['rollback_request', 'claude', 'customers']);
    assert.equal(request.reason.length, 500);
    assert.ok(new Date(submit.at) >= new Date(request.at));
    assert.equal(
      events.some((event) => event.release?.id === 'human-lookalike'),
      false,
    );
    assert.equal(
      events.some((event) => event.action === 'app.disable'),
      false,
    );

    await platform.db('platform_releases').where({ id: 'human-lookalike' }).del();
  });

  test('rollback refuses a target never approved', async () => {
    const { id } = await deploy('customers', bump('1.1.1'));
    const { code, json } = await cli(env, 'rollback', 'customers', '--to', id);
    assert.equal(code, 2);
    assert.match(json.error, /No approved version/);
  });

  describe('MCP server', () => {
    let child;
    let call;

    before(() => {
      const { ARCHIPEL_URL, ARCHIPEL_TOKEN, ...clean } = process.env;
      child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
      const pending = new Map();
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      });
      let nextId = 0;
      call = (method, params) =>
        new Promise((resolve) => {
          nextId += 1;
          pending.set(nextId, resolve);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
        });
    });
    after(() => child.kill());

    const tool = async (name, args) => {
      const { result } = await call('tools/call', { name, arguments: args });
      return { ...result, json: JSON.parse(result.content[0].text) };
    };

    test('initialises and negotiates the protocol version', async () => {
      const { result } = await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      });
      assert.equal(result.protocolVersion, '2025-06-18');
      assert.equal(result.serverInfo.name, 'archipel');
      assert.ok(result.capabilities.tools);
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const unknown = await call('initialize', { protocolVersion: '1999-01-01' });
      assert.match(unknown.result.protocolVersion, /^\d{4}-/);
    });

    test('exposes the operations, and no approval tool', async () => {
      const { result } = await call('tools/list');
      const names = result.tools.map((item) => item.name);
      assert.deepEqual(names.sort(), [
        'app_openapi',
        'db_schema',
        'deploy_preview',
        'generate_types',
        'get_report',
        'logs',
        'promote',
        'rollback',
        'validate',
      ]);
      for (const item of result.tools) assert.equal(item.run, undefined);
      assert.equal((await call('tools/call', { name: 'approve', arguments: {} })).error.code, -32602);
    });

    test('an unknown method gets a JSON-RPC error', async () => {
      assert.equal((await call('resources/list')).error.code, -32601);
    });

    test('validates, deploys, reads the report and reports the review', async () => {
      const folder = sampleCopy('customers', bump('1.2.0'));
      assert.equal((await tool('validate', { dir: folder })).json.valid, true);

      const deployed = await tool('deploy_preview', { dir: folder });
      assert.equal(deployed.isError, false);
      assert.equal(deployed.json.status, 'in_review');

      const report = await tool('get_report', { release: deployed.json.id });
      assert.equal(report.json.id, deployed.json.id);

      const promote = await tool('promote', { release: deployed.json.id });
      assert.deepEqual([promote.json.promoted, promote.json.awaiting_human], [false, true]);
      assert.equal((await api.get(`/api/releases/${deployed.json.id}`)).json().status, 'in_review');

      assert.equal((await tool('db_schema', { app: 'customers' })).json.id, 'customers');
      assert.ok(Array.isArray((await tool('logs', { target: deployed.json.id })).json.logs));
    });

    test('a tool error stays readable by the agent', async () => {
      const missing = await tool('get_report', {});
      assert.equal(missing.isError, true);
      assert.match(missing.json.error, /release/);
      const absent = await tool('get_report', { release: 'rel000000000000' });
      assert.equal(absent.isError, true);
      assert.match(absent.json.error, /not found/);
    });

    test('a waiting promote does not block the other calls', async () => {
      const folder = sampleCopy('customers', bump('1.3.0'));
      const { json } = await tool('deploy_preview', { dir: folder });
      const waiting = tool('promote', { release: json.id, wait_seconds: 10 });
      assert.deepEqual((await call('ping')).result, {});
      await api.post(`/api/releases/${json.id}/reject`, { comment: 'Non' });
      const decided = await waiting;
      assert.deepEqual([decided.json.status, decided.json.decision_comment], ['rejected', 'Non']);
    });
  });
});
