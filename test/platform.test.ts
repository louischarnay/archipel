import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { create } from 'tar';
import { extractArchive, IntakeError } from '../packages/server/src/pipeline/intake.js';
import { physicalName } from '../packages/server/src/pipeline/migrate.js';
import { bareApp, installLive, sampleCopy, startPlatform } from './helpers.js';

const bearer = (token) => ({ authorization: `Bearer ${token}` });

describe('review and go-live', () => {
  let platform;
  let api;

  before(async () => {
    platform = await startPlatform();
    api = platform.api;
    await installLive(platform, sampleCopy('customers'));
  });
  after(() => platform.stop());

  test('a missing shared table is refused with an actionable error', async () => {
    const other = await startPlatform();
    const release = await other.api.submit(sampleCopy('tickets'));
    assert.equal(release.status, 'failed');
    assert.match(release.report.validation.errors[0].message, /Shared table shared\.customer not found/);
    await other.stop();
  });

  test('a version does not reach the launchpad before the decision', async () => {
    const release = await api.submit(sampleCopy('tickets'));
    assert.equal(release.status, 'in_review');
    assert.equal(release.flags.permissions, true);
    assert.ok(release.previewUrl);
    assert.ok(release.report.checks.ok);

    const launchpad = (await api.get('/api/launchpad')).json();
    assert.deepEqual(
      launchpad.apps.map((app) => app.id),
      ['customers'],
    );
    assert.equal((await api.get('/tickets/')).statusCode, 404);

    const approved = await api.post(`/api/releases/${release.id}/approve`, { comment: 'ok' });
    assert.equal(approved.json().status, 'live');
    assert.equal((await api.get('/api/launchpad')).json().apps.length, 2);
    assert.equal((await api.get('/tickets/')).statusCode, 200);

    const previewTable = physicalName({ own: `pv_${release.id}`, shared: '' }, 'ticket');
    assert.equal(await platform.db.schema.hasTable(previewTable), false);
    assert.equal(await platform.db.schema.hasTable('app_tickets_ticket'), true);
  });

  test('a rejection requires a comment and keeps it for the agent', async () => {
    const release = await api.submit(
      sampleCopy('tickets', {
        'app.manifest.yaml': (text) => text.replace('version: 1.0.0', 'version: 1.0.1'),
      }),
    );
    const without = await api.post(`/api/releases/${release.id}/reject`, {});
    assert.equal(without.statusCode, 409);

    const withComment = await api.post(`/api/releases/${release.id}/request-changes`, { comment: 'Rename the route' });
    assert.equal(withComment.json().status, 'changes_requested');
    assert.equal((await api.get(`/api/releases/${release.id}`)).json().decision_comment, 'Rename the route');
    assert.equal((await api.post(`/api/releases/${release.id}/approve`)).statusCode, 409);
  });

  test('a destructive change requires confirmation and leaves a copy', async () => {
    const live = (await api.get('/api/apps/tickets')).json();
    const token = await api.appToken('/tickets/');
    await platform.app.inject({
      method: 'POST',
      url: '/run/tickets/data/ticket',
      headers: bearer(token),
      payload: { title: 'To keep', customer_id: 'c1' },
    });

    const release = await api.submit(
      sampleCopy('tickets', {
        'app.manifest.yaml': (text) =>
          text
            .replace('version: 1.0.0', 'version: 1.1.0')
            .replace('      customer_id: { type: ref, to: shared.customer }\n', '      priority: { type: integer, default: 1 }\n')
            .replace('permissions:\n  reads: [shared.customer]\n', 'permissions:\n  network: [api.example.com]\n'),
      }),
    );
    assert.equal(release.flags.destructive, true);
    assert.deepEqual(release.report.diff.permissions.network.added, ['api.example.com']);

    const refused = await api.post(`/api/releases/${release.id}/approve`, {});
    assert.equal(refused.statusCode, 409);
    assert.equal(await platform.db.schema.hasColumn('app_tickets_ticket', 'customer_id'), true);

    const approved = await api.post(`/api/releases/${release.id}/approve`, { allowDestructive: true });
    assert.equal(approved.statusCode, 200);
    assert.equal(await platform.db.schema.hasColumn('app_tickets_ticket', 'customer_id'), false);

    const copy = await platform.db(`bak_${release.id}_app_tickets_ticket`).where({ title: 'To keep' }).first();
    assert.equal(copy.customer_id, 'c1');

    const { alerts } = (await api.get('/api/activity')).json();
    assert.match(alerts[0].message, /api\.example\.com/);
    const [stored] = await platform.store.listOpenAlerts();
    assert.equal(stored.release_id, release.id);

    const previous = live.releases.find((item) => item.status === 'live');
    const rollback = await api.post('/api/apps/tickets/rollback', { releaseId: previous.id });
    assert.equal(rollback.statusCode, 200);
    assert.equal(await platform.db.schema.hasColumn('app_tickets_ticket', 'customer_id'), true);
    assert.equal(await platform.db.schema.hasColumn('app_tickets_ticket', 'priority'), true);
    assert.equal((await api.get('/api/apps/tickets')).json().manifest.version, '1.0.0');
  });

  test('a rejected version cannot be put back online', async () => {
    const rejected = (await api.get('/api/apps/tickets')).json().releases.find((item) => item.status === 'changes_requested');
    assert.equal((await api.post('/api/apps/tickets/rollback', { releaseId: rejected.id })).statusCode, 409);
  });

  test('the owner of a shared table in use cannot be removed', async () => {
    assert.equal((await api.post('/api/apps/customers/uninstall')).statusCode, 409);
    assert.equal((await api.post('/api/apps/customers/disable')).statusCode, 409);
  });

  test('another app cannot redeclare a shared table', async () => {
    const release = await api.submit(
      bareApp(`
manifest: 1
id: usurper
name: Usurpateur
version: 1.0.0
tables:
  shared.customer:
    columns:
      id: { type: uuid, pk: true }
`),
    );
    assert.equal(release.status, 'failed');
    assert.match(release.report.validation.errors[0].message, /belongs to the app customers/);
  });

  test('disabling cuts the app, enabling restores it, without a restart', async () => {
    assert.equal((await api.post('/api/apps/tickets/disable')).statusCode, 200);
    assert.equal((await api.get('/tickets/')).statusCode, 404);
    assert.equal((await api.post('/api/apps/tickets/enable')).statusCode, 200);
    assert.equal((await api.get('/tickets/')).statusCode, 200);
  });
});

