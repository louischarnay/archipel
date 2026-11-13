import { Type, type Static, type TSchema } from 'typebox';

// Single source of the contract: the published JSON Schema and the TS types derive from it.
const strict = { additionalProperties: false } as const;

const identifier = { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } as const;
const appId = Type.String({ pattern: '^[a-z][a-z0-9-]{1,39}$' });
const roleList = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
const route = Type.String({ pattern: '^(GET|POST|PUT|PATCH|DELETE) /' });

// Dictionary with constrained keys: `Type.Record` cannot express `propertyNames`.
const mapOf = <T extends TSchema>(names: object, value: T, options: object = {}) =>
  Type.Unsafe<Record<string, Static<T>>>({ type: 'object', propertyNames: names, additionalProperties: value, ...options });

export const COLUMN_TYPES = [
  'uuid',
  'string',
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'json',
  'enum',
  'ref',
] as const;

const column = Type.Object(
  {
    type: Type.Enum(COLUMN_TYPES),
    pk: Type.Optional(Type.Boolean()),
    required: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Unknown()),
    values: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    to: Type.Optional(Type.String()),
  },
  strict,
);

const table = Type.Object(
  {
    columns: mapOf(identifier, column, { minProperties: 1 }),
    crud: Type.Optional(Type.Boolean()),
    rbac: Type.Optional(Type.Object({ read: Type.Optional(roleList), write: Type.Optional(roleList) }, strict)),
  },
  strict,
);

const controller = Type.Object(
  {
    path: route,
    handler: Type.String(),
    needs: Type.Optional(Type.Array(Type.String())),
  },
  strict,
);

const sharedTables = Type.Array(Type.String({ pattern: '^shared\\.' }));

const permissions = Type.Object(
  {
    reads: Type.Optional(sharedTables),
    writes: Type.Optional(sharedTables),
    network: Type.Optional(Type.Array(Type.String({ pattern: '^(http://)?[a-z0-9.*-]+(:[0-9]+)?$' }))),
    llm: Type.Optional(Type.Object({ quota: Type.Optional(Type.String()) }, strict)),
  },
  strict,
);

const mcpTool = Type.Object(
  {
    name: Type.Unsafe<string>(identifier),
    description: Type.String({ minLength: 1 }),
    calls: route,
    input: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: 'object' })),
  },
  strict,
);

export const manifestSchema = Type.Object(
  {
    manifest: Type.Unsafe<1>({ const: 1 }),
    id: appId,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$' }),
    icon: Type.Optional(Type.String()),
    group: Type.Optional(appId),
    frontend: Type.Optional(
      Type.Object(
        {
          dir: Type.String(),
          route: Type.String({ pattern: '^/[a-z0-9][a-z0-9-]*$' }),
        },
        strict,
      ),
    ),
    roles: Type.Optional(mapOf(identifier, roleList)),
    tables: Type.Optional(mapOf({ pattern: '^(shared\\.)?[a-z][a-z0-9_]*$' }, table)),
    controllers: Type.Optional(Type.Array(controller)),
    permissions: Type.Optional(permissions),
    exposes: Type.Optional(
      Type.Object(
        {
          data: Type.Optional(Type.Array(Type.String())),
          mcp: Type.Optional(Type.Array(mcpTool)),
        },
        strict,
      ),
    ),
    health: Type.Optional(Type.String({ pattern: '^/' })),
    tests: Type.Optional(Type.String()),
  },
  { $id: 'https://archipel.dev/schemas/app.manifest.v1.json', ...strict },
);

export type Manifest = Static<typeof manifestSchema>;
export type Column = Static<typeof column>;
export type ColumnType = Column['type'];
export type Table = Static<typeof table>;
export type Controller = Static<typeof controller>;
export type Permissions = Static<typeof permissions>;
export type McpTool = Static<typeof mcpTool>;
