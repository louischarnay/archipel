import type { Manifest, Table } from '@archipel/manifest-schema';
import knex from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffPermissions, diffSchema } from '../src/pipeline/diff.js';
import { applySchema, liveNamespace, physicalName } from '../src/pipeline/migrate.js';

const table = (columns: Table['columns']): Table => ({ columns });
const id = { type: 'uuid', pk: true } as const;
const title = { type: 'string' } as const;

describe('diffSchema', () => {
  it('an added optional table or column stays safe', () => {
    const changes = diffSchema({ ticket: table({ id }) }, { ticket: table({ id, title }), note: table({ id }) });
    expect(changes.map((change) => change.kind)).toEqual(['add_column', 'add_table']);
    expect(changes.every((change) => !change.destructive)).toBe(true);
  });

  it('a required column without a default value is destructive', () => {
    const [change] = diffSchema({ ticket: table({ id }) }, { ticket: table({ id, title: { ...title, required: true } }) });
    expect(change).toMatchObject({ kind: 'add_column', destructive: true });
  });

  it('removing a column, a table or an enum value is destructive', () => {
    const status = (values: string[]) => ({ type: 'enum', values }) as const;
    const before = { ticket: table({ id, title, status: status(['open', 'done']) }), note: table({ id }) };
    const changes = diffSchema(before, { ticket: table({ id, status: status(['open']) }) });
    expect(changes.map((change) => [change.kind, change.destructive])).toEqual([
      ['change_values', true],
      ['drop_column', true],
      ['drop_table', true],
    ]);
  });
});

describe('diffPermissions', () => {
  it('reports added network access', () => {
    const before = { permissions: { network: ['a.example.com'] } } as Manifest;
    const after = { permissions: { network: ['a.example.com', 'b.example.com'] } } as Manifest;
    const diff = diffPermissions(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.network.added).toEqual(['b.example.com']);
  });
});

describe('applySchema', () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  const ns = liveNamespace('tickets');
  const physical = physicalName(ns, 'ticket');

  beforeEach(() => applySchema(db, { ns, before: {}, after: { ticket: table({ id, title }) } }));
  afterEach(async () => {
    await db.schema.dropTableIfExists(physical);
    await db.schema.dropTableIfExists(`bak_rel1_${physical}`);
  });

  const before = { ticket: table({ id, title }) };
  const after = { ticket: table({ id }) };

  it('without the flag, a destructive change touches nothing', async () => {
    expect(await applySchema(db, { ns, before, after })).toEqual([]);
    expect(await db.schema.hasColumn(physical, 'title')).toBe(true);
  });

  it('with the flag, a copy is kept before the change', async () => {
    await db(physical).insert({ id: '1', title: 'Panne' });
    const applied = await applySchema(db, { ns, before, after, allowDestructive: true, snapshotSuffix: 'rel1' });
    expect(applied[0]).toMatchObject({ kind: 'snapshot' });
    expect(await db.schema.hasColumn(physical, 'title')).toBe(false);
    expect(await db(`bak_rel1_${physical}`).first()).toMatchObject({ title: 'Panne' });
  });
});
