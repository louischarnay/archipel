import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { create } from 'tar';
import { safeReturnTo } from '../packages/server/src/auth/return-to.js';
import { extractArchive, IntakeError } from '../packages/server/src/pipeline/intake.js';
import { scanRelease } from '../packages/server/src/pipeline/scan.js';
import { installLive, sampleCopy, startPlatform } from './helpers.js';

const workdir = () => mkdtempSync(join(tmpdir(), 'archipel-hardening-'));
const SMALL = { extractedBytes: 1024 * 1024, extractedFiles: 20 };

describe('redirect after sign-in', () => {
  test('refuses anything a browser would read as another site', () => {
    for (const value of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r\\evil.example',
      'https://evil.example',
      'evil',
      null,
    ]) {
      const target = safeReturnTo(value);
      assert.equal(new URL(target, 'https://archipel.example').host, 'archipel.example', JSON.stringify(value));
    }
  });

  test('keeps local paths', () => {
    assert.equal(safeReturnTo('/#/review'), '/#/review');
    assert.equal(safeReturnTo('/tickets/?id=1'), '/tickets/?id=1');
  });
});

describe('scan', () => {
  function scan(files: Record<string, string>) {
    const root = workdir();
    mkdirSync(join(root, 'api'));
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return scanRelease(root, {
      manifest: 1,
      id: 'scan',
      name: 'Scan',
      version: '1.0.0',
      controllers: [{ path: 'GET /run', handler: 'api/run.js' }],
      frontend: { dir: 'web', route: '/run' },
    });
  }

  test('follows the code imported by a controller', () => {
    const { blocked, findings } = scan({
      'api/run.js': "import './helper.js';\nexport default () => 1;",
      'api/helper.js': "import { readFileSync } from 'node:fs';",
    });
    assert.equal(blocked, true);
    assert.equal(findings[0].file, 'api/helper.js');
  });

  for (const [name, code] of [
    ['a computed import', "await import('no' + 'de:net');"],
    ['a template import', 'await import(`node:${x}`);'],
    ['getBuiltinModule', "process.getBuiltinModule('f' + 's');"],
    ['a computed access to process', 'process[name];'],
    ['a WebSocket', "new WebSocket('ws://169.254.169.254');"],
  ]) {
    test(`blocks ${name}`, () => assert.equal(scan({ 'api/run.js': code }).blocked, true));
  }

  test('accepts a local literal import', () => {
    assert.equal(scan({ 'api/run.js': "const m = await import('./local.js');" }).blocked, false);
  });

  test('reports a frontend bundle without blocking', () => {
    const { blocked, findings } = scan({ 'web/bundle.js': 'eval(code);' });
    assert.equal(blocked, false);
    assert.equal(findings[0].severity, 'warn');
  });
});

describe('archive bombs', () => {
  const big = Buffer.alloc(3 * 1024 * 1024);

  test('refuses a zip too large once extracted', async () => {
    const file = join(workdir(), 'a.zip');
    const zip = new AdmZip();
    zip.addFile('app.manifest.yaml', Buffer.from('x'));
    zip.addFile('big.bin', Buffer.from(big.map(() => Math.random() * 256)));
    zip.writeZip(file);
    await assert.rejects(extractArchive(file, 'a.zip', workdir(), SMALL), /too large/);
  });

  test('refuses a zip with an abnormal compression ratio before writing it', async () => {
    const file = join(workdir(), 'a.zip');
    const zip = new AdmZip();
    zip.addFile('bomb.bin', big);
    zip.writeZip(file);
    const target = workdir();
    await assert.rejects(extractArchive(file, 'a.zip', target), /Abnormal compression/);
    assert.equal(existsSync(join(target, 'bomb.bin')), false);
  });

  test('refuses a zip containing too many files', async () => {
    const file = join(workdir(), 'a.zip');
    const zip = new AdmZip();
    for (let index = 0; index < 30; index += 1) zip.addFile(`f${index}.txt`, Buffer.from('x'));
    zip.writeZip(file);
    await assert.rejects(extractArchive(file, 'a.zip', workdir(), SMALL), /too many files/);
  });

  test('refuses a tgz too large once extracted', async () => {
    const source = workdir();
    writeFileSync(join(source, 'big.bin'), big);
    const file = join(workdir(), 'a.tgz');
    await create({ gzip: true, file, cwd: source }, ['.']);
    await assert.rejects(extractArchive(file, 'a.tgz', workdir(), SMALL), /too large/);
  });

  test('refuses a tgz containing too many files', async () => {
    const source = workdir();
    for (let index = 0; index < 30; index += 1) writeFileSync(join(source, `f${index}.txt`), 'x');
    const file = join(workdir(), 'a.tgz');
    await create({ gzip: true, file, cwd: source }, ['.']);
    await assert.rejects(extractArchive(file, 'a.tgz', workdir(), SMALL), IntakeError);
  });

  test('an unreadable archive gives a submission error', async () => {
    const file = join(workdir(), 'a.zip');
    writeFileSync(file, 'not an archive');
    await assert.rejects(extractArchive(file, 'a.zip', workdir()), IntakeError);
  });
});

