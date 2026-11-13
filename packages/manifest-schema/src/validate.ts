import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { parse } from 'yaml';
import { manifestSchema, type Column, type Manifest } from './schema.js';

export const MANIFEST_FILE = 'app.manifest.yaml';

export const RESERVED_ROUTES = ['/api', '/auth', '/login', '/setup', '/run', '/preview', '/ui', '/health'];

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
const checkSchema = ajv.compile<Manifest>(manifestSchema);

const MAX_RECEIVED = 200;
const PK_TYPES: string[] = ['uuid', 'string', 'integer'];

// Each error says where, what was received, what is expected and how to fix it: this is what the agent reads to iterate.
export interface ValidationIssue {
  path: string;
  message: string;
  hint: string;
  received?: unknown;
  expected?: unknown;
}

export interface ValidationContext {
  routes?: Record<string, string>;
  sharedTables?: { has(name: string): boolean };
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface Detail {
  received?: unknown;
  expected?: unknown;
}

const issue = (path: string, message: string, hint: string, detail: Detail = {}): ValidationIssue => ({
  path,
  message,
  hint,
  ...detail,
});

// A received value can be huge: the report keeps only its beginning.
function excerpt(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text.length <= MAX_RECEIVED) return value;
  return `${text.slice(0, MAX_RECEIVED)}…`;
}

const fieldPath = (parent: string, field: string) => (parent ? `${parent}.${field}` : field);

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function closest(name: string, candidates: string[]): string | undefined {
  const [best] = candidates
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .sort((a, b) => a.distance - b.distance);
  return best && best.distance <= Math.max(1, Math.floor(name.length / 3)) ? best.candidate : undefined;
}

export function explainAjvError(error: ErrorObject): ValidationIssue {
  const parent = error.instancePath.slice(1).replaceAll('/', '.');
  const path = parent || '(root)';
  const received = excerpt(error.data);
  switch (error.keyword) {
    case 'required': {
      const field = error.params.missingProperty as string;
      return issue(fieldPath(parent, field), `Missing field "${field}"`, `Add "${field}" under ${path}.`, {
        expected: 'a field with a value',
      });
    }
    case 'additionalProperties': {
      const field = error.params.additionalProperty as string;
      const known = Object.keys((error.parentSchema?.properties ?? {}) as object);
      const suggestion = closest(field, known);
      return issue(
        fieldPath(parent, field),
        `Unknown field "${field}"`,
        suggestion ? `Did you mean "${suggestion}"?` : 'Remove this field or fix its spelling: undeclared fields are rejected.',
        { received: field, expected: known },
      );
    }
    case 'pattern': {
      const name = error.propertyName;
      return issue(
        name ? fieldPath(parent, name) : path,
        'Invalid format',
        `The value must match the expression ${error.params.pattern}.`,
        {
          received: name ?? received,
          expected: `a value matching ${error.params.pattern}`,
        },
      );
    }
    case 'enum':
      return issue(path, 'Value not allowed', `Accepted values: ${error.params.allowedValues.join(', ')}.`, {
        received,
        expected: error.params.allowedValues,
      });
    case 'const':
      return issue(path, 'Value not allowed', `Expected value: ${error.params.allowedValue}.`, {
        received,
        expected: error.params.allowedValue,
      });
    case 'type':
      return issue(path, 'Invalid type', `Expected type: ${error.params.type}.`, { received, expected: error.params.type });
    default:
      return issue(path, error.message ?? 'Invalid value', 'Fix this field according to the contract.', { received });
  }
}

// Ajv doubles each rejected name with a generic error that adds nothing.
export const explainAjvErrors = (errors: ErrorObject[]): ValidationIssue[] =>
  errors.filter((error) => error.keyword !== 'propertyNames').map(explainAjvError);

