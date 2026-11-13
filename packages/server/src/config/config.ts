import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readInstance } from './instance.js';

type Env = Record<string, string | undefined>;
export type AuthMode = 'dev' | 'oidc' | 'setup';

interface IdentityFields {
  issuer?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scopes?: string | undefined;
  groupsClaim?: string | undefined;
  adminGroup?: string | undefined;
  providerName?: string | undefined;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// An http provider is only accepted on the machine itself, or on explicit request.
export const isLoopbackUrl = (value: string) => LOOPBACK.has(new URL(value).hostname);

// Storage only: what is needed to administer the database from the server, without OIDC.
// The environment takes precedence over the interface settings.
export function loadStorage(env: Env = process.env) {
  const dataDir = resolve(env.ARCHIPEL_DATA_DIR || './data');
  mkdirSync(join(dataDir, 'releases'), { recursive: true });
  lockDown(dataDir);
  const masterKey = loadMasterKey(env);
  const instance = readInstance(dataDir, masterKey);
  return {
    dataDir,
    masterKey,
    secrets: loadSecrets(env, dataDir),
    instance,
    defaultDatabase: join(dataDir, 'archipel.db'),
    db: {
      client: env.DB_CLIENT || instance.db?.client || 'better-sqlite3',
      connection: env.DB_URL || instance.db?.url || join(dataDir, 'archipel.db'),
    },
  };
}

// Nothing in `data/` needs to be read by another account on the machine, including on an instance already installed.
function lockDown(dataDir: string) {
  chmodSync(dataDir, 0o700);
  for (const file of ['secret', 'instance.json', 'archipel.db', 'archipel.db-wal', 'archipel.db-shm']) {
    const path = join(dataDir, file);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

// Trusting any proxy would make `X-Forwarded-For` forgeable, and with it the audit and the rate limits.
// Fastify ignores a hop count: only the direct peer, checked by its address, can be believed.
function parseTrustProxy(value: string | undefined) {
  if (!value) return false;
  if (value === 'true' || /^\d+$/.test(value)) {
    throw new Error('ARCHIPEL_TRUST_PROXY: list the addresses of your proxies, separated by commas (10.0.0.2, 172.16.0.0/12).');
  }
  return value;
}

function loadMasterKey(env: Env) {
  const source = env.ARCHIPEL_MASTER_KEY_FILE
    ? readFileSync(env.ARCHIPEL_MASTER_KEY_FILE, 'utf8').trim()
    : env.ARCHIPEL_MASTER_KEY;
  if (!source) return null;
  const key = /^[0-9a-f]{64}$/i.test(source) ? Buffer.from(source, 'hex') : Buffer.from(source, 'base64');
  if (key.length !== 32)
    throw new Error('ARCHIPEL_MASTER_KEY must be 32 bytes, in hexadecimal or base64 (openssl rand -hex 32).');
  return key;
}

function identityFromEnv(env: Env): IdentityFields {
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES,
    groupsClaim: env.OIDC_GROUPS_CLAIM,
    adminGroup: env.OIDC_ADMIN_GROUP,
    providerName: env.OIDC_PROVIDER_NAME,
  };
}

// Defaults shared by the environment and the interface.
export const withIdentityDefaults = <T extends IdentityFields>(identity: T) => ({
  ...identity,
  scopes: identity.scopes || 'openid profile email groups',
  groupsClaim: identity.groupsClaim || 'groups',
  adminGroup: identity.adminGroup || 'archipel-admin',
});

const SANDBOX_IMAGE = 'node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914';

function sandboxFromEnv(env: Env, dev: boolean, { allowProcessSandbox }: { allowProcessSandbox: boolean }) {
  const mode = env.ARCHIPEL_SANDBOX || (dev ? 'process' : 'container');
  if (mode !== 'process' && mode !== 'container') throw new Error('ARCHIPEL_SANDBOX must be process or container.');
  // Deliberately without an environment variable: a production configuration cannot get it.
  if (mode === 'process' && !dev && !allowProcessSandbox) {
    throw new Error('ARCHIPEL_SANDBOX=process is reserved for `npm run dev`: app code must run in a container.');
  }
  return {
    mode,
    engine: env.ARCHIPEL_SANDBOX_ENGINE || null,
    image: env.ARCHIPEL_SANDBOX_IMAGE || SANDBOX_IMAGE,
    runtime: env.ARCHIPEL_SANDBOX_RUNTIME || null,
    cpus: Number(env.ARCHIPEL_SANDBOX_CPUS || 1),
    pids: Number(env.ARCHIPEL_SANDBOX_PIDS || 64),
  };
}

export function loadConfig(env: Env = process.env, { allowProcessSandbox = false } = {}) {
  const { dataDir, db, instance, defaultDatabase, masterKey, secrets } = loadStorage(env);

  const host = env.HOST || '127.0.0.1';
  const dev = env.ARCHIPEL_AUTH === 'dev';

  if (dev && !LOOPBACK.has(host)) {
    throw new Error('ARCHIPEL_AUTH=dev is reserved for a local listener: remove it or use HOST=127.0.0.1.');
  }

  const identityLocked = Boolean(env.OIDC_ISSUER);
  const stored = instance.oidc ?? {};
  const identity = withIdentityDefaults<IdentityFields>(identityLocked ? identityFromEnv(env) : stored);
  const configured = Boolean(identity.issuer && identity.clientId);

  const port = Number(env.PORT || 3000);
  const mode: AuthMode = dev ? 'dev' : configured ? 'oidc' : 'setup';
  return {
    dataDir,
    masterKey,
    defaultDatabase,
    instance,
    locks: {
      identity: identityLocked,
      database: Boolean(env.DB_CLIENT || env.DB_URL),
      publicUrl: Boolean(env.ARCHIPEL_PUBLIC_URL),
    },
    host,
    port,
    allowHttpIssuer: env.OIDC_ALLOW_HTTP === '1',
    trustProxy: parseTrustProxy(env.ARCHIPEL_TRUST_PROXY),
    publicUrl: (env.ARCHIPEL_PUBLIC_URL || stored.publicUrl || `http://${host}:${port}`).replace(/\/$/, ''),
    secrets,
    db,
    auth: {
      // `setup`: no provider yet, nobody can sign in until setup is done.
      mode,
      ...identity,
      allowInsecureIssuer: env.OIDC_ALLOW_HTTP === '1' || Boolean(configured && isLoopbackUrl(identity.issuer!)),
    },
    limits: {
      uploadBytes: Number(env.ARCHIPEL_UPLOAD_MAX_MB || 50) * 1024 * 1024,
      controllerTimeoutMs: Number(env.ARCHIPEL_CONTROLLER_TIMEOUT_MS || 10_000),
      controllerConcurrency: Number(env.ARCHIPEL_CONTROLLER_CONCURRENCY || 16),
      sandboxMemoryMb: Number(env.ARCHIPEL_SANDBOX_MEMORY_MB || 128),
      sandboxIdleMs: Number(env.ARCHIPEL_SANDBOX_IDLE_MS || 5 * 60_000),
      sandboxStartMs: Number(env.ARCHIPEL_SANDBOX_START_MS || 15_000),
      fetchBytes: Number(env.ARCHIPEL_FETCH_MAX_MB || 5) * 1024 * 1024,
      logsPerMinute: Number(env.ARCHIPEL_LOGS_PER_MINUTE || 600),
      hostCallsPerMinute: Number(env.ARCHIPEL_HOST_CALLS_PER_MINUTE || 12_000),
      tableRows: Number(env.ARCHIPEL_TABLE_MAX_ROWS || 1_000_000),
      extractedBytes: Number(env.ARCHIPEL_EXTRACT_MAX_MB || 200) * 1024 * 1024,
      extractedFiles: Number(env.ARCHIPEL_EXTRACT_MAX_FILES || 5000),
      requestsPerMinute: Number(env.ARCHIPEL_RATE_LIMIT ?? 1200),
      pipelinesAtOnce: Number(env.ARCHIPEL_PIPELINES_AT_ONCE || 2),
      pipelineQueue: Number(env.ARCHIPEL_PIPELINE_QUEUE || 20),
    },
    gitProtocols: env.ARCHIPEL_GIT_PROTOCOLS || 'https',
    sandbox: sandboxFromEnv(env, dev, { allowProcessSandbox }),
  };
}

const MIN_SECRET_LENGTH = 32;
const newSecret = () => randomBytes(32).toString('hex');

function writeSecrets(dataDir: string, secrets: string[]) {
  const file = join(dataDir, 'secret');
  writeFileSync(`${file}.tmp`, `${secrets.join('\n')}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// The first key signs, the next ones only verify: a rotation does not cut any token in use.
function loadSecrets(env: Env, dataDir: string) {
  if (env.ARCHIPEL_SECRET) {
    const secrets = [env.ARCHIPEL_SECRET, ...(env.ARCHIPEL_SECRET_PREVIOUS ? [env.ARCHIPEL_SECRET_PREVIOUS] : [])];
    if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
      throw new Error(`ARCHIPEL_SECRET must be at least ${MIN_SECRET_LENGTH} characters long (openssl rand -hex 32).`);
    }
    return secrets;
  }
  const file = join(dataDir, 'secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const secret = newSecret();
  writeSecrets(dataDir, [secret]);
  return [secret];
}

export function rotateSecret(dataDir: string) {
  const [current] = loadSecrets({}, dataDir) as [string];
  writeSecrets(dataDir, [newSecret(), current]);
}
