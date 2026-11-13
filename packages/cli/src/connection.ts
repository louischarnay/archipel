import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Env = Record<string, string | undefined>;

export interface Connection {
  url?: string | undefined;
  token?: string | undefined;
  source: 'env' | 'file' | 'none';
}

// One file per account, outside any project: the token never ends up in a repository or in `.mcp.json`.
export const connectionFile = (env: Env = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'archipel', 'config.json');

// The environment wins, but as a whole: a token from the file never goes to an address that came from elsewhere.
export function resolveConnection(env: Env = process.env): Connection {
  if (env.ARCHIPEL_URL || env.ARCHIPEL_TOKEN) return { url: env.ARCHIPEL_URL, token: env.ARCHIPEL_TOKEN, source: 'env' };
  try {
    const { url, token } = JSON.parse(readFileSync(connectionFile(env), 'utf8')) as { url?: unknown; token?: unknown };
    if (typeof url === 'string' && typeof token === 'string') return { url, token, source: 'file' };
  } catch {
    // No saved connection yet.
  }
  return { source: 'none' };
}

export function saveConnection({ url, token }: { url: string; token: string }, env: Env = process.env) {
  const file = connectionFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(draft, 0o600);
  renameSync(draft, file);
  return file;
}

export function forgetConnection(env: Env = process.env) {
  const file = connectionFile(env);
  rmSync(file, { force: true });
  return file;
}