// The SDK does not exist at runtime: a controller runs without node_modules, and `ctx` is provided to it.
const RUNTIME_SDK_IMPORT = /\b(?:from|import|require\s*\()\s*['"]@archipel\/sdk['"]/;

function checkHandler(root: string, relative: string, path: string, errors: ValidationIssue[]) {
  const target = insideRoot(root, relative);
  if (!target || !existsSync(target) || !statSync(target).isFile()) return;
  if (RUNTIME_SDK_IMPORT.test(readFileSync(target, 'utf8'))) {
    errors.push(
      issue(
        path,
        'The SDK is imported at runtime',
        'Use "import type": @archipel/sdk only contains types, and ctx is provided by the platform.',
        {
          received: relative,
          expected: 'a controller without an @archipel/sdk import once compiled',
        },
      ),
    );
  }
}

const insideRoot = (root: string, relative: string) => {
  const target = resolve(root, relative);
  return target === root || target.startsWith(root + sep) ? target : null;
};

function checkFile(
  root: string,
  relative: string,
  path: string,
  label: string,
  errors: ValidationIssue[],
  kind: 'file' | 'dir' = 'file',
) {
  const target = insideRoot(root, relative);
  const received = { received: relative };
  if (!target) {
    errors.push(
      issue(path, `${label} is outside the app folder`, 'Use a path relative to the app root, without "..".', received),
    );
  } else if (!existsSync(target)) {
    errors.push(issue(path, `${label} not found: ${relative}`, 'Add this file to the archive or fix the path.', received));
  } else if (kind === 'dir' && !statSync(target).isDirectory()) {
    errors.push(issue(path, `${label} is not a folder: ${relative}`, 'Point to the folder of static files.', received));
  }
}

export function parseManifest(text: string): { manifest: unknown; errors: ValidationIssue[] } {
  try {
    return { manifest: parse(text), errors: [] };
  } catch (error) {
    return { manifest: null, errors: [issue(MANIFEST_FILE, 'Unreadable YAML', (error as Error).message)] };
  }
}

// Validates the shape, then internal consistency. `context.routes` lists the routes already taken by other apps.
export function validateManifest(manifest: unknown, root: string, context: ValidationContext = {}): ValidationResult {
  if (!checkSchema(manifest)) return { errors: explainAjvErrors(checkSchema.errors ?? []), warnings: [] };

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const tables = manifest.tables ?? {};
  const controllers = manifest.controllers ?? [];
  const permissions = manifest.permissions ?? {};
  const grantedShared = new Set([...(permissions.reads ?? []), ...(permissions.writes ?? [])]);

  if (manifest.frontend) {
    const { route, dir } = manifest.frontend;
    checkFile(root, dir, 'frontend.dir', 'Frontend folder', errors, 'dir');
    if (RESERVED_ROUTES.includes(route)) {
      errors.push(
        issue('frontend.route', `The route ${route} is reserved`, `Choose a route other than ${RESERVED_ROUTES.join(', ')}.`, {
          received: route,
          expected: `a route outside ${RESERVED_ROUTES.join(', ')}`,
        }),
      );
    }
    const taken = context.routes?.[route];
    if (taken && taken !== manifest.id) {
      errors.push(
        issue('frontend.route', `The route ${route} is already used by the app ${taken}`, 'Choose a free route.', {
          received: route,
          expected: 'a free route',
        }),
      );
    }
  } else if (!controllers.length && !Object.keys(tables).length) {
    warnings.push(
      issue('frontend', 'App with neither frontend nor back end', 'Declare at least a frontend, a table or a controller.'),
    );
  }

  if (manifest.icon) checkFile(root, manifest.icon, 'icon', 'Icon', errors);

  for (const [name, table] of Object.entries(tables)) {
    const columns: [string, Column][] = Object.entries(table.columns);
    const pks = columns.filter(([, column]) => column.pk);
    if (pks.length !== 1) {
      errors.push(
        issue(
          `tables.${name}.columns`,
          `The table ${name} must have exactly one pk column`,
          'Add for example "id: { type: uuid, pk: true }".',
          { received: pks.map(([key]) => key), expected: 'exactly one pk column' },
        ),
      );
    } else if (!PK_TYPES.includes(pks[0]![1].type)) {
      errors.push(
        issue(`tables.${name}.columns.${pks[0]![0]}`, 'Unsupported pk type', 'Use uuid, string or integer.', {
          received: pks[0]![1].type,
          expected: PK_TYPES,
        }),
      );
    }

    for (const [columnName, column] of columns) {
      const path = `tables.${name}.columns.${columnName}`;
      if (column.type === 'enum' && !column.values) {
        errors.push(
          issue(path, 'Enum column without "values"', 'List the possible values.', {
            expected: 'a non-empty list under "values"',
          }),
        );
      }
      if (column.type === 'enum' && column.default !== undefined && !column.values?.includes(column.default as string)) {
        errors.push(
          issue(
            path,
            `Default value "${column.default}" missing from "values"`,
            'Add it to "values" or change the default value.',
            { received: column.default, expected: column.values },
          ),
        );
      }
      if (column.type === 'ref') {
        if (!column.to) {
          errors.push(
            issue(path, 'Ref column without "to"', 'Name the target table, for example "to: shared.customer".', {
              expected: 'a table under "to"',
            }),
          );
        } else if (column.to.startsWith('shared.') && !grantedShared.has(column.to) && !tables[column.to]) {
          errors.push(
            issue(path, `Reference to ${column.to} not declared in permissions`, `Add ${column.to} to permissions.reads.`, {
              received: column.to,
              expected: 'a table from permissions.reads or permissions.writes',
            }),
          );
        } else if (!column.to.startsWith('shared.') && !tables[column.to]) {
          errors.push(
            issue(path, `Unknown target table "${column.to}"`, 'Declare this table under "tables".', {
              received: column.to,
              expected: Object.keys(tables),
            }),
          );
        }
      }
    }

    if (table.crud && !table.rbac?.read?.length) {
      warnings.push(
        issue(
          `tables.${name}.rbac`,
          `CRUD without a read rule on ${name}`,
          'Without rbac.read, only the admin role can read this table.',
        ),
      );
    }
  }

  for (const shared of grantedShared) {
    if (!tables[shared] && context.sharedTables && !context.sharedTables.has(shared)) {
      errors.push(
        issue('permissions', `Shared table ${shared} not found`, 'First deploy the app that declares it under "tables".', {
          received: shared,
          expected: 'a shared table already deployed',
        }),
      );
    }
  }

  const declared = new Set<string>();
  controllers.forEach((controller, index) => {
    const path = `controllers.${index}`;
    if (declared.has(controller.path)) {
      errors.push(
        issue(`${path}.path`, `Route ${controller.path} declared twice`, 'Keep one controller per route.', {
          received: controller.path,
          expected: 'a unique route',
        }),
      );
    }
    declared.add(controller.path);
    checkFile(root, controller.handler, `${path}.handler`, 'Controller', errors);
    checkHandler(root, controller.handler, `${path}.handler`, errors);
    for (const need of controller.needs ?? []) {
      const match = /^(.+)\.(read|write)$/.exec(need);
      if (!match) {
        errors.push(
          issue(`${path}.needs`, `Malformed need "${need}"`, 'Use "<table>.read" or "<table>.write".', {
            received: need,
            expected: '<table>.read or <table>.write',
          }),
        );
      } else if (!tables[match[1]!]) {
        errors.push(
          issue(`${path}.needs`, `Unknown table "${match[1]}"`, 'Declare this table under "tables".', {
            received: need,
            expected: Object.keys(tables),
          }),
        );
      }
    }
  });

  if (manifest.health && !declared.has(`GET ${manifest.health}`)) {
    errors.push(
      issue(
        'health',
        `No "GET ${manifest.health}" controller`,
        'Declare this controller under "controllers" or remove "health".',
        { received: manifest.health, expected: [...declared] },
      ),
    );
  }

  for (const name of manifest.exposes?.data ?? []) {
    if (!tables[name] && !grantedShared.has(name)) {
      errors.push(
        issue('exposes.data', `Unknown exposed data "${name}"`, "List only the app's tables.", {
          received: name,
          expected: Object.keys(tables),
        }),
      );
    }
  }

  (manifest.exposes?.mcp ?? []).forEach((tool, index) => {
    if (!declared.has(tool.calls)) {
      errors.push(
        issue(`exposes.mcp.${index}.calls`, `No "${tool.calls}" controller`, 'An MCP tool must call a declared controller.', {
          received: tool.calls,
          expected: [...declared],
        }),
      );
    }
  });

  if (manifest.tests) checkFile(root, manifest.tests, 'tests', 'Test file', errors);

  return { errors, warnings };
}