describe('API inputs', () => {
  let platform;
  let api;
  let release;

  before(async () => {
    platform = await startPlatform();
    api = platform.api;
    release = await installLive(platform, sampleCopy('customers'));
  });
  after(() => platform.stop());

  test('an unexpected field is refused', async () => {
    const response = await api.post('/api/agent-tokens', { name: 'ci', admin: true });
    assert.equal(response.statusCode, 400);
  });

  test('a value of the wrong type is not converted', async () => {
    assert.equal((await api.post('/api/agent-tokens', { name: 'ci', days: '30' })).statusCode, 400);
  });

  test('a malformed version id does not leave the versions folder', async () => {
    const id = encodeURIComponent('../..');
    assert.equal((await api.get(`/api/releases/${id}/file?path=secret`)).statusCode, 400);
    assert.equal((await api.get(`/api/releases/${release.id}`)).statusCode, 200);
  });

  test('a name inherited from Object is neither a table nor a column', async () => {
    const token = await api.appToken('/customers/');
    const call = (url) => platform.app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await call('/run/customers/data/constructor')).statusCode, 403);
    assert.equal((await call('/run/customers/data/shared.customer?constructor=1')).statusCode, 400);
  });

  test('a badly encoded path is not a server error', async () => {
    const token = await api.appToken('/customers/');
    const response = await platform.app.inject({
      url: '/run/customers/data/%E0%A4%A',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 400);
  });

  test('a column stays validated by type, with a readable message', async () => {
    const token = await api.appToken('/customers/');
    const response = await platform.app.inject({
      method: 'POST',
      url: '/run/customers/data/shared.customer',
      headers: { authorization: `Bearer ${token}` },
      payload: { nope: 1 },
    });
    assert.equal(response.statusCode, 400);
    assert.ok(response.json().details.includes('Unknown field: nope'));
  });

  test('a decision without options is sent without a body', async () => {
    const cookie = (await platform.app.inject({ url: '/auth/local' })).headers['set-cookie'].split(';')[0];
    const response = await platform.app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/reject`,
      headers: { cookie, origin: platform.config.publicUrl },
    });
    assert.equal(response.statusCode, 409);
  });
});

describe('rate limits', () => {
  test('the setup code cannot be tried without limit', async () => {
    const platform = await startPlatform({ ARCHIPEL_AUTH: '' }, { fresh: true });
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await platform.api.post('/api/setup/unlock', { code: 'AAAAA-AAAAA-AAAAA' })).statusCode);
    }
    assert.equal(statuses[0], 403);
    assert.equal(statuses.at(-1), 429);
    await platform.stop();
  });

  test('the global cap answers 429 with a clear message', async () => {
    const platform = await startPlatform({ ARCHIPEL_RATE_LIMIT: '3' });
    let last;
    for (let attempt = 0; attempt < 6; attempt += 1) last = await platform.app.inject({ url: '/health' });
    assert.equal(last.statusCode, 429);
    assert.match(last.json().error, /Too many requests/);
    assert.ok(last.headers['retry-after']);
    await platform.stop();
  });
});

describe('pipeline queue', () => {
  test('submissions go one by one and a full queue answers 429', async () => {
    const platform = await startPlatform({ ARCHIPEL_PIPELINES_AT_ONCE: '1', ARCHIPEL_PIPELINE_QUEUE: '1' });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const user = { name: 'test' };
    const prepare = async () => {
      await gate;
      throw new Error('stop');
    };
    const first = await platform.pipeline.submit({ sourceType: 'archive', sourceLabel: 'a', user, prepare });
    const second = await platform.pipeline.submit({ sourceType: 'archive', sourceLabel: 'b', user, prepare });
    await assert.rejects(platform.pipeline.submit({ sourceType: 'archive', sourceLabel: 'c', user, prepare }), {
      statusCode: 429,
    });
    release();
    await Promise.all([first.done, second.done]);
    await platform.stop();
  });
});
