import { BadRequestException } from '@nestjs/common';
import pg from 'pg';
import type { Config } from '../types.js';

export const SQLITE = 'better-sqlite3';
export const POSTGRES = 'pg';
const CONNECT_TIMEOUT_MS = 5000;
const MAX_FIELD = 200;

export type Fields = Record<string, unknown> | null | undefined;
export type DatabaseTarget = { client: typeof SQLITE; url?: undefined } | { client: typeof POSTGRES; url: string };

// A text field of a settings form: trimmed, empty when absent.
export function field(input: Fields, key: string, label: string) {
  const value = input?.[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_FIELD) throw new BadRequestException(`Invalid ${label}`);
  return value.trim();
}

export function httpUrl(value: string, label: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return value.replace(/\/$/, '');
  } catch {
    // Same message as a URL with another protocol.
  }
  throw new BadRequestException(`${label}: an http or https URL is expected`);
}

export function normalizeDatabase(input: Fields): DatabaseTarget {
  if (input?.client === SQLITE) return { client: SQLITE };
  if (input?.client !== POSTGRES) throw new BadRequestException('Unsupported database: SQLite or PostgreSQL');
  const value = field(input, 'url', 'Connection URL');
  const invalid = 'Invalid connection URL, for example postgres://archipel:password@host:5432/archipel';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(invalid);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new BadRequestException(invalid);
  return { client: POSTGRES, url: value };
}

// Checks the connection and says whether the database already holds a platform, without writing to it.
export async function testDatabase(target: DatabaseTarget) {
  if (target.client === SQLITE) return { ok: true, version: 'SQLite' };
  const client = new pg.Client({ connectionString: target.url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // A drop after connecting arrives as an event: without a listener, it would stop the process.
  client.on('error', () => {});
  try {
    await client.connect();
    const {
      rows: [server],
    } = await client.query<{ version: string }>("select current_setting('server_version') as version");
    const {
      rows: [table],
    } = await client.query<{ name: string | null }>("select to_regclass('platform_apps') as name");
    const counted = table!.name
      ? await client.query<{ count: number }>('select count(*)::int as count from platform_apps')
      : null;
    const apps = counted ? counted.rows[0]!.count : null;
    return { ok: true, version: `PostgreSQL ${server!.version}`, apps };
  } catch (failure) {
    const error = failure as Error & { code?: string };
    const password = decodeURIComponent(new URL(target.url).password);
    const message = error.message || error.code || 'connection failed';
    return { ok: false, error: password ? message.replaceAll(password, '***') : message };
  } finally {
    await client.end().catch(() => {});
  }
}

// The database in use, as the settings page shows it: never with its password.
export function databaseLabel({ client, connection }: Config['db']) {
  if (client === SQLITE) return connection;
  try {
    const url = new URL(connection);
    url.password = '';
    return url.toString();
  } catch {
    return client;
  }
}
