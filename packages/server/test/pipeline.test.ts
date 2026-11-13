import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform } from '../src/platform.js';
import { loadConfig } from '../src/config/config.js';
import { writeInstance } from '../src/config/instance.js';
import type { Release } from '../src/types.js';

const SAMPLE = fileURLToPath(new URL('../../../samples/customers', import.meta.url));

describe('deployment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-loader-'));
  let platform: Awaited<ReturnType<typeof createPlatform>>;
  let cookie = '';

  beforeAll(async () => {
    writeInstance(dir, { setup: { completedAt: new Date().toISOString(), by: 'test' } });
    const env = { ARCHIPEL_AUTH: 'dev', ARCHIPEL_DATA_DIR: dir, ARCHIPEL_SANDBOX: 'process' };
    platform = await createPlatform(loadConfig(env, { allowProcessSandbox: true }));
    const session = (await platform.app.inject({ url: '/auth/local' })).cookies.find(({ name }) =>
      name.endsWith('archipel_session'),
    )!;
    cookie = `${session.name}=${session.value}`;
  });

  afterAll(async () => {
    await platform.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function deploy(edit?: (root: string) => void): Promise<Release> {
    const { pipeline, store } = platform;
    const { id, done } = await pipeline.submit({
      sourceType: 'archive',
      sourceLabel: 'customers.tgz',
      user: { name: 'agent:test' },
      prepare: async (workdir) => {
        const root = join(workdir, 'app');
        cpSync(SAMPLE, root, { recursive: true });
        edit?.(root);
        return { root, sourceInfo: { type: 'archive' } };
      },
    });
    await done;
    return (await store.getRelease(id))!;
  }

  const stages = (release: Release) => release.report.stages?.map(({ id, status }) => `${id}:${status}`);

  it('goes through every stage and waits for a human decision', async () => {
    const release = await deploy();
    expect(release.status).toBe('in_review');
    expect(stages(release)).toEqual(['validate:ok', 'scan:ok', 'diff:ok', 'preview:ok', 'checks:ok']);
    expect(release.report.checks?.ok).toBe(true);
    expect((await platform.store.getApp('customers'))?.live_release_id).toBeNull();
  });

  it('stops at validation without running anything, and the report says what to fix', async () => {
    const release = await deploy((root) => writeFileSync(join(root, 'app.manifest.yaml'), 'manifest: 1\nid: Tickets\n'));
    expect(release.status).toBe('failed');
    expect(stages(release)).toEqual(['validate:failed']);
    expect(release.report.validation?.errors.every(({ path, hint }) => path && hint)).toBe(true);
  });

  it('the scan blocks a controller importing child_process before any execution', async () => {
    const release = await deploy((root) =>
      writeFileSync(join(root, 'extra.js'), "import 'node:child_process';\nexport default () => null;\n"),
    );
    expect(release.status).toBe('failed');
    expect(stages(release)?.at(-1)).toBe('scan:failed');
    expect(platform.registry.get(release.id)).toBeUndefined();
  });

  it('a route refuses an extra field with the path and a fix', async () => {
    const response = await platform.app.inject({
      method: 'POST',
      url: '/api/releases/git',
      headers: { cookie, origin: 'http://127.0.0.1:3000' },
      payload: { url: 'https://example.com/a.git', branch: 'main' },
    });
    expect(response.statusCode).toBe(400);
    const [issue] = response.json<{ issues: { path: string; hint: string; message: string }[] }>().issues;
    expect(issue?.message).toContain('branch');
    expect(issue?.hint).toBeTruthy();
    expect(issue?.path).toMatch(/^body/);
  });

  it('a route response follows the published contract', async () => {
    const response = await platform.app.inject({ url: '/api/openapi.json', headers: { cookie } });
    const { paths } = response.json<{ paths: Record<string, Record<string, { responses: Record<string, unknown> }>> }>();
    expect(Object.keys(paths['/api/releases/{id}']?.get?.responses ?? {})).toContain('200');
    expect(paths['/api/settings']?.put).toBeDefined();
  });
});
