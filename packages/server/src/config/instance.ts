import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Settings changed from the interface. They live outside the database because they must be read
// before opening it, and they contain secrets: same treatment as `data/secret`.
const FILE = 'instance.json';

export interface Launchpad {
  name: string;
  title: string;
  welcome: string;
  loginMessage: string;
  accent: string;
  background: string;
  showGroups: boolean;
  openMode: string;
  logo: string | null;
}

export interface Instance {
  launchpad?: Launchpad;
  oidc?: {
    issuer?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
    groupsClaim?: string;
    adminGroup?: string;
    providerName?: string;
    publicUrl?: string;
  };
  db?: { client: string; url?: string };
  setup?: { completedAt: string; by: string };
}

type Sealable = Record<string, Record<string, string | undefined> | undefined>;

export const ACCENTS: Record<string, string> = {
  ocean: '#1e55cc',
  lagon: '#0a6b7c',
  foret: '#1d6b46',
  corail: '#b23c24',
  prune: '#6b3fa0',
  ardoise: '#3d5163',
};

const LIMITS = { name: 40, title: 40, welcome: 200, loginMessage: 200 };
const LOGO_MAX_BYTES = 256 * 1024;

export const DEFAULT_LAUNCHPAD: Launchpad = {
  name: 'Archipel',
  title: 'Launchpad',
  welcome: '',
  loginMessage: '',
  accent: 'ocean',
  background: 'islands',
  showGroups: true,
  openMode: 'embedded',
  logo: null,
};

// Fields encrypted when a master key is provided: the file alone then gives nothing away.
const SEALED = [
  ['oidc', 'clientSecret'],
  ['db', 'url'],
] as const;
const SEALED_PREFIX = 'enc:v1:';

function seal(value: string, key: Buffer, label: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(label));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${SEALED_PREFIX}${[iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join(':')}`;
}

function unseal(value: string, key: Buffer | null, label: string) {
  if (!key) throw new Error(`${label} is encrypted: provide ARCHIPEL_MASTER_KEY.`);
  const [iv, tag, body] = value
    .slice(SEALED_PREFIX.length)
    .split(':')
    .map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(label)).setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`${label} cannot be decrypted: ARCHIPEL_MASTER_KEY is not the right key.`);
  }
}

const isSealed = (value: unknown) => typeof value === 'string' && value.startsWith(SEALED_PREFIX);

function mapSealed(instance: Instance, transform: (value: string, label: string) => string): Instance {
  const copy = structuredClone(instance);
  for (const [section, field] of SEALED) {
    const part = (copy as Sealable)[section];
    const value = part?.[field];
    if (part && value) part[field] = transform(value, `${section}.${field}`);
  }
  return copy;
}

const readRaw = (path: string): Instance => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Instance;
  } catch (error) {
    throw new Error(`${path} is unreadable (${(error as Error).message}): fix or remove this file.`, { cause: error });
  }
};

export function readInstance(dataDir: string, key: Buffer | null = null): Instance {
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return {};
  const instance = mapSealed(readRaw(path), (value, label) => (isSealed(value) ? unseal(value, key, label) : value));
  // A key added later also protects what was already written.
  if (key && hasPlainSecrets(dataDir)) writeInstance(dataDir, instance, key);
  return instance;
}

export function hasPlainSecrets(dataDir: string) {
  const path = join(dataDir, FILE);
  if (!existsSync(path)) return false;
  const raw = readRaw(path) as Sealable;
  return SEALED.some(([section, field]) => raw[section]?.[field] && !isSealed(raw[section]?.[field]));
}

// Atomic write: a stop halfway does not leave an instance without configuration.
export function writeInstance(dataDir: string, instance: Instance, key: Buffer | null = null) {
  const path = join(dataDir, FILE);
  const pending = `${path}.tmp`;
  const stored = key ? mapSealed(instance, (value, label) => seal(value, key, label)) : instance;
  writeFileSync(pending, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

export const launchpadOf = (instance: Instance): Launchpad => ({ ...DEFAULT_LAUNCHPAD, ...instance.launchpad });

class InvalidSetting extends Error {
  statusCode = 400;
}

type LaunchpadInput = Record<string, unknown>;

function text(input: LaunchpadInput, key: keyof typeof LIMITS, current: Launchpad) {
  const value = input[key];
  if (value === undefined) return current[key];
  if (typeof value !== 'string') throw new InvalidSetting(`Invalid field ${key}`);
  const trimmed = value.trim();
  if (trimmed.length > LIMITS[key]) throw new InvalidSetting(`Field ${key} too long: ${LIMITS[key]} characters at most`);
  return trimmed;
}

const choice = (input: LaunchpadInput, key: 'accent' | 'background' | 'openMode', current: Launchpad, allowed: string[]) => {
  const value = input[key] ?? current[key];
  if (typeof value !== 'string' || !allowed.includes(value)) throw new InvalidSetting(`Invalid field ${key}`);
  return value;
};

// The type comes from the first bytes and never from the browser: an SVG could carry script.
export function logoType(bytes: Buffer) {
  if (bytes.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (bytes.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function decodeLogo(dataUrl: string) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return { bytes, type: logoType(bytes) };
}

function normalizeLogo(value: unknown, current: string | null) {
  if (value === undefined) return current;
  if (value === null) return null;
  if (typeof value !== 'string' || !/^data:[\w/+.-]+;base64,/.test(value)) throw new InvalidSetting('Invalid logo');
  const { bytes, type } = decodeLogo(value);
  if (bytes.length > LOGO_MAX_BYTES) throw new InvalidSetting('Logo too large: 256 KB at most');
  if (!type) throw new InvalidSetting('Logo refused: use a PNG, JPEG or WebP image');
  return `data:${type};base64,${bytes.toString('base64')}`;
}

export function normalizeLaunchpad(given: unknown, current: Launchpad): Launchpad {
  if (typeof given !== 'object' || given === null) throw new InvalidSetting('Invalid launchpad settings');
  const input = given as LaunchpadInput;
  const name = text(input, 'name', current);
  if (!name) throw new InvalidSetting('The platform name is required');
  return {
    name,
    title: text(input, 'title', current) || DEFAULT_LAUNCHPAD.title,
    welcome: text(input, 'welcome', current),
    loginMessage: text(input, 'loginMessage', current),
    accent: choice(input, 'accent', current, Object.keys(ACCENTS)),
    background: choice(input, 'background', current, ['islands', 'plain']),
    showGroups: Boolean(input.showGroups ?? current.showGroups),
    openMode: choice(input, 'openMode', current, ['embedded', 'tab']),
    logo: normalizeLogo(input.logo, current.logo),
  };
}
