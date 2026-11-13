import type { Manifest, Table } from '@archipel/manifest-schema';

export type Tables = Record<string, Table>;

export interface SchemaChange {
  kind: 'add_table' | 'add_column' | 'change_type' | 'change_values' | 'drop_column' | 'drop_table';
  table: string;
  column?: string;
  destructive: boolean;
  reason?: string | undefined;
}

export interface ReleaseDiff {
  firstRelease: boolean;
  previousVersion: string | null;
  schema: SchemaChange[];
  permissions: ReturnType<typeof diffPermissions>;
  exposure: ReturnType<typeof diffExposure>;
}

const list = <T>(value: readonly T[] | undefined) => [...(value ?? [])];
const stable = (value: unknown) => JSON.stringify(value ?? null);

function diffList(before: readonly string[] | undefined, after: readonly string[] | undefined) {
  const previous = new Set(list(before));
  const next = new Set(list(after));
  return {
    added: [...next].filter((item) => !previous.has(item)),
    removed: [...previous].filter((item) => !next.has(item)),
    unchanged: [...next].filter((item) => previous.has(item)),
  };
}

// Compares two table states. `tables`: { name: { columns } }.
export function diffSchema(before: Tables = {}, after: Tables = {}) {
  const changes: SchemaChange[] = [];
  for (const [name, table] of Object.entries(after)) {
    const known = before[name];
    if (!known) {
      changes.push({ kind: 'add_table', table: name, destructive: false });
      continue;
    }
    const previous = known.columns;
    for (const [column, definition] of Object.entries(table.columns)) {
      const old = previous[column];
      if (!old) {
        const breaking = definition.required && definition.default === undefined;
        changes.push({
          kind: 'add_column',
          table: name,
          column,
          destructive: Boolean(breaking),
          reason: breaking ? 'Required column without a default value on an existing table' : undefined,
        });
      } else if (old.type !== definition.type) {
        changes.push({
          kind: 'change_type',
          table: name,
          column,
          destructive: true,
          reason: `Type ${old.type} → ${definition.type}`,
        });
      } else if (stable(old.values) !== stable(definition.values)) {
        const lost = list(old.values).filter((value) => !definition.values?.includes(value));
        changes.push({
          kind: 'change_values',
          table: name,
          column,
          destructive: lost.length > 0,
          reason: lost.length ? `Values removed: ${lost.join(', ')}` : undefined,
        });
      }
    }
    for (const column of Object.keys(previous)) {
      if (!table.columns[column]) {
        changes.push({
          kind: 'drop_column',
          table: name,
          column,
          destructive: true,
          reason: 'The column data will be lost',
        });
      }
    }
  }
  for (const name of Object.keys(before)) {
    if (!after[name]) {
      changes.push({ kind: 'drop_table', table: name, destructive: true, reason: 'The table data will be lost' });
    }
  }
  return changes;
}

export function diffPermissions(before: Manifest | null | undefined, after: Manifest) {
  const previous: NonNullable<Manifest['permissions']> = before?.permissions ?? {};
  const next: NonNullable<Manifest['permissions']> = after.permissions ?? {};
  const permissions = {
    reads: diffList(previous.reads, next.reads),
    writes: diffList(previous.writes, next.writes),
    network: diffList(previous.network, next.network),
    llm: {
      before: previous.llm?.quota ?? null,
      after: next.llm?.quota ?? null,
    },
  };
  const changed =
    (['reads', 'writes', 'network'] as const).some((key) => permissions[key].added.length || permissions[key].removed.length) ||
    permissions.llm.before !== permissions.llm.after;
  return { ...permissions, changed };
}

export function diffExposure(before: Manifest | null | undefined, after: Manifest) {
  const data = diffList(before?.exposes?.data, after.exposes?.data);
  const mcp = diffList(
    before?.exposes?.mcp?.map((tool) => tool.name),
    after.exposes?.mcp?.map((tool) => tool.name),
  );
  return { data, mcp, changed: Boolean(data.added.length || data.removed.length || mcp.added.length || mcp.removed.length) };
}
