import { join } from 'node:path';
import type { Manifest, Table } from '@archipel/manifest-schema';
import { ruleFor } from '@archipel/manifest-schema';
import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { CONFIG } from '../config/tokens.js';
import { DATABASE } from '../database/database.js';
import { Store } from '../database/store.js';
import { liveNamespace, previewNamespace } from '../pipeline/migrate.js';
import type { Config } from '../types.js';
import * as crud from './crud.js';
import { createEgress, EgressError } from './sandbox/egress.js';
import { Sandbox } from './sandbox/host.js';
import { containerLauncher, processLauncher } from './sandbox/launchers.js';

const { ApiError } = crud;

type Access = 'read' | 'write';
type LogLevel = 'info' | 'warn' | 'error';

interface CompiledController {
  method: string;
  segments: string[];
  handler: string;
  needs: string[];
}

export interface Mount {
  key: string;
  appId: string;
  releaseId: string;
  preview: boolean;
  manifest: Manifest;
  // Rules the controllers' `fetch` may use: a preview only gets those already approved for the app.
  network: string[];
  root: string;
  ns: { own: string; shared: string };
  apiBase: string;
  controllers: CompiledController[];
  log: (level: LogLevel, message: string) => void;
  host: Sandbox;
}

interface AppUser {
  sub: string;
  name: string;
  roles: string[];
}

export interface AppRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  user: AppUser;
}

export interface AppResponse {
  status: number;
  body: unknown;
}

interface RoutedRequest extends Required<Omit<AppRequest, 'path' | 'body'>> {
  segments: string[];
  body?: unknown;
}

const QUOTA_REFRESH_MS = 30_000;
const LOG_TRIM_EVERY = 200;

function compileControllers(manifest: Manifest): CompiledController[] {
  return (manifest.controllers ?? []).map((controller) => {
    const [method = '', path = ''] = controller.path.split(' ');
    return { method, segments: path.split('/').filter(Boolean), handler: controller.handler, needs: controller.needs ?? [] };
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ApiError(400, 'Badly encoded path');
  }
}

function matchSegments(pattern: string[], segments: string[]) {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of pattern.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeSegment(segments[i]!);
    else if (part !== segments[i]) return null;
  }
  return params;
}

function hasAccess(definition: Table, access: Access, roles: string[]): boolean {
  if (roles.includes('admin')) return true;
  const allowed =
    access === 'read' ? [...(definition.rbac?.read ?? []), ...(definition.rbac?.write ?? [])] : (definition.rbac?.write ?? []);
  return allowed.some((role) => roles.includes(role));
}

