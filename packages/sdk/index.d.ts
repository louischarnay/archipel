/// <reference lib="dom" />

// Controller contract. This package only contains types: `ctx` is provided by the platform at runtime,
// and a controller runs without `node_modules`. So it is always imported with `import type`.

export type RowId = string | number;

export interface TableTypes {
  row: object;
  insert: object;
  update: object;
}

// By default, any dictionary fits. `Tables`, written by `archipel types`, gives the real columns.
export type AnyTables = Record<string, { row: Record<string, unknown>; insert: Record<string, unknown>; update: Record<string, unknown> }>;
export type TablesOf<T> = { [Name in keyof T]: TableTypes };

export interface ListOptions<R extends object = object> {
  where?: { [Column in keyof R]?: string | number | boolean };
  limit?: number;
  offset?: number;
}

// Tables declared by the app, or granted by `permissions`: the platform refuses any other table.
export interface TableClient<T extends TableTypes = TableTypes> {
  list(options?: ListOptions<T['row']>): Promise<T['row'][]>;
  get(id: RowId): Promise<T['row'] | null>;
  insert(row: T['insert']): Promise<T['row']>;
  update(id: RowId, patch: T['update']): Promise<T['row'] | null>;
  remove(id: RowId): Promise<boolean>;
}

export interface User {
  sub: string;
  name: string;
  roles: string[];
}

export interface Log {
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

export interface Database<T extends TablesOf<T> = AnyTables> {
  table<Name extends keyof T & string>(name: Name): TableClient<T[Name]>;
}

export interface Context<T extends TablesOf<T> = AnyTables, Params extends object = Record<string, string>, Body = unknown> {
  params: Params;
  query: Record<string, string>;
  body: Body;
  user: User;
  db: Database<T>;
  /** Limited to `permissions.network`, response read in full and capped. */
  fetch: typeof fetch;
  log: Log;
  /** Throw it to answer anything other than 200. */
  error(status: number, message: string): Error;
}

export type Controller<T extends TablesOf<T> = AnyTables, Params extends object = Record<string, string>, Body = unknown> = (
  ctx: Context<T, Params, Body>,
) => unknown;
