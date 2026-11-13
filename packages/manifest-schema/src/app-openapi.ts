import { columnsOf, primaryKey, rowSchema } from './rows.js';
import type { Manifest, Table } from './schema.js';

interface Options {
  // Provided by the server: offline, a table from another app stays an object without detail.
  sharedTable?: (name: string) => Table | null;
}

const ANY_OBJECT = { type: 'object', additionalProperties: true };
const ERROR = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: ANY_OBJECT },
  },
};

const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const reply = (description: string, schema: object) => ({ description, ...json(schema) });
const refusals = {
  400: reply('Invalid request', ERROR),
  401: reply('App token missing or expired', ERROR),
  403: reply('Missing permission', ERROR),
  404: reply('Not found', ERROR),
};

const pathParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const queryParam = (name: string, schema: object) => ({ name, in: 'query', required: false, schema });

const readRoles = (table: Table) => table.rbac?.read ?? [];
const writeRoles = (table: Table) => table.rbac?.write ?? [];
const operationName = (verb: string, table: string) => `${verb}_${table.replaceAll('.', '_')}`;

function readOperations(name: string, row: object, table: Table | null) {
  const filters = table ? columnsOf(table).map(([column]) => queryParam(column, {})) : [];
  const roles = table ? { 'x-archipel-roles': [...readRoles(table), ...writeRoles(table)] } : {};
  return {
    collection: {
      get: {
        operationId: operationName('list', name),
        summary: `List ${name}`,
        parameters: [
          queryParam('limit', { type: 'integer', minimum: 1, maximum: 500 }),
          queryParam('offset', { type: 'integer', minimum: 0 }),
          ...filters,
        ],
        responses: { 200: reply('Rows', { type: 'array', items: row }), ...refusals },
        ...roles,
      },
    },
    item: {
      get: {
        operationId: operationName('get', name),
        summary: `Read a row of ${name}`,
        responses: { 200: reply('Row', row), ...refusals },
        ...roles,
      },
    },
  };
}

function writeOperations(name: string, row: object, table: Table) {
  const roles = { 'x-archipel-roles': writeRoles(table) };
  return {
    collection: {
      post: {
        operationId: operationName('create', name),
        summary: `Create a row of ${name}`,
        requestBody: { required: true, ...json(rowSchema(table)) },
        responses: { 201: reply('Row created', row), ...refusals },
        ...roles,
      },
    },
    item: {
      patch: {
        operationId: operationName('update', name),
        summary: `Update a row of ${name}`,
        requestBody: { required: true, ...json(rowSchema(table, { partial: true })) },
        responses: { 200: reply('Row updated', row), ...refusals },
        ...roles,
      },
      delete: {
        operationId: operationName('delete', name),
        summary: `Delete a row of ${name}`,
        responses: { 204: { description: 'Row deleted' }, ...refusals },
        ...roles,
      },
    },
  };
}

function controllerPaths(manifest: Manifest) {
  const paths: Record<string, Record<string, object>> = {};
  for (const [index, controller] of (manifest.controllers ?? []).entries()) {
    const [method = '', route = ''] = controller.path.split(' ');
    const params = [...route.matchAll(/:(\w+)/g)].map((match) => pathParam(match[1]!));
    const path = route.replace(/:(\w+)/g, '{$1}');
    const tool = manifest.exposes?.mcp?.find((item) => item.calls === controller.path);
    paths[path] = {
      ...paths[path],
      [method.toLowerCase()]: {
        operationId: tool?.name ?? `controller_${index}`,
        summary: tool?.description ?? controller.path,
        ...(params.length ? { parameters: params } : {}),
        ...(method === 'GET' ? {} : { requestBody: { required: false, ...json(ANY_OBJECT) } }),
        responses: { 200: reply('Controller result', {}), ...refusals },
        ...(controller.needs ? { 'x-archipel-needs': controller.needs } : {}),
      },
    };
  }
  return paths;
}

function tablePaths(manifest: Manifest, { sharedTable }: Options) {
  const paths: Record<string, object> = {};
  const add = (name: string, table: Table | null, writable: boolean) => {
    const row = table ? { ...rowSchema(table), required: [primaryKey(table)] } : ANY_OBJECT;
    const read = readOperations(name, row, table);
    const write = table && writable ? writeOperations(name, row, table) : { collection: {}, item: {} };
    paths[`/data/${name}`] = { ...read.collection, ...write.collection };
    paths[`/data/${name}/{id}`] = { parameters: [pathParam('id')], ...read.item, ...write.item };
  };

  const own = manifest.tables ?? {};
  for (const [name, table] of Object.entries(own)) {
    if (table.crud) add(name, table, true);
  }
  const { reads = [], writes = [] } = manifest.permissions ?? {};
  for (const name of new Set([...reads, ...writes])) {
    if (Object.hasOwn(own, name)) continue;
    const table = sharedTable?.(name) ?? null;
    add(name, table, writes.includes(name) && Boolean(table?.crud));
  }
  return paths;
}

// An app's contract: its routes live outside Fastify, so the server's OpenAPI plugin cannot see them.
export function appOpenApi(manifest: Manifest, options: Options = {}) {
  return {
    openapi: '3.1.0',
    info: { title: manifest.name, version: manifest.version },
    servers: [{ url: `/run/${manifest.id}` }],
    components: { securitySchemes: { app: { type: 'http', scheme: 'bearer', description: 'App token, tied to the session' } } },
    security: [{ app: [] }],
    paths: { ...tablePaths(manifest, options), ...controllerPaths(manifest) },
  };
}
