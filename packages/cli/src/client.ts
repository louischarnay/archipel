import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  appOpenApi,
  generateTypes,
  MANIFEST_FILE,
  parseManifest,
  validateManifest,
  type Manifest,
  type ValidationIssue,
} from '@archipel/manifest-schema';
import { create } from 'tar';
import { resolveConnection } from './connection.js';
import { checkTypes } from './typecheck.js';

const POLL_MS = 500;
const TYPES_FILE = 'app.types.d.ts';
const DEFAULT_DEPLOY_TIMEOUT_S = 300;
const RELEASE_ID = /^rel[0-9a-f]{12}$/;
const EXCLUDED = /(^|\/)(\.git|node_modules|\.DS_Store|\.env(\.[^/]*)?|\.mcp\.json)(\/|$)/;

export const EXIT = { ok: 0, failed: 1, error: 2, awaitingHuman: 3 };

export class AgentError extends Error {}

export interface LocalValidation {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

type ReleaseStatus = 'processing' | 'failed' | 'in_review' | 'changes_requested' | 'rejected' | 'live' | 'superseded';

interface LogLine {
  level: string;
  message: string;
  at: string;
}

interface Release {
  id: string;
  app_id: string | null;
  version: string | null;
  status: ReleaseStatus;
  previewUrl: string | null;
  logs: LogLine[];
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: FormData | string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Local validation: without a server, so without the rules that depend on other apps (routes, shared tables).
export function validate(dir: string): LocalValidation {
  const root = resolve(dir);
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST_FILE), 'utf8');
  } catch {
    throw new AgentError(`No ${MANIFEST_FILE} in ${root}`);
  }
  const { manifest, errors } = parseManifest(text);
  const { errors: invalid, warnings } = errors.length ? { errors, warnings: [] } : validateManifest(manifest, root);
  if (invalid.length) return { valid: false, errors: invalid, warnings };
  const types = checkTypes(root);
  const allErrors = [...invalid, ...types.errors];
  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: [...warnings, ...types.warnings, ...staleTypes(root, manifest)],
  };
}

function staleTypes(root: string, manifest: unknown): ValidationIssue[] {
  const file = join(root, TYPES_FILE);
  if (!existsSync(file) || readFileSync(file, 'utf8') === generateTypes(manifest as Manifest)) return [];
  return [{ path: TYPES_FILE, message: 'Types are behind the manifest', hint: 'Run "archipel types" again.' }];
}

// An invalid manifest produces nothing: the types and the contract would describe an app that will not deploy.
function validManifest(
  dir: string,
): { manifest: Manifest; invalid?: undefined } | { manifest?: undefined; invalid: LocalValidation } {
  const result = validate(dir);
  if (!result.valid) return { invalid: result };
  return { manifest: parseManifest(readFileSync(join(resolve(dir), MANIFEST_FILE), 'utf8')).manifest as Manifest };
}

export function writeTypes(dir: string, out = TYPES_FILE) {
  const { manifest, invalid } = validManifest(dir);
  if (invalid) return { written: false, validation: invalid };
  const file = resolve(dir, out);
  writeFileSync(file, generateTypes(manifest));
  return { written: true, file, tables: Object.keys(manifest.tables ?? {}) };
}

export function openApi(dir: string) {
  const { manifest, invalid } = validManifest(dir);
  return invalid ? { written: false, validation: invalid } : appOpenApi(manifest);
}

// The status says where the version stands; `next` tells the agent what it can do about it.
function describe(release: Release, base: string) {
  const absolute = (path: string | null) => (path ? `${base}${path}` : null);
  const next: Record<ReleaseStatus, string> = {
    processing: 'The pipeline is still running.',
    failed: 'Fix what the report shows (validation, scan, checks), then deploy again.',
    in_review: 'A person must decide in Review: promote reports this wait, it does not bypass it.',
    changes_requested: 'Read decision_comment, fix, then deploy again.',
    rejected: 'Version rejected: read decision_comment.',
    live: 'Version live.',
    superseded: 'Version replaced by another one.',
  };
  return {
    ...release,
    previewUrl: absolute(release.previewUrl),
    reviewUrl: `${base}/#/review/${release.id}`,
    next: next[release.status],
  };
}

