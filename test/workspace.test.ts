import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const path = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const scripts = (file: string): Record<string, string> => JSON.parse(readFileSync(path(file), 'utf8')).scripts ?? {};

test('the server only starts from the root, where data/ is', () => {
  const { dev, start } = scripts('package.json');
  assert.match(dev, /packages\/server\/src\/main\.ts/);
  assert.match(start, /packages\/server\/dist\/main\.js/);
  assert.deepEqual(Object.keys(scripts('packages/server/package.json')), []);
});

test('the server commands point to files that exist', () => {
  for (const script of ['dev', 'token', 'rotate-secret', 'audit-verify']) {
    assert.ok(existsSync(path(/\S+\.ts$/.exec(scripts('package.json')[script] ?? '')?.[0] ?? '')), script);
  }
});

test('the old CLI path stays valid for MCP configurations', () => {
  assert.match(readFileSync(path('agent/cli.js'), 'utf8'), /packages\/cli\/dist\/cli\.js/);
});
