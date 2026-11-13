import { columnsOf, insertRequires } from './rows.js';
import type { Column, ColumnType, Manifest, Table } from './schema.js';

const TS_TYPES: Record<ColumnType, string> = {
  uuid: 'string',
  string: 'string',
  text: 'string',
  date: 'string',
  datetime: 'string',
  ref: 'string',
  integer: 'number',
  number: 'number',
  boolean: 'boolean',
  json: 'unknown',
  enum: 'string',
};

const pascal = (name: string) =>
  name
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

function valueType(column: Column): string {
  if (column.type === 'enum') return (column.values ?? []).map((value) => JSON.stringify(value)).join(' | ');
  return TS_TYPES[column.type];
}

function fieldType(column: Column): string {
  const type = valueType(column);
  return column.required || column.pk || column.type === 'json' ? type : `${type} | null`;
}

function tableTypes(name: string, table: Table): string {
  const type = pascal(name);
  const columns = columnsOf(table);
  const row = columns.map(([field, column]) => `  ${field}: ${fieldType(column)};`);
  const insert = columns.map(([field, column]) => `  ${field}${insertRequires(column) ? '' : '?'}: ${fieldType(column)};`);
  return [
    `export interface ${type} {`,
    ...row,
    '}',
    '',
    `export interface ${type}Insert {`,
    ...insert,
    '}',
    '',
    `export type ${type}Update = Partial<${type}Insert>;`,
  ].join('\n');
}

const entry = (name: string, type: string) =>
  `  ${JSON.stringify(name)}: { row: ${type}; insert: ${type}Insert; update: ${type}Update };`;

// Types of `tables:`, to regenerate when the manifest changes. A table from another app is not described here:
// only the server knows its schema, so its row stays a dictionary.
export function generateTypes(manifest: Manifest): string {
  const tables = Object.entries(manifest.tables ?? {});
  const known = new Set(tables.map(([name]) => name));
  const { reads = [], writes = [] } = manifest.permissions ?? {};
  const external = [...new Set([...reads, ...writes])].filter((name) => !known.has(name));
  return [
    `// Generated from app.manifest.yaml (${manifest.id} ${manifest.version}) by "archipel types". Do not edit.`,
    '',
    ...tables.flatMap(([name, table]) => [tableTypes(name, table), '']),
    'export interface Tables {',
    ...tables.map(([name]) => entry(name, pascal(name))),
    ...external.map(
      (name) =>
        `  ${JSON.stringify(name)}: { row: Record<string, unknown>; insert: Record<string, unknown>; update: Record<string, unknown> };`,
    ),
    '}',
    '',
  ].join('\n');
}
