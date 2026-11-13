import type { Column } from '@archipel/manifest-schema';
import type { Knex } from 'knex';
import { diffSchema, type SchemaChange, type Tables } from './diff.js';

export interface Namespace {
  own: string;
  shared: string;
}

type AppliedChange = SchemaChange | { kind: 'snapshot'; table: string; snapshot: string };

// Default prefix (see ADR): `ns.own` for the app's tables, `ns.shared` for `shared.*`.
export const liveNamespace = (appId: string): Namespace => ({ own: `app_${appId.replaceAll('-', '_')}`, shared: 'shared' });
export const previewNamespace = (releaseId: string): Namespace => ({ own: `pv_${releaseId}`, shared: `pvs_${releaseId}` });

export const physicalName = (ns: Namespace, table: string) =>
  table.startsWith('shared.') ? `${ns.shared}_${table.slice('shared.'.length)}` : `${ns.own}_${table}`;

function addColumn(t: Knex.TableBuilder, name: string, column: Column, { existingTable }: { existingTable: boolean }) {
  let builder: Knex.ColumnBuilder;
  switch (column.type) {
    case 'integer':
      builder = t.integer(name);
      break;
    case 'number':
      builder = t.double(name);
      break;
    case 'boolean':
      builder = t.boolean(name);
      break;
    case 'date':
    case 'datetime':
    case 'string':
    case 'enum':
    case 'uuid':
    case 'ref':
      builder = t.string(name);
      break;
    default:
      builder = t.text(name);
  }
  if (column.pk) builder.primary();
  if (column.default !== undefined) {
    builder.defaultTo((typeof column.default === 'object' ? JSON.stringify(column.default) : column.default) as Knex.Value);
  }
  // NOT NULL is only set on a new table: on an existing table, the API enforces it.
  if (column.required && !existingTable) builder.notNullable();
}

async function createTable(db: Knex, physical: string, columns: Record<string, Column>) {
  await db.schema.createTable(physical, (t) => {
    for (const [name, column] of Object.entries(columns)) addColumn(t, name, column, { existingTable: false });
  });
}

async function addMissingColumn(db: Knex, physical: string, name: string, column: Column) {
  if (await db.schema.hasColumn(physical, name)) return false;
  await db.schema.alterTable(physical, (t) => addColumn(t, name, column, { existingTable: true }));
  return true;
}

async function snapshot(db: Knex, physical: string, suffix: string) {
  const copy = `bak_${suffix}_${physical}`.slice(0, 60);
  if (!(await db.schema.hasTable(physical)) || (await db.schema.hasTable(copy))) return null;
  await db.raw('create table ?? as select * from ??', [copy, physical]);
  return copy;
}

// Applies the schema diff. Without `allowDestructive`, only safe changes go through.
export async function applySchema(
  db: Knex,
  {
    ns,
    before,
    after,
    allowDestructive = false,
    snapshotSuffix,
  }: { ns: Namespace; before: Tables; after: Tables; allowDestructive?: boolean; snapshotSuffix?: string },
) {
  const applied: AppliedChange[] = [];

  for (const change of diffSchema(before, after)) {
    if (change.destructive && !allowDestructive) continue;
    const physical = physicalName(ns, change.table);

    if (change.destructive && snapshotSuffix) {
      const copy = await snapshot(db, physical, snapshotSuffix);
      if (copy) applied.push({ kind: 'snapshot', table: change.table, snapshot: copy });
    }

    const definition = after[change.table]?.columns ?? {};
    const column = change.column!;
    switch (change.kind) {
      case 'add_table':
        if (!(await db.schema.hasTable(physical))) await createTable(db, physical, definition);
        for (const [name, added] of Object.entries(definition)) await addMissingColumn(db, physical, name, added);
        break;
      case 'add_column':
        await addMissingColumn(db, physical, column, definition[column]!);
        break;
      case 'drop_column':
        await db.schema.alterTable(physical, (t) => void t.dropColumn(column));
        break;
      case 'drop_table':
        await db.schema.dropTable(physical);
        break;
      case 'change_type':
        await db.schema.alterTable(physical, (t) => void t.dropColumn(column));
        await addMissingColumn(db, physical, column, definition[column]!);
        break;
      default:
        break; // change_values has no physical equivalent: the API validates it.
    }
    applied.push(change);
  }
  return applied;
}

// Rollback: nothing is destroyed, only missing tables and columns are recreated.
export async function restoreMissing(db: Knex, { ns, target }: { ns: Namespace; target: Tables }) {
  const restored: { kind: string; table: string; column?: string }[] = [];
  for (const [table, { columns }] of Object.entries(target)) {
    const physical = physicalName(ns, table);
    if (!(await db.schema.hasTable(physical))) {
      await createTable(db, physical, columns);
      restored.push({ kind: 'add_table', table });
      continue;
    }
    for (const [name, column] of Object.entries(columns)) {
      if (await addMissingColumn(db, physical, name, column)) restored.push({ kind: 'add_column', table, column: name });
    }
  }
  return restored;
}

export async function dropTables(db: Knex, ns: Namespace, tables: string[]) {
  for (const table of tables) await db.schema.dropTableIfExists(physicalName(ns, table));
}
