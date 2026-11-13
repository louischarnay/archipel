import { randomUUID } from 'node:crypto';
import {
  explainAjvErrors,
  primaryKey,
  rowSchema,
  type ColumnType,
  type Manifest,
  type Table,
  type ValidationIssue,
} from '@archipel/manifest-schema';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { Knex } from 'knex';
import { physicalName } from '../pipeline/migrate.js';

export class ApiError extends Error {
  status: number;
  details?: string[];
  issues?: ValidationIssue[];

  constructor(status: number, message: string, details?: string[], issues?: ValidationIssue[]) {
    super(message);
    this.status = status;
    this.details = details;
    this.issues = issues;
  }
}

export type Row = Record<string, unknown>;

export interface ResolvedTable {
  name: string;
  definition: Table;
  physical: string;
}

interface TableOwner {
  manifest: Manifest;
  ns: { own: string; shared: string };
}

interface ResolveOptions {
  write?: boolean;
  sharedDefinition: (name: string) => Table | null;
}

export interface ListOptions {
  where?: Record<string, string>;
  limit?: unknown;
  offset?: unknown;
}

const MAX_LIMIT = 500;
const MAX_ROW_BYTES = 1024 * 1024;

// Resolves a logical table for an app. `write` requires owning it or having permissions.writes.
export function resolveTable(
  mount: TableOwner,
  name: string,
  { write = false, sharedDefinition }: ResolveOptions,
): ResolvedTable {
  const permissions = mount.manifest.permissions ?? {};
  const tables = mount.manifest.tables ?? {};
  if (Object.hasOwn(tables, name)) return { name, definition: tables[name]!, physical: physicalName(mount.ns, name) };

  const reachable = permissions.reads?.includes(name) || permissions.writes?.includes(name);
  if (!name.startsWith('shared.') || !reachable) {
    throw new ApiError(403, `Table "${name}" not declared by this app`);
  }
  if (write && !permissions.writes?.includes(name)) {
    throw new ApiError(403, `Write to ${name} not declared in permissions.writes`);
  }
  const definition = sharedDefinition(name);
  if (!definition) throw new ApiError(503, `Shared table ${name} unavailable`);
  return { name, definition, physical: physicalName(mount.ns, name) };
}

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
for (const format of ['date', 'date-time']) ajv.addFormat(format, (value: string) => !Number.isNaN(Date.parse(value)));

const EXPECTED: Partial<Record<ColumnType, string>> = {
  integer: 'must be an integer',
  number: 'must be a number',
  boolean: 'must be a boolean',
  date: 'must be an ISO 8601 date',
  datetime: 'must be an ISO 8601 date',
};

// A definition lives as long as its mount: so do its validators.
const validators = new WeakMap<Table, { full: ValidateFunction; partial: ValidateFunction }>();

function validatorFor(definition: Table, partial: boolean): ValidateFunction {
  let compiled = validators.get(definition);
  if (!compiled) {
    compiled = { full: ajv.compile(rowSchema(definition)), partial: ajv.compile(rowSchema(definition, { partial: true })) };
    validators.set(definition, compiled);
  }
  return partial ? compiled.partial : compiled.full;
}

function describeError(definition: Table, error: ErrorObject): string {
  if (error.keyword === 'required') return `${error.params.missingProperty} is required`;
  if (error.keyword === 'additionalProperties') return `Unknown field: ${error.params.additionalProperty}`;
  const name = error.instancePath.slice(1);
  const column = definition.columns[name]!;
  if (error.data === null) return `${name} is required`;
  if (column.type === 'enum') return `${name} must be ${column.values?.join(' or ')}`;
  return `${name} ${EXPECTED[column.type] ?? 'must be a string'}`;
}

function toStorage(definition: Table, input: unknown, { partial }: { partial: boolean }): Row {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'The request body must be a JSON object');
  }
  const validate = validatorFor(definition, partial);
  if (!validate(input)) {
    const errors = validate.errors ?? [];
    const issues = explainAjvErrors(errors).map((issue) => ({ ...issue, path: `body.${issue.path}` }));
    throw new ApiError(400, 'Invalid data', [...new Set(errors.map((error) => describeError(definition, error)))], issues);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_ROW_BYTES) throw new ApiError(413, 'Record too large');
  const row: Row = {};
  for (const [name, value] of Object.entries(input)) {
    const { type } = definition.columns[name]!;
    if (type === 'json' && value !== null) row[name] = JSON.stringify(value);
    else if (type === 'boolean' && value !== null) row[name] = value ? 1 : 0;
    else row[name] = value;
  }
  return row;
}

function fromStorage(definition: Table, row: Row): Row {
  const output = { ...row };
  for (const [name, column] of Object.entries(definition.columns)) {
    if (output[name] === null || output[name] === undefined) continue;
    if (column.type === 'boolean') output[name] = Boolean(output[name]);
    if (column.type === 'json') output[name] = JSON.parse(output[name] as string);
  }
  return output;
}

export async function listRows(db: Knex, table: ResolvedTable, { where = {}, limit = 100, offset = 0 }: ListOptions = {}) {
  const query = db(table.physical);
  for (const [name, value] of Object.entries(where)) {
    if (!Object.hasOwn(table.definition.columns, name)) throw new ApiError(400, `Unknown filter: ${name}`);
    query.where(name, value);
  }
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), MAX_LIMIT);
  const rows = await query.limit(bounded).offset(Math.max(Number(offset) || 0, 0));
  return rows.map((row: Row) => fromStorage(table.definition, row));
}

export async function getRow(db: Knex, table: ResolvedTable, id: Knex.Value) {
  const pk = primaryKey(table.definition);
  const row = await db(table.physical).where(pk, id).first();
  return row ? fromStorage(table.definition, row) : null;
}

export async function insertRow(db: Knex, table: ResolvedTable, input: unknown) {
  const row = toStorage(table.definition, input, { partial: false });
  const pk = primaryKey(table.definition);
  if (row[pk] === undefined) {
    if (table.definition.columns[pk]!.type === 'integer') {
      throw new ApiError(400, `${pk} is required`);
    }
    row[pk] = randomUUID();
  }
  await db(table.physical).insert(row);
  return getRow(db, table, row[pk] as Knex.Value);
}

export async function updateRow(db: Knex, table: ResolvedTable, id: Knex.Value, input: unknown) {
  const pk = primaryKey(table.definition);
  const row = toStorage(table.definition, input, { partial: true });
  delete row[pk];
  if (!Object.keys(row).length) return getRow(db, table, id);
  const count = await db(table.physical).where(pk, id).update(row);
  return count ? getRow(db, table, id) : null;
}

export async function deleteRow(db: Knex, table: ResolvedTable, id: Knex.Value) {
  const pk = primaryKey(table.definition);
  return (await db(table.physical).where(pk, id).del()) > 0;
}
