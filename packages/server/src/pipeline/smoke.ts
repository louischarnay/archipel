import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Column, Table } from '@archipel/manifest-schema';
import { parse } from 'yaml';
import type { AppRequest, AppResponse, Mount } from '../runtime/registry.js';

type Dispatch = (mount: Mount, request: AppRequest) => Promise<AppResponse>;
type Vars = Record<string, unknown>;

interface Check {
  name: string;
  ok: boolean;
  generated?: boolean;
  status?: number;
  expected?: string;
  message?: string | undefined;
}

export interface Health {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface Checks {
  health: Health | null;
  smoke: Check[];
  ok: boolean;
}

interface DeclaredTest {
  name?: string;
  request?: string;
  as?: string;
  body?: unknown;
  expect?: { status?: number; body?: unknown };
  save?: Record<string, string>;
}

const rolesFor = (as: string) => (as === 'user' ? ['user'] : ['user', as]);
const userFor = (as: string) => ({ sub: 'smoke', name: 'Automatic tests', roles: rolesFor(as) });

function sampleValue(column: Column, seed: string) {
  switch (column.type) {
    case 'integer':
      return 1;
    case 'number':
      return 1.5;
    case 'boolean':
      return true;
    case 'enum':
      return column.values?.[0];
    case 'date':
      return '2026-01-01';
    case 'datetime':
      return '2026-01-01T00:00:00.000Z';
    case 'json':
      return { smoke: true };
    case 'uuid':
    case 'ref':
      return '00000000-0000-4000-8000-000000000001';
    default:
      return `smoke ${seed}`;
  }
}

function sampleRow(definition: Table) {
  const row: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(definition.columns)) {
    if (column.pk && column.type !== 'integer') continue;
    if (column.pk || column.required) row[name] = sampleValue(column, name);
  }
  return row;
}

const pk = (definition: Table) => Object.entries(definition.columns).find(([, column]) => column.pk)![0];

async function runGenerated(mount: Mount, dispatch: Dispatch, results: Check[]) {
  const check = async (name: string, request: AppRequest, expected: number[]) => {
    const response = await dispatch(mount, { query: {}, ...request });
    const ok = expected.includes(response.status);
    results.push({
      name,
      generated: true,
      ok,
      status: response.status,
      expected: expected.join(' or '),
      message: ok ? undefined : JSON.stringify(response.body),
    });
    return ok ? response : null;
  };

  for (const [name, definition] of Object.entries(mount.manifest.tables ?? {})) {
    if (!definition.crud) continue;
    const base = `/data/${name}`;
    const admin = userFor('admin');
    await check(`List ${name}`, { method: 'GET', path: base, user: admin }, [200]);

    const created = await check(
      `Create ${name}`,
      { method: 'POST', path: base, body: sampleRow(definition), user: admin },
      [201],
    );
    if (created) {
      const id = (created.body as Record<string, unknown>)[pk(definition)];
      await check(`Read ${name}`, { method: 'GET', path: `${base}/${id}`, user: admin }, [200]);
      await check(`Delete ${name}`, { method: 'DELETE', path: `${base}/${id}`, user: admin }, [204]);
    }

    if (!definition.rbac?.write?.includes('user')) {
      await check(
        `Write to ${name} refused without a role`,
        { method: 'POST', path: base, body: sampleRow(definition), user: userFor('user') },
        [403],
      );
    }
  }
}

function containsSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => containsSubset((actual as Vars)[key], value));
}

const substitute = (value: unknown, vars: Vars): unknown =>
  typeof value === 'string'
    ? value.replace(/\$\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
    : value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map((item) => substitute(item, vars))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]))
      : value;

async function runDeclared(mount: Mount, dispatch: Dispatch, results: Check[]) {
  const file = mount.manifest.tests;
  if (!file) return;
  let tests: DeclaredTest[];
  try {
    tests = (parse(readFileSync(join(mount.root, file), 'utf8')) as { tests?: DeclaredTest[] } | null)?.tests ?? [];
  } catch (error) {
    results.push({ name: file, ok: false, message: `Unreadable test file: ${(error as Error).message}` });
    return;
  }

  const vars: Vars = {};
  for (const test of tests) {
    const [method = '', path = ''] = (substitute(test.request ?? '', vars) as string).split(' ');
    const expectedStatus = test.expect?.status ?? 200;
    const response = await dispatch(mount, {
      method,
      path,
      query: {},
      body: substitute(test.body, vars),
      user: userFor(test.as ?? 'admin'),
    });
    const statusOk = response.status === expectedStatus;
    const bodyOk = test.expect?.body === undefined || containsSubset(response.body, substitute(test.expect.body, vars));
    const ok = statusOk && bodyOk;
    results.push({
      name: test.name ?? test.request ?? '',
      ok,
      status: response.status,
      expected: String(expectedStatus),
      message: ok ? undefined : JSON.stringify(response.body),
    });
    for (const [name, field] of Object.entries(test.save ?? {})) vars[name] = (response.body as Vars | null)?.[field];
  }
}

export async function runHealth(mount: Mount, dispatch: Dispatch): Promise<Health | null> {
  if (!mount.manifest.health) return null;
  const response = await dispatch(mount, { method: 'GET', path: mount.manifest.health, query: {}, user: userFor('admin') });
  return { ok: response.status === 200, status: response.status, body: response.body };
}

export async function runChecks(mount: Mount, dispatch: Dispatch): Promise<Checks> {
  const health = await runHealth(mount, dispatch);
  const smoke: Check[] = [];
  await runGenerated(mount, dispatch, smoke);
  await runDeclared(mount, dispatch, smoke);
  return { health, smoke, ok: (health?.ok ?? true) && smoke.every((test) => test.ok) };
}