export type Client = ReturnType<typeof createClient>;

export interface AgentIdentity {
  id: string;
  name: string;
  apps: string[] | null;
}

export function createClient({ url, token }: { url?: string | undefined; token?: string | undefined } = resolveConnection()) {
  const base = url?.replace(/\/$/, '');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON response from the server, described by its OpenAPI contract
  async function request(path: string, options: RequestOptions = {}): Promise<any> {
    if (!base || !token) {
      throw new AgentError(
        'No connection to Archipel: run "archipel login <address>" with a token a person created in Settings > Agents, or set ARCHIPEL_URL and ARCHIPEL_TOKEN.',
      );
    }
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${token}` },
      });
    } catch (failure) {
      const error = failure as Error & { cause?: Error };
      throw new AgentError(`Server unreachable (${base}): ${error.cause?.message ?? error.message}`);
    }
    const body = (await response.json().catch(() => null)) as ({ error?: string } & Record<string, unknown>) | null;
    if (!response.ok) throw new AgentError(body?.error ?? `Error ${response.status} on ${path}`);
    return body;
  }

  const report = async (id: string) => describe((await request(`/api/releases/${encodeURIComponent(id)}`)) as Release, base!);

  // Waits until a version leaves the given statuses. At the deadline, it is returned as it is.
  async function waitWhile(id: string, statuses: ReleaseStatus[], timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const release = await report(id);
      if (!statuses.includes(release.status) || Date.now() >= deadline) return release;
      await sleep(POLL_MS);
    }
  }

  async function latestRelease(appId: string): Promise<string> {
    const { releases } = (await request(`/api/releases?app=${encodeURIComponent(appId)}`)) as { releases: Release[] };
    const [latest] = releases;
    if (!latest) throw new AgentError(`No version of ${appId} submitted with this token`);
    return latest.id;
  }

  async function upload(root: string): Promise<{ id: string }> {
    const folder = mkdtempSync(join(tmpdir(), 'archipel-deploy-'));
    const file = join(folder, 'app.tgz');
    try {
      await create({ gzip: true, file, cwd: root, filter: (path) => !EXCLUDED.test(path) }, ['.']);
      const form = new FormData();
      form.append('archive', new Blob([readFileSync(file)], { type: 'application/gzip' }), `${basename(root)}.tgz`);
      return await request('/api/releases/archive', { method: 'POST', body: form });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  return {
    report,

    me: () => request('/api/agent/me') as Promise<AgentIdentity>,

    async deploy(dir: string, { timeoutSeconds = DEFAULT_DEPLOY_TIMEOUT_S }: { timeoutSeconds?: number | undefined } = {}) {
      const local = validate(dir);
      if (!local.valid) return { status: 'invalid', validation: local, next: 'Fix the manifest: nothing was sent.' };
      const { id } = await upload(resolve(dir));
      return waitWhile(id, ['processing'], timeoutSeconds);
    },

    async logs(target: string, { level }: { level?: string | undefined } = {}) {
      const id = RELEASE_ID.test(target) ? target : await latestRelease(target);
      const { logs, status, version, app_id } = await report(id);
      return { id, app_id, version, status, logs: level ? logs.filter((line) => line.level === level) : logs };
    },

    schema: (appId: string) => request(`/api/apps/${encodeURIComponent(appId)}/schema`),

    // Only reads: the decision belongs to a person, and this client has no way to take it.
    async promote(id: string, { waitSeconds = 0 }: { waitSeconds?: number | undefined } = {}) {
      const release = await waitWhile(id, waitSeconds ? ['processing', 'in_review'] : ['processing'], waitSeconds);
      return { ...release, promoted: release.status === 'live', awaiting_human: release.status === 'in_review' };
    },

    async rollback(appId: string, { releaseId, reason }: { releaseId?: string | undefined; reason?: string | undefined } = {}) {
      const { target } = await request(`/api/apps/${encodeURIComponent(appId)}/rollback-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ releaseId, reason }),
      });
      return {
        requested: true,
        rolled_back: false,
        awaiting_human: true,
        target,
        next: "Request shown in Activity: a person puts the version back online from the app's page.",
      };
    },
  };
}