// App routing is kept here, outside Fastify, so apps can be mounted and unmounted on the fly.
@Injectable()
export class Registry {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    @Inject(DATABASE) private readonly db: Knex,
  ) {}

  private readonly mounts = new Map<string, Mount>();

  private readonly sharedDefinition = (name: string): Table | null => {
    for (const mount of this.mounts.values()) {
      const tables = mount.manifest.tables ?? {};
      if (!mount.preview && Object.hasOwn(tables, name)) return tables[name]!;
    }
    return null;
  };

  readonly sharedCatalog = () => {
    const catalog = new Map<string, { owner: string; definition: Table }>();
    for (const mount of this.mounts.values()) {
      if (mount.preview) continue;
      for (const [name, definition] of Object.entries(mount.manifest.tables ?? {})) {
        if (name.startsWith('shared.')) catalog.set(name, { owner: mount.appId, definition });
      }
    }
    return catalog;
  };

  readonly liveRoutes = () => {
    const routes: Record<string, string> = {};
    for (const mount of this.mounts.values()) {
      if (!mount.preview && mount.manifest.frontend) routes[mount.manifest.frontend.route] = mount.appId;
    }
    return routes;
  };

  private readonly tableFor = (mount: Mount, name: string, write = false) =>
    crud.resolveTable(mount, name, { write, sharedDefinition: this.sharedDefinition });

  // Counting on every insert would cost a full read: the count is refreshed at intervals.
  private readonly rowCounts = new Map<string, { count: number; at: number }>();

  private async checkQuota(table: crud.ResolvedTable) {
    const known = this.rowCounts.get(table.physical);
    const count =
      known && Date.now() - known.at < QUOTA_REFRESH_MS
        ? known.count + 1
        : Number((await this.db(table.physical).count({ count: '*' }).first())?.count);
    this.rowCounts.set(table.physical, { count, at: known && count === known.count + 1 ? known.at : Date.now() });
    if (count >= this.config.limits.tableRows) {
      throw new ApiError(507, `Table ${table.name} is full (limit ${this.config.limits.tableRows} rows)`);
    }
  }

  private async insertRow(table: crud.ResolvedTable, row: unknown) {
    await this.checkQuota(table);
    return crud.insertRow(this.db, table, row);
  }

  private readonly launcherFor = (key: string, root: string) =>
    this.config.sandbox.mode === 'container'
      ? containerLauncher({ key, root, config: this.config })
      : processLauncher({ root, limits: this.config.limits });

  private hostCallFor(mount: Mount) {
    const declared = mount.manifest.permissions?.network ?? [];
    const egress = createEgress({
      limits: this.config.limits,
      ruleOf: (url) => {
        const rule = ruleFor(url, mount.network);
        if (!rule && mount.preview && ruleFor(url, declared)) {
          throw new EgressError(
            `Network refused in preview: ${url.protocol}//${url.host} is declared but not approved yet. ` +
              'A preview only reaches the hosts already approved for this app; the rule applies once a person approves this version.',
          );
        }
        return rule;
      },
    });
    return async (method: string, args: unknown[]) => {
      if (method === 'fetch') return egress((args[0] ?? {}) as Parameters<typeof egress>[0]);
      const [name, first, second] = args as [string, unknown, unknown];
      const id = first as Knex.Value;
      switch (method) {
        case 'list':
          return crud.listRows(this.db, this.tableFor(mount, name), first as crud.ListOptions);
        case 'get':
          return crud.getRow(this.db, this.tableFor(mount, name), id);
        case 'insert':
          return this.insertRow(this.tableFor(mount, name, true), first);
        case 'update':
          return crud.updateRow(this.db, this.tableFor(mount, name, true), id, second);
        case 'remove':
          return crud.deleteRow(this.db, this.tableFor(mount, name, true), id);
        default:
          throw new ApiError(400, `Unknown operation: ${method}`);
      }
    };
  }

  // Before a person approves it, a preview runs unreviewed code: its network stops at the rules
  // the live version already had approved, so it cannot reach an internal service or send data out.
  mountRelease(
    release: { id: string; app_id: string; manifest: Manifest },
    { preview, approvedNetwork = [] }: { preview: boolean; approvedNetwork?: readonly string[] },
  ): Mount {
    const appId = release.app_id;
    const key = preview ? release.id : appId;
    this.mounts.get(key)?.host.stop();
    const manifest = release.manifest;
    const root = join(this.config.dataDir, 'releases', release.id, 'app');
    let written = 0;
    const log = (level: LogLevel, message: string) => {
      written += 1;
      this.store
        .log(release.id, level, message)
        .then(() => (written % LOG_TRIM_EVERY === 0 ? this.store.trimLogs(release.id) : null))
        .catch(() => {});
    };
    const mount: Mount = {
      key,
      appId,
      releaseId: release.id,
      preview,
      manifest,
      network: (manifest.permissions?.network ?? []).filter((rule) => !preview || approvedNetwork.includes(rule)),
      root,
      ns: preview ? previewNamespace(release.id) : liveNamespace(appId),
      apiBase: `/run/${preview ? `p/${release.id}` : appId}`,
      controllers: compileControllers(manifest),
      log,
      // The sandbox needs the mount to answer calls: it is set right after.
      host: null as unknown as Sandbox,
    };
    mount.host = new Sandbox({
      launcher: this.launcherFor(key, root),
      limits: this.config.limits,
      hostCall: this.hostCallFor(mount),
      log,
    });
    this.mounts.set(key, mount);
    return mount;
  }

  unmount(key: string) {
    this.mounts.get(key)?.host.stop();
    this.mounts.delete(key);
  }

  private async handleData(mount: Mount, { method, segments, query, body, user }: RoutedRequest): Promise<AppResponse> {
    const name = decodeSegment(segments[1] ?? '');
    const write = method !== 'GET';
    const table = this.tableFor(mount, name, write);
    if (!table.definition.crud && !(name.startsWith('shared.') && !write)) {
      throw new ApiError(404, `No generated API for ${name}`);
    }
    if (!hasAccess(table.definition, write ? 'write' : 'read', user.roles)) {
      throw new ApiError(403, `${write ? 'write' : 'read'} permission required on ${name}`);
    }
    const id = segments[2] && decodeSegment(segments[2]);
    if (segments.length > 3 || (id && method === 'POST') || (!id && ['PATCH', 'DELETE'].includes(method))) {
      throw new ApiError(404, 'Unknown route');
    }

    switch (method) {
      case 'GET': {
        if (id) {
          const row = await crud.getRow(this.db, table, id);
          if (!row) throw new ApiError(404, 'Record not found');
          return { status: 200, body: row };
        }
        const { limit, offset, ...where } = query;
        return { status: 200, body: await crud.listRows(this.db, table, { where, limit, offset }) };
      }
      case 'POST':
        return { status: 201, body: await this.insertRow(table, body ?? {}) };
      case 'PATCH': {
        const row = await crud.updateRow(this.db, table, id!, body ?? {});
        if (!row) throw new ApiError(404, 'Record not found');
        return { status: 200, body: row };
      }
      case 'DELETE':
        if (!(await crud.deleteRow(this.db, table, id!))) throw new ApiError(404, 'Record not found');
        return { status: 204, body: null };
      default:
        throw new ApiError(405, 'Method not supported');
    }
  }

  private missingNeed(mount: Mount, controller: CompiledController, roles: string[]) {
    return controller.needs.find((need) => {
      const [, table, access] = /^(.+)\.(read|write)$/.exec(need)!;
      return !hasAccess(this.tableFor(mount, table!).definition, access as Access, roles);
    });
  }

  // `calls` is the declared route, as written in the manifest.
  canCall(mount: Mount, calls: string, roles: string[]) {
    const controller = mount.controllers.find(({ method, segments }) => `${method} /${segments.join('/')}` === calls);
    return controller !== undefined && !this.missingNeed(mount, controller, roles);
  }

  private async handleController(mount: Mount, { method, segments, query, body, user }: RoutedRequest): Promise<AppResponse> {
    for (const controller of mount.controllers) {
      if (controller.method !== method) continue;
      const params = matchSegments(controller.segments, segments);
      if (!params) continue;
      const missing = this.missingNeed(mount, controller, user.roles);
      if (missing) throw new ApiError(403, `${missing} permission required`);
      const value = await mount.host.invoke(controller.handler, { params, query, body: body ?? null, user });
      return { status: 200, body: value };
    }
    throw new ApiError(404, `No route ${method} /${segments.join('/')}`);
  }

  // Single entry point for calls to an app: HTTP and smoke tests take the same path.
  async dispatch(mount: Mount, { method, path, query = {}, body, user }: AppRequest): Promise<AppResponse> {
    const segments = path.split('/').filter(Boolean);
    try {
      return segments[0] === 'data'
        ? await this.handleData(mount, { method, segments, query, body, user })
        : await this.handleController(mount, { method, segments, query, body, user });
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, body: { error: error.message, details: error.details, issues: error.issues } };
      }
      const { stack, message } = error as Error;
      mount.log('error', `${method} ${path} : ${stack ?? message}`);
      return { status: 500, body: { error: 'Internal app error' } };
    }
  }

  get(key: string) {
    return this.mounts.get(key);
  }

  findByRoute(route: string) {
    for (const mount of this.mounts.values()) {
      if (!mount.preview && mount.manifest.frontend?.route === route) return mount;
    }
    return null;
  }

  stopAll() {
    for (const mount of this.mounts.values()) mount.host.stop();
  }
}
