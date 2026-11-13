import type { Column, Table } from '@archipel/manifest-schema';
import type { Knex } from 'knex';
import { liveNamespace, physicalName } from '../pipeline/migrate.js';
import type { Store } from '../database/store.js';
import type { AppRow, ValidRelease } from '../types.js';

type Access = 'owner' | 'write' | 'read';
type LiveApp = { row: AppRow; manifest: ValidRelease['manifest']; version: string };
type Reference = { id: string; name: string };

const isShared = (name: string) => name.startsWith('shared.');

// Counting reads no data. A missing table must not bring the page down.
async function countRows(db: Knex, physical: string) {
  try {
    const [row] = await db(physical).count({ count: '*' });
    const { count } = row as { count: string | number };
    return Number(count);
  } catch {
    return null;
  }
}

function describeColumns(definition: Table | undefined) {
  return Object.entries<Column>(definition?.columns ?? {}).map(([name, column]) => ({
    name,
    type: column.type,
    pk: Boolean(column.pk),
    required: Boolean(column.required),
    to: column.to ?? null,
  }));
}

// The tables of each live app, seen from the app: its own, then the shared tables it uses.
export async function describeTables({ store, db }: { store: Store; db: Knex }) {
  const apps: LiveApp[] = [];
  for (const row of await store.listApps()) {
    if (!row.live_release_id) continue;
    apps.push({ row, ...((await store.getRelease(row.live_release_id)) as ValidRelease) });
  }

  const owners = new Map<string, Reference & { definition: Table }>();
  const consumers = new Map<string, (Reference & { access: Access })[]>();
  for (const { row, manifest } of apps) {
    for (const name of Object.keys(row.applied_tables)) {
      if (isShared(name)) owners.set(name, { id: row.id, name: row.name, definition: row.applied_tables[name]! });
    }
    const writes = manifest.permissions?.writes ?? [];
    for (const name of new Set([...(manifest.permissions?.reads ?? []), ...writes])) {
      const access: Access = writes.includes(name) ? 'write' : 'read';
      consumers.set(name, [...(consumers.get(name) ?? []), { id: row.id, name: row.name, access }]);
    }
  }

  const counts = new Map<string, number | null>();
  const rowsOf = async (physical: string) => {
    if (!counts.has(physical)) counts.set(physical, await countRows(db, physical));
    return counts.get(physical) ?? null;
  };

  const describeTable = async (app: LiveApp, name: string, definition: Table | undefined, access: Access) => {
    const physical = physicalName(liveNamespace(app.row.id), name);
    const owner = owners.get(name);
    return {
      name: isShared(name) ? name.slice('shared.'.length) : name,
      physical,
      shared: isShared(name),
      access,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      consumers: consumers.get(name) ?? [],
      exposed: (app.manifest.exposes?.data ?? []).includes(name),
      crud: Boolean(definition?.crud),
      rbac: { read: definition?.rbac?.read ?? [], write: definition?.rbac?.write ?? [] },
      rows: await rowsOf(physical),
      columns: describeColumns(definition),
    };
  };

  const result = [];
  for (const app of apps) {
    const { row, manifest, version } = app;
    const tables = [];
    for (const [name, definition] of Object.entries(row.applied_tables)) {
      tables.push(await describeTable(app, name, definition, 'owner'));
    }
    const writes = manifest.permissions?.writes ?? [];
    for (const name of new Set([...(manifest.permissions?.reads ?? []), ...writes])) {
      if (name in row.applied_tables) continue;
      tables.push(await describeTable(app, name, owners.get(name)?.definition, writes.includes(name) ? 'write' : 'read'));
    }
    result.push({
      id: row.id,
      name: row.name,
      status: row.status,
      version,
      hasIcon: Boolean(manifest.icon),
      tables,
      mcp: (manifest.exposes?.mcp ?? []).map((tool) => tool.name),
      network: manifest.permissions?.network ?? [],
    });
  }
  return result;
}
