import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { BlockList } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from '../packages/server/src/config/config.js';
import { browserSource, parseRule, ruleFor } from '@archipel/manifest-schema';
import { createEgress } from '../packages/server/src/runtime/sandbox/egress.js';
import { containerArguments, shareReadOnly } from '../packages/server/src/runtime/sandbox/launchers.js';
import { startPlatform } from './helpers.js';

const limits = { controllerTimeoutMs: 2000, fetchBytes: 1024 };
const resolvingTo = (address) => (host, options, done) => done(null, [{ address, family: address.includes(':') ? 6 : 4 }]);

describe('network rules', () => {
  const allowed = (url, rules) => Boolean(ruleFor(new URL(url), rules));

  test('a simple rule only opens https on the standard port', () => {
    assert.equal(allowed('https://api.example.com/x', ['api.example.com']), true);
    assert.equal(allowed('http://api.example.com/x', ['api.example.com']), false);
    assert.equal(allowed('https://api.example.com:8443/x', ['api.example.com']), false);
  });

  test('the declared port is respected', () => {
    assert.equal(allowed('https://api.example.com:8443/', ['api.example.com:8443']), true);
    assert.equal(allowed('https://api.example.com/', ['api.example.com:8443']), false);
  });

  test('a wildcard only covers subdomains', () => {
    assert.equal(allowed('https://a.example.com/', ['*.example.com']), true);
    assert.equal(allowed('https://evilexample.com/', ['*.example.com']), false);
  });

  test('only the http:// prefix opens plain text', () => {
    assert.equal(allowed('http://intranet.local:8080/', ['http://intranet.local:8080']), true);
    assert.equal(parseRule('http://intranet.local:8080').internal, true);
    assert.equal(browserSource('http://intranet.local:8080'), 'http://intranet.local:8080');
    assert.equal(browserSource('api.example.com'), 'https://api.example.com');
  });

  test('other protocols never get through', () => {
    assert.equal(allowed('ftp://api.example.com/', ['api.example.com']), false);
    assert.equal(allowed('file:///etc/passwd', ['http://localhost']), false);
  });
});