describe('isolation', () => {
  let platform;
  let api;
  let customersToken;
  let ticketsToken;

  before(async () => {
    platform = await startPlatform({ ARCHIPEL_CONTROLLER_TIMEOUT_MS: '400' });
    api = platform.api;
    await installLive(platform, sampleCopy('customers'));
    await installLive(platform, sampleCopy('tickets'));
    customersToken = await api.appToken('/customers/');
    ticketsToken = await api.appToken('/tickets/');
  });
  after(() => platform.stop());

  const call = (method: string, url: string, token?: string, payload?: object) =>
    platform.app.inject({ method, url, headers: token ? bearer(token) : {}, payload });

  test('an app frontend is served in a sandbox, with a token', async () => {
    const response = await api.get('/tickets/');
    const csp = response.headers['content-security-policy'];
    assert.match(csp, /^sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(response.body, /window\.archipel=d/);
  });

  test('an app API ignores the session cookie', async () => {
    const response = await platform.app.inject({
      url: '/run/tickets/data/ticket',
      headers: { cookie: (await platform.app.inject({ url: '/auth/local' })).headers['set-cookie'] },
    });
    assert.equal(response.statusCode, 401);
  });

  test('a token is only valid for its app', async () => {
    assert.equal((await call('GET', '/run/tickets/data/ticket', customersToken)).statusCode, 403);
    assert.equal((await call('GET', '/run/tickets/data/ticket', ticketsToken)).statusCode, 200);
  });

  test('the platform API refuses mutations from an opaque origin', async () => {
    const { id } = await api.submit(
      sampleCopy('tickets', {
        'app.manifest.yaml': (text) => text.replace('version: 1.0.0', 'version: 2.0.0'),
      }),
    );
    for (const prefix of ['/api', '/%61pi', '/a%70i']) {
      const response = await api.post(`${prefix}/releases/${id}/approve`, {}, { origin: 'null' });
      assert.equal(response.statusCode, 403, prefix);
    }
    assert.equal((await api.get(`/api/releases/${id}`)).json().status, 'in_review');
    await api.post(`/api/releases/${id}/reject`, { comment: 'test' });
  });

  test('an app does not read an undeclared shared table, nor write without writes', async () => {
    const write = await call('POST', '/run/tickets/data/shared.customer', ticketsToken, { name: 'X' });
    assert.equal(write.statusCode, 403);
    const read = await call('GET', '/run/tickets/data/shared.customer', ticketsToken);
    assert.equal(read.statusCode, 200);
    const other = await call('GET', '/run/customers/data/ticket', customersToken);
    assert.equal(other.statusCode, 403);
  });

  test('the CRUD validates data and filters', async () => {
    const bad = await call('POST', '/run/tickets/data/ticket', ticketsToken, { title: 'x', status: 'nope', extra: 1 });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().details.length, 2);
    const filter = await call('GET', '/run/tickets/data/ticket?nope=1', ticketsToken);
    assert.equal(filter.statusCode, 400);
  });

  test('the preview is isolated from live data', async () => {
    await call('POST', '/run/tickets/data/ticket', ticketsToken, { title: 'Real ticket' });
    const release = await api.submit(
      sampleCopy('tickets', {
        'app.manifest.yaml': (text) => text.replace('version: 1.0.0', 'version: 3.0.0'),
      }),
    );
    const token = await api.appToken(`/preview/${release.id}/`);
    const rows = (await call('GET', `/run/p/${release.id}/data/ticket`, token)).json();
    assert.deepEqual(rows, []);
    assert.equal((await call('GET', '/run/tickets/data/ticket', token)).statusCode, 403);
    await api.post(`/api/releases/${release.id}/reject`, { comment: 'test' });
    assert.equal((await api.get(`/preview/${release.id}/`)).statusCode, 404);
  });

  test('code blocked by the scan is never run', async () => {
    const marker = join(platform.dir, 'executed');
    const release = await api.submit(
      bareApp(
        `
manifest: 1
id: bad-app
name: Bad
version: 1.0.0
controllers:
  - path: GET /x
    handler: ./x.js
health: /x
`,
        {
          'x.js': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '1');\nexport default () => ({});\n`,
        },
      ),
    );
    assert.equal(release.status, 'failed');
    assert.ok(release.report.scan.findings.some((finding) => finding.id === 'fs.direct'));
    assert.equal(release.report.checks, undefined);
    assert.equal(platform.registry.get(release.id), undefined);
  });

  test('a trapped archive fails cleanly without bringing the server down', async () => {
    const { symlinkSync } = await import('node:fs');
    const folder = sampleCopy('customers');
    symlinkSync('/etc/passwd', join(folder, 'link'));
    const release = await api.submit(folder);
    assert.equal(release.status, 'failed');
    assert.match(release.summary, /symbolic link/);
    assert.equal((await api.get('/health')).statusCode, 200);
  });

  test('a secret in the archive blocks the version', async () => {
    const release = await api.submit(
      bareApp(
        `
manifest: 1
id: leaky
name: Leaky
version: 1.0.0
frontend: { dir: ./web, route: /leaky }
`,
        { 'web/config.js': 'const key = "AKIAABCDEFGHIJKLMNOP";' },
      ),
    );
    assert.equal(release.status, 'failed');
    assert.equal(release.report.scan.findings[0].id, 'secret.aws');
  });

  const controllerApp = (id, code) =>
    bareApp(
      `
manifest: 1
id: ${id}
name: ${id}
version: 1.0.0
controllers:
  - path: GET /go
    handler: ./go.js
`,
      { 'go.js': code },
    );

  async function runController(id, code) {
    const release = await api.submit(controllerApp(id, code));
    assert.equal(release.status, 'in_review', JSON.stringify(release.report));
    const mount = platform.registry.get(release.id);
    const user = { sub: 't', name: 't', roles: ['admin'] };
    return platform.registry.dispatch(mount, { method: 'GET', path: '/go', user });
  }

  test('a controller does not inherit the host environment', async () => {
    process.env.ARCHIPEL_TEST_SECRET = 'non';
    const code = 'export default () => Object.keys(globalThis.process["e" + "nv"]);';
    const response = await runController('env-check', code);
    delete process.env.ARCHIPEL_TEST_SECRET;
    assert.equal(response.status, 200);
    assert.equal(response.body.includes('ARCHIPEL_TEST_SECRET'), false);
  });

  test("a controller's network follows permissions.network", async () => {
    const response = await runController(
      'net-check',
      `export default async () => {
      try { await fetch('https://example.com'); return 'sorti'; } catch (error) { return error.message; }
    };`,
    );
    assert.match(response.body, /Network refused/);
  });

  test('a looping controller is cut and the next one starts again', async () => {
    const code = 'export default (ctx) => { if (ctx.query.spin) while (true); return "ok"; };';
    const release = await api.submit(controllerApp('spin-check', code));
    const mount = platform.registry.get(release.id);
    const user = { sub: 't', name: 't', roles: ['admin'] };
    const stuck = await platform.registry.dispatch(mount, { method: 'GET', path: '/go', query: { spin: '1' }, user });
    assert.equal(stuck.status, 504);
    const next = await platform.registry.dispatch(mount, { method: 'GET', path: '/go', user });
    assert.deepEqual([next.status, next.body], [200, 'ok']);
  });

  test('a controller error shows up in the version logs', async () => {
    const release = await api.submit(controllerApp('crash-check', 'export default () => { throw new Error("boom"); };'));
    const mount = platform.registry.get(release.id);
    const user = { sub: 't', name: 't', roles: ['admin'] };
    const response = await platform.registry.dispatch(mount, { method: 'GET', path: '/go', user });
    assert.equal(response.status, 500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { logs } = (await api.get(`/api/releases/${release.id}`)).json();
    assert.ok(logs.some((line) => line.level === 'error' && line.message.includes('boom')));
  });

  test("a version's files do not leave its folder", async () => {
    const { releases } = (await api.get('/api/apps/tickets')).json();
    const response = await api.get(`/api/releases/${releases.at(-1).id}/file?path=${encodeURIComponent('../../../secret')}`);
    assert.equal(response.statusCode, 404);
    const app = await api.get('/tickets/..%2F..%2F..%2F..%2Fsecret');
    assert.ok(!app.body.includes(platform.config.secret));
  });
});

describe('Git repositories', () => {
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  function localRepository() {
    const folder = sampleCopy('customers');
    run(folder, 'init', '-b', 'main');
    run(folder, 'add', '.');
    run(folder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'v1');
    return folder;
  }

  test('a repository follows the same pipeline and keeps its commit', async () => {
    const platform = await startPlatform({ ARCHIPEL_GIT_PROTOCOLS: 'file' });
    const response = await platform.api.post('/api/releases/git', { url: `file://${localRepository()}`, ref: 'main' });
    const release = await platform.api.waitFor(response.json().id);
    assert.equal(release.status, 'in_review', JSON.stringify(release.report));
    assert.match(release.report.source.commit, /^[0-9a-f]{7,}$/);
    assert.equal(
      release.report.scan.files.some((file) => file.path.startsWith('.git')),
      false,
    );
    await platform.stop();
  });

  test('local and ext:: transports are refused by default', async () => {
    const platform = await startPlatform();
    const marker = join(platform.dir, 'pwned');
    for (const url of [`file://${localRepository()}`, `ext::sh -c touch% ${marker}`]) {
      const response = await platform.api.post('/api/releases/git', { url });
      const release = await platform.api.waitFor(response.json().id);
      assert.equal(release.status, 'failed');
      assert.match(release.summary, /Clone failed/);
    }
    assert.equal(existsSync(marker), false);
    await platform.stop();
  });

  test('a URL or a reference that mimics an option is refused', async () => {
    const platform = await startPlatform();
    const byUrl = await platform.api.post('/api/releases/git', { url: '--upload-pack=touch /tmp/x' });
    assert.equal((await platform.api.waitFor(byUrl.json().id)).status, 'failed');
    const byRef = await platform.api.post('/api/releases/git', { url: 'https://example.com/r.git', ref: '--upload-pack=x' });
    assert.equal((await platform.api.waitFor(byRef.json().id)).status, 'failed');
    await platform.stop();
  });
});

describe('archives', () => {
  const target = () => mkdtempSync(join(tmpdir(), 'archipel-extract-'));

  test('refuses a path traversal in a zip', async () => {
    const zip = new AdmZip();
    zip.addFile('ok.txt', Buffer.from('x'));
    zip.getEntries()[0].entryName = '../evil.txt';
    const file = join(target(), 'a.zip');
    zip.writeZip(file);
    await assert.rejects(extractArchive(file, 'a.zip', target()), IntakeError);
  });

  test('refuses a symbolic link in a tar', async () => {
    const { symlinkSync } = await import('node:fs');
    const dir = target();
    writeFileSync(join(dir, 'app.manifest.yaml'), 'manifest: 1');
    symlinkSync('/etc/passwd', join(dir, 'link'));
    const file = join(target(), 'a.tgz');
    await create({ gzip: true, file, cwd: dir }, ['.']);
    await assert.rejects(extractArchive(file, 'a.tgz', target()), /symbolic link/);
  });

  test('accepts a single root folder', async () => {
    const dir = target();
    const inner = join(dir, 'mon-app');
    (await import('node:fs')).mkdirSync(inner);
    writeFileSync(join(inner, 'app.manifest.yaml'), 'manifest: 1');
    const file = join(target(), 'a.tgz');
    await create({ gzip: true, file, cwd: dir }, ['mon-app']);
    const root = await extractArchive(file, 'a.tgz', target());
    assert.ok(root.endsWith('mon-app'));
  });

  test('refuses an unknown format', async () => {
    await assert.rejects(extractArchive('/dev/null', 'a.rar', target()), /Unsupported/);
  });
});

describe('Tables page', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
    await installLive(platform, sampleCopy('customers'));
    await installLive(platform, sampleCopy('tickets'));
  });
  after(() => platform.stop());

  test('each app lists its tables, with the domain and the owner', async () => {
    const { api } = platform;
    await platform.db('shared_customer').insert({ id: 'c1', name: 'Acme' });

    const { apps } = (await api.get('/api/tables')).json();
    const tablesOf = (id) => apps.find((app) => app.id === id).tables;

    const [owned] = tablesOf('customers');
    assert.equal(owned.name, 'customer');
    assert.equal(owned.physical, 'shared_customer');
    assert.equal(owned.shared, true);
    assert.equal(owned.access, 'owner');
    assert.equal(owned.owner.id, 'customers');
    assert.equal(owned.rows, 1);
    assert.equal(owned.exposed, true);
    assert.deepEqual(owned.consumers, [{ id: 'tickets', name: owned.consumers[0].name, access: 'read' }]);
    assert.equal(owned.columns.find((column) => column.name === 'id').pk, true);

    const tickets = tablesOf('tickets');
    const own = tickets.find((table) => table.name === 'ticket');
    assert.equal(own.shared, false);
    assert.equal(own.physical, 'app_tickets_ticket');
    assert.equal(own.rows, 0);
    assert.equal(own.columns.find((column) => column.name === 'customer_id').to, 'shared.customer');

    const used = tickets.find((table) => table.name === 'customer');
    assert.equal(used.shared, true);
    assert.equal(used.access, 'read');
    assert.equal(used.owner.id, 'customers');
    assert.equal(used.columns.length, owned.columns.length);
  });

  test('no data row comes out, and the page stays reserved for administrators', async () => {
    const { api, app } = platform;
    assert.equal((await api.get('/api/tables')).body.includes('Acme'), false);
    assert.equal((await app.inject({ url: '/api/tables' })).statusCode, 401);
  });
});