describe('controller network egress', () => {
  const refused = (network, url, address = '93.184.216.34') =>
    assert.rejects(createEgress({ network, limits, lookup: resolvingTo(address) })({ url }), /Network refused/);

  test('refuses an undeclared host', () => refused(['api.example.com'], 'https://evil.example.com/'));
  test('refuses plain text without an http:// rule', () => refused(['api.example.com'], 'http://api.example.com/'));

  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    test(`refuses a name that resolves to ${address}`, () => refused(['api.example.com'], 'https://api.example.com/', address));
  }

  test('refuses a forbidden literal address, even declared', async () => {
    await refused(['169.254.169.254'], 'https://169.254.169.254/');
    await refused(['http://127.0.0.1:80'], 'http://127.0.0.1/');
  });

  test('an http:// rule opens private addresses but never the machine or metadata', async () => {
    await refused(['http://intranet.local'], 'http://intranet.local/', '127.0.0.1');
    await refused(['http://intranet.local'], 'http://intranet.local/', '169.254.169.254');
    await assert.rejects(
      createEgress({ network: ['http://intranet.local:1'], limits, lookup: resolvingTo('10.255.255.1') })({
        url: 'http://intranet.local:1/',
      }),
      (error: Error) => !/Network refused/.test(error.message),
    );
  });

  describe('with a real server', () => {
    let server;
    let port;
    const open = { forbidden: new BlockList(), private: new BlockList() };
    const seen = [];

    before(async () => {
      server = createServer((request, response) => {
        seen.push({ url: request.url, headers: request.headers, method: request.method });
        if (request.url === '/metadata') return response.writeHead(302, { location: 'http://169.254.169.254/latest' }).end();
        if (request.url === '/elsewhere') return response.writeHead(302, { location: 'https://evil.example.com/' }).end();
        if (request.url === '/loop') return response.writeHead(302, { location: '/loop' }).end();
        if (request.url === '/big') return response.end(Buffer.alloc(4096));
        if (request.url === '/moved') return response.writeHead(302, { location: `http://other.test:${port}/ok` }).end();
        return response.end('ok');
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });
    after(() => server.close());

    const egress = (network, policy = open) => createEgress({ network, limits, policy, lookup: resolvingTo('127.0.0.1') });
    const rules = () => [`http://local.test:${port}`];

    test('returns the response', async () => {
      const answer = await egress(rules())({ url: `http://local.test:${port}/`, headers: { accept: 'text/plain' } });
      assert.deepEqual([answer.status, Buffer.from(answer.body, 'base64').toString()], [200, 'ok']);
    });

    test('checks each redirect again', async () => {
      const strict = { forbidden: new BlockList(), private: new BlockList() };
      strict.forbidden.addSubnet('169.254.0.0', 16, 'ipv4');
      await assert.rejects(egress(rules(), strict)({ url: `http://local.test:${port}/metadata` }), /Network refused/);
      await assert.rejects(egress(rules())({ url: `http://local.test:${port}/elsewhere` }), /Network refused/);
    });

    test('limits redirects', () =>
      assert.rejects(egress(rules())({ url: `http://local.test:${port}/loop` }), /Too many redirects/));
    test('limits the response size', () =>
      assert.rejects(egress(rules())({ url: `http://local.test:${port}/big` }), /too large/));

    test('does not pass credentials to another host', async () => {
      seen.length = 0;
      await egress([...rules(), `http://other.test:${port}`])({
        url: `http://local.test:${port}/moved`,
        headers: { authorization: 'Bearer x', cookie: 'a=b', host: 'forged.test' },
      });
      assert.equal(seen[0].headers.authorization, 'Bearer x');
      assert.equal(seen[0].headers.host, `local.test:${port}`);
      assert.equal(seen[1].headers.authorization, undefined);
      assert.equal(seen[1].headers.cookie, undefined);
    });
  });
});

describe('isolation configuration', () => {
  const dir = { ARCHIPEL_DATA_DIR: '/tmp/archipel-config-test' };

  test('the container is required outside development', () => {
    assert.equal(loadConfig({ ...dir }).sandbox.mode, 'container');
    assert.throws(() => loadConfig({ ...dir, ARCHIPEL_SANDBOX: 'process' }), /reserved for `npm run dev`/);
  });

  test('process mode stays possible in development', () => {
    assert.equal(loadConfig({ ...dir, ARCHIPEL_AUTH: 'dev' }).sandbox.mode, 'process');
  });

  test('the image is pinned by digest', () => {
    assert.match(loadConfig({ ...dir }).sandbox.image, /@sha256:[0-9a-f]{64}$/);
  });

  test('a container starts without network, without rights and read-only', () => {
    const { sandbox, limits: configured } = loadConfig({ ...dir });
    const args = containerArguments({ name: 'n', instance: 'i', root: '/r', runner: '/x', sandbox, limits: configured }).join(
      ' ',
    );
    for (const flag of [
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--user 65534:65534',
      '--ipc none',
      '--log-driver none',
      'dst=/app,readonly',
    ]) {
      assert.ok(args.includes(flag), flag);
    }
  });
});

const container = process.env.ARCHIPEL_TEST_CONTAINER ? describe : describe.skip;

// Real attacks: the scan is deliberately bypassed, only isolation must stop them.
container('attacks from a container', () => {
  let platform;
  const user = { sub: 't', name: 't', roles: ['admin'] };

  before(async () => {
    platform = await startPlatform({
      ARCHIPEL_SANDBOX: 'container',
      ARCHIPEL_CONTROLLER_TIMEOUT_MS: '4000',
      ARCHIPEL_SANDBOX_MEMORY_MB: '64',
    });
  });
  after(async () => {
    await platform.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  function mount(code, permissions = {}) {
    const id = `rel${randomBytes(6).toString('hex')}`;
    const root = join(platform.dir, 'releases', id, 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'go.js'), code);
    shareReadOnly(root);
    const manifest = {
      id: 'attack',
      name: 'attack',
      version: '1.0.0',
      permissions,
      controllers: [{ path: 'GET /go', handler: './go.js' }],
    };
    return platform.registry.mountRelease({ id, app_id: 'attack', manifest }, { preview: true });
  }

  const attack = (code: string, permissions?: object) =>
    platform.registry.dispatch(mount(code, permissions), { method: 'GET', path: '/go', user });

  test('runs without privileges or capabilities', async () => {
    const { status, body } = await attack(`
      import { readFileSync } from 'node:fs';
      export default () => ({
        uid: process.getuid(),
        caps: /CapEff:\\s*(\\w+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1],
        noNewPrivs: /NoNewPrivs:\\s*(\\d)/.exec(readFileSync('/proc/self/status', 'utf8'))[1],
      });`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body, { uid: 65534, caps: '0000000000000000', noNewPrivs: '1' });
  });

  test('sees neither the host secrets nor its environment', async () => {
    const { body } = await attack(`
      import { existsSync } from 'node:fs';
      export default (ctx) => ({
        secret: existsSync(${JSON.stringify(join(platform.dir, 'secret'))}),
        data: existsSync(${JSON.stringify(platform.dir)}),
        env: Object.keys(process.env).filter((name) => /ARCHIPEL|OIDC|DB_/.test(name)),
      });`);
    assert.deepEqual(body, { secret: false, data: false, env: [] });
  });

  test('cannot write to its code or to disk', async () => {
    const { body } = await attack(`
      import { writeFileSync } from 'node:fs';
      const attempt = (path) => { try { writeFileSync(path, 'x'); return 'written'; } catch (error) { return error.code; } };
      export default () => ({ code: attempt('/app/go.js'), root: attempt('/x'), etc: attempt('/etc/passwd') });`);
    assert.deepEqual(body, { code: 'EROFS', root: 'EROFS', etc: 'EROFS' });
  });

  test('has no network, even with raw sockets', async () => {
    const { body } = await attack(`
      import net from 'node:net';
      import dns from 'node:dns/promises';
      const connect = (host, port) => new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: 1500 });
        socket.on('connect', () => { socket.destroy(); resolve('connected'); });
        socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
        socket.on('error', (error) => resolve(error.code));
      });
      export default async () => ({
        internet: await connect('1.1.1.1', 443),
        metadata: await connect('169.254.169.254', 80),
        dns: await dns.lookup('example.com').then(() => 'resolved', (error) => error.code),
        interfaces: Object.keys((await import('node:os')).networkInterfaces()).filter((name) => name !== 'lo'),
      });`);
    assert.notEqual(body.internet, 'connected');
    assert.notEqual(body.metadata, 'connected');
    assert.notEqual(body.dns, 'resolved');
    assert.deepEqual(body.interfaces, []);
  });

  test('WebSocket no longer exists, and fetch goes through the host rules', async () => {
    const { body } = await attack(`
      export default async () => ({
        socket: typeof WebSocket,
        metadata: await fetch('http://169.254.169.254/latest').then(() => 'sorti', (error) => error.message),
      });`);
    assert.equal(body.socket, 'undefined');
    assert.match(body.metadata, /Network refused/);
  });

  test('a fork bomb hits the process limit', async () => {
    const { body, status } = await attack(`
      import { spawn } from 'node:child_process';
      export default async () => {
        let started = 0;
        let refused = 0;
        for (let index = 0; index < 200; index += 1) {
          await new Promise((resolve) => {
            const child = spawn('sleep', ['30']);
            child.on('spawn', () => { started += 1; resolve(); });
            child.on('error', () => { refused += 1; resolve(); });
          });
        }
        return { started, refused };
      };`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.refused > 0, JSON.stringify(body));
    assert.ok(body.started < 64, JSON.stringify(body));
  });

  test('an infinite loop is cut and the container removed', async () => {
    const target = mount('export default (ctx) => { if (ctx.query.spin) while (true); return "ok"; };');
    const stuck = await platform.registry.dispatch(target, { method: 'GET', path: '/go', query: { spin: '1' }, user });
    assert.equal(stuck.status, 504);
    const next = await platform.registry.dispatch(target, { method: 'GET', path: '/go', user });
    assert.deepEqual([next.status, next.body], [200, 'ok']);
  });

  test('memory saturation does not reach the platform', async () => {
    const target = mount(`export default (ctx) => {
      if (!ctx.query.fill) return 'ok';
      const kept = [];
      while (true) kept.push(Buffer.alloc(1024 * 1024, 1).toString('latin1'));
    };`);
    const crashed = await platform.registry.dispatch(target, { method: 'GET', path: '/go', query: { fill: '1' }, user });
    assert.ok([500, 504].includes(crashed.status), String(crashed.status));
    const next = await platform.registry.dispatch(target, { method: 'GET', path: '/go', user });
    assert.deepEqual([next.status, next.body], [200, 'ok']);
    assert.equal((await platform.app.inject({ url: '/health' })).statusCode, 200);
  });

  test('an endless stream of logs is capped', async () => {
    const target = mount(
      'export default () => { for (let i = 0; i < 5000; i += 1) console.log("x".repeat(100)); return "ok"; };',
    );
    const response = await platform.registry.dispatch(target, { method: 'GET', path: '/go', user });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const logs = await platform.store.logs(target.releaseId, 2000);
    assert.ok(logs.length <= platform.config.limits.logsPerMinute + 1, String(logs.length));
  });

  test('no container survives the stop', async () => {
    const { sandbox } = platform.config;
    platform.registry.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const left = execFileSync(sandbox.engine, ['ps', '-q', '--filter', 'name=archipel-attack']).toString().trim();
    assert.equal(left, '');
  });
});