describe('commands', () => {
  const ID = '6f1c1a54-3f0e-4a7e-9c55-0f3b8a2d4e11';
  const writeOnlyAdmin = (text) => text.replace('write: [user, admin]', 'write: [admin]');
  let platform;
  let api;

  before(async () => {
    platform = await startPlatform();
    api = platform.api;
    await installLive(platform, sampleCopy('customers'));
    await installLive(platform, sampleCopy('tickets', { 'app.manifest.yaml': writeOnlyAdmin }));
  });
  after(() => platform.stop());

  const visitor = async () => {
    const { token } = await platform.sessions.open({ sub: 'u1', name: 'Sam', email: null, groups: [], admin: false });
    return { archipel_session: token };
  };

  test('declared actions are listed with their fields', async () => {
    const { commands } = (await api.get('/api/commands')).json();
    assert.deepEqual(commands, [
      {
        app: { id: 'tickets', name: 'Ticket management' },
        name: 'close_ticket',
        description: 'Closes a ticket by its id',
        fields: [{ name: 'id', type: 'uuid' }],
      },
    ]);
  });

  test('an action goes through the app controller and leaves a trace without its content', async () => {
    await platform.db('app_tickets_ticket').insert({ id: ID, title: 'Panne', status: 'open' });
    const response = await api.post('/api/commands/tickets/close_ticket', { input: { id: ID } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 200);
    assert.equal(response.json().result.status, 'done');
    assert.equal((await platform.db('app_tickets_ticket').where({ id: ID }).first()).status, 'done');

    const [entry] = await platform.store.auditFor('tickets');
    assert.equal(entry.action, 'command.run');
    assert.equal(entry.actor, 'Local developer');
    assert.equal(JSON.stringify(entry).includes(ID), false);
  });

  test('the app error comes back as is', async () => {
    const response = await api.post('/api/commands/tickets/close_ticket', {
      input: { id: '00000000-0000-4000-8000-000000000000' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 404);
    assert.match(response.json().result.error, /not found/);
  });

  test('fields are checked before reaching the app', async () => {
    const run = (input) => api.post('/api/commands/tickets/close_ticket', { input });
    assert.equal((await run({})).statusCode, 400);
    assert.equal((await run({ id: '../../data/ticket' })).statusCode, 400);
    assert.equal((await run({ id: ID, status: 'open' })).statusCode, 400);
    assert.equal((await run([ID])).statusCode, 400);
    assert.equal((await api.post('/api/commands/tickets/unknown', { input: {} })).statusCode, 404);
    assert.equal((await api.post('/api/commands/missing/close_ticket', { input: {} })).statusCode, 404);
  });

  test('the app permissions apply to the list and to running', async () => {
    const cookies = await visitor();
    assert.deepEqual((await platform.app.inject({ url: '/api/commands', cookies })).json().commands, []);
    const refused = await platform.app.inject({
      method: 'POST',
      url: '/api/commands/tickets/close_ticket',
      cookies,
      headers: { origin: platform.config.publicUrl },
      payload: { input: { id: ID } },
    });
    assert.equal(refused.json().status, 403);
  });

  test('neither an agent token, nor an app, nor a visitor triggers an action', async () => {
    const { app } = platform;
    const { token } = (await api.post('/api/agent-tokens', { name: 'ci' })).json();
    const url = '/api/commands/tickets/close_ticket';
    const payload = { input: { id: ID } };
    const authorization = `Bearer ${token}`;
    assert.equal((await app.inject({ url: '/api/commands', headers: { authorization } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url, headers: { authorization }, payload })).statusCode, 403);
    assert.equal((await api.post(url, payload, { origin: 'null' })).statusCode, 403);
    assert.equal(
      (await app.inject({ method: 'POST', url, payload, headers: { origin: platform.config.publicUrl } })).statusCode,
      401,
    );
  });

  test('a disabled app offers nothing any more', async () => {
    assert.equal((await api.post('/api/apps/tickets/disable')).statusCode, 200);
    assert.deepEqual((await api.get('/api/commands')).json().commands, []);
    assert.equal((await api.post('/api/commands/tickets/close_ticket', { input: { id: ID } })).statusCode, 404);
    assert.equal((await api.post('/api/apps/tickets/enable')).statusCode, 200);
  });
});

describe('unreviewed code', () => {
  let platform;
  let api;

  before(async () => {
    platform = await startPlatform();
    api = platform.api;
  });
  after(() => platform.stop());

  // The health check reports what ctx.fetch answered, so the test reads it from the report.
  const probe = (version, network) =>
    bareApp(
      `
manifest: 1
id: prober
name: Prober
version: ${version}
controllers:
  - path: GET /prober/health
    handler: ./health.js
permissions:
  network: [${network.join(', ')}]
health: /prober/health
`,
      {
        'health.js': `export default async (ctx) => {
  try { await ctx.fetch('https://127.0.0.1/'); return { refused: null }; }
  catch (error) { return { refused: error.message }; }
};
`,
      },
    );

  test('a preview cannot use a network rule nobody approved yet', async () => {
    const first = await api.submit(probe('1.0.0', ['127.0.0.1']));
    assert.equal(first.status, 'in_review');
    assert.match(first.report.checks.health.body.refused, /declared but not approved yet/);
    assert.deepEqual(platform.registry.get(first.id).network, []);

    assert.equal((await api.post(`/api/releases/${first.id}/approve`, { comment: 'ok' })).statusCode, 200);
    assert.deepEqual(platform.registry.get('prober').network, ['127.0.0.1']);

    // Approved once, the rule applies to the next previews, under the usual address checks.
    const second = await api.submit(probe('1.1.0', ['127.0.0.1', '10.0.0.1']));
    assert.equal(second.status, 'in_review');
    assert.match(second.report.checks.health.body.refused, /forbidden address/);
    assert.deepEqual(platform.registry.get(second.id).network, ['127.0.0.1']);
  });

  const owner = (id, table) =>
    bareApp(`
manifest: 1
id: ${id}
name: ${id}
version: 1.0.0
tables:
  ${table}:
    columns:
      id: { type: uuid, pk: true }
      secret: { type: string }
    crud: true
    rbac:
      read: [user]
      write: [admin]
`);

  test('an app cannot claim the physical table of another app', async () => {
    await installLive(platform, owner('crm-data', 'customer'));
    assert.equal(physicalName({ own: 'app_crm', shared: 'shared' }, 'data_customer'), 'app_crm_data_customer');
    const release = await api.submit(owner('crm', 'data_customer'));
    assert.equal(release.status, 'failed');
    assert.match(release.report.validation.errors[0].message, /app_crm_data_customer, a table that belongs to the app crm-data/);
  });

  test('the claim is checked again at approval', async () => {
    const first = await api.submit(owner('crm-log', 'entry'));
    const second = await api.submit(owner('crm', 'log_entry'));
    assert.equal(first.status, 'in_review');
    assert.equal(second.status, 'in_review');
    assert.equal((await api.post(`/api/releases/${first.id}/approve`, { comment: 'ok' })).statusCode, 200);
    const refused = await api.post(`/api/releases/${second.id}/approve`, { comment: 'ok' });
    assert.notEqual(refused.statusCode, 200);
    assert.match(refused.json().error, /belongs to the app crm-log/);
    assert.equal((await api.get(`/api/releases/${second.id}`)).json().status, 'in_review');
  });
});
