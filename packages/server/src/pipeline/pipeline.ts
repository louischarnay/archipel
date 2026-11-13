import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, parseManifest, validateManifest, type Manifest } from '@archipel/manifest-schema';
import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { CONFIG } from '../config/tokens.js';
import { DATABASE } from '../database/database.js';
import { Store } from '../database/store.js';
import { Registry, type AppRequest, type Mount } from '../runtime/registry.js';
import type { AppRow, Config, Release, ReleaseStatus, Report, Stage, User, ValidRelease } from '../types.js';
import { diffExposure, diffPermissions, diffSchema } from './diff.js';
import { moveInto } from './intake.js';
import { applySchema, dropTables, liveNamespace, physicalName, previewNamespace, restoreMissing } from './migrate.js';
import { scanRelease } from './scan.js';
import { runChecks, runHealth } from './smoke.js';

export class DecisionError extends Error {}

type Prepared = { root: string; sourceInfo: unknown };
type Prepare = (workdir: string) => Promise<Prepared>;
type Submitter = { name: string; tokenId?: string; apps?: string[] | null };
type Actor = { user: User };

const valid = (release: Release | undefined) => release as ValidRelease;

const wasApproved = (release: Release) => release.status === 'superseded' && Boolean(release.decided_by);

@Injectable()
export class Pipeline {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    private readonly registry: Registry,
    @Inject(DATABASE) private readonly db: Knex,
  ) {}

  // Health and tests call the app the way HTTP does.
  private readonly dispatch = (mount: Mount, request: AppRequest) => this.registry.dispatch(mount, request);

  // The pipeline runs code and extracts archives: without a cap, a burst of submissions saturates the server.
  private readonly waiting: (() => Promise<void>)[] = [];
  private running = 0;

  private runNext() {
    while (this.running < this.config.limits.pipelinesAtOnce && this.waiting.length) {
      this.running += 1;
      this.waiting.shift()!().finally(() => {
        this.running -= 1;
        this.runNext();
      });
    }
  }

  private readonly enqueue = (task: () => Promise<unknown>) =>
    new Promise<unknown>((resolve) => {
      this.waiting.push(() => task().then(resolve));
      this.runNext();
    });

  private readonly releaseDir = (id: string) => join(this.config.dataDir, 'releases', id);

  private readonly previewTables = (manifest: Partial<Manifest>) => {
    const tables: NonNullable<Manifest['tables']> = { ...manifest.tables };
    const catalog = this.registry.sharedCatalog();
    for (const name of [...(manifest.permissions?.reads ?? []), ...(manifest.permissions?.writes ?? [])]) {
      if (!tables[name] && catalog.has(name)) tables[name] = catalog.get(name)!.definition;
    }
    return tables;
  };

  private async teardownPreview(release: Release) {
    if (!this.registry.get(release.id)) return;
    this.registry.unmount(release.id);
    await dropTables(this.db, previewNamespace(release.id), Object.keys(this.previewTables(release.manifest ?? {})));
  }

  // A new submission replaces the version still pending: this is the agent's iteration loop.
  // A version already rejected keeps its status, so that it never becomes eligible to go back online.
  private async supersedePending(appId: string, exceptId?: string) {
    const pending = await this.store.listReleases({ appId, statuses: ['in_review'] });
    for (const release of pending) {
      if (release.id === exceptId) continue;
      await this.teardownPreview(release);
      await this.store.updateRelease(release.id, { status: 'superseded', stage: null });
    }
  }

  private async runPipeline(releaseId: string, prepare: Prepare, allowedApps: string[] | null = null) {
    const report: Report & { stages: Stage[] } = { stages: [] };
    const save = (patch: Partial<Release>) => this.store.updateRelease(releaseId, { ...patch, report });
    const stage = async (id: string, status: string, detail: string) => {
      report.stages.push({ id, status, detail, at: new Date().toISOString() });
      await save({ stage: id });
    };
    const fail = async (id: string, detail: string) => {
      await stage(id, 'failed', detail);
      report.summary = detail;
      await save({ status: 'failed', stage: null });
      await this.store.log(releaseId, 'error', detail);
    };

    const workdir = join(this.releaseDir(releaseId), 'incoming');
    try {
      mkdirSync(workdir, { recursive: true });
      const { root, sourceInfo } = await prepare(workdir);
      report.source = sourceInfo;

      const { manifest: parsed, errors: parseErrors } = parseManifest(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
      // Not validated yet: hence the `?.` up to the validation result.
      const manifest = parsed as Manifest;
      if (parseErrors.length) {
        report.validation = { errors: parseErrors, warnings: [] };
        return await fail('validate', 'Unreadable manifest');
      }

      const sharedTables = this.registry.sharedCatalog();
      const validation = validateManifest(manifest, root, { routes: this.registry.liveRoutes(), sharedTables });
      for (const name of Object.keys(manifest?.tables ?? {})) {
        const owner = sharedTables.get(name)?.owner;
        if (owner && owner !== manifest.id) {
          validation.errors.push({
            path: `tables.${name}`,
            message: `${name} belongs to the app ${owner}`,
            hint: `Remove this table and read it through permissions.reads.`,
          });
        }
      }
      // Only on a valid manifest: the id and the tables are then well formed.
      if (!validation.errors.length) {
        for (const { table, owner, physical } of await this.foreignTables(manifest.id, manifest.tables ?? {})) {
          validation.errors.push({
            path: `tables.${table}`,
            message: `${table} would be stored as ${physical}, a table that belongs to the app ${owner}`,
            hint: `Rename this table: names are joined with underscores, so another app id and table name give the same result.`,
          });
        }
      }
      if (allowedApps && !allowedApps.includes(manifest?.id)) {
        validation.errors.push({
          path: 'id',
          message: `This token is not allowed for the app ${manifest?.id}`,
          hint: `Allowed apps: ${allowedApps.join(', ')}. Ask an administrator for a token for this app.`,
        });
      }
      report.validation = validation;
      if (validation.errors.length) {
        const appId = typeof manifest?.id === 'string' ? manifest.id : null;
        await this.store.updateRelease(releaseId, {
          app_id: appId,
          version: typeof manifest?.version === 'string' ? manifest.version : null,
        });
        return await fail('validate', `${validation.errors.length} error(s) in the manifest`);
      }
      await stage('validate', 'ok', `Manifest ${manifest.id} ${manifest.version} valid`);

      await this.store.ensureApp({ id: manifest.id, name: manifest.name, group_id: manifest.group ?? null });
      await this.store.updateRelease(releaseId, { app_id: manifest.id, version: manifest.version, manifest });

      const appDir = join(this.releaseDir(releaseId), 'app');
      moveInto(root, appDir);
      rmSync(workdir, { recursive: true, force: true });

      report.scan = scanRelease(appDir, manifest);
      if (report.scan.blocked) {
        return await fail('scan', 'The scan blocked this version: no code was run');
      }
      await stage('scan', 'ok', `${report.scan.findings.length} point(s) to check`);

      const app = (await this.store.getApp(manifest.id))!;
      const live = app.live_release_id ? await this.store.getRelease(app.live_release_id) : null;
      report.diff = {
        firstRelease: !live,
        previousVersion: live?.version ?? null,
        schema: diffSchema(app.applied_tables, manifest.tables ?? {}),
        permissions: diffPermissions(live?.manifest, manifest),
        exposure: diffExposure(live?.manifest, manifest),
      };
      await stage('diff', 'ok', `${report.diff.schema.length} schema change(s)`);

      const ns = previewNamespace(releaseId);
      await applySchema(this.db, { ns, before: {}, after: this.previewTables(manifest) });
      const release = valid(await this.store.getRelease(releaseId));
      const mount = this.registry.mountRelease(release, {
        preview: true,
        approvedNetwork: await this.approvedNetwork(manifest.id),
      });
      await stage('preview', 'ok', 'Isolated preview started, on empty tables');

      report.checks = await runChecks(mount, this.dispatch);
      if (!report.checks.ok) {
        await this.teardownPreview(release);
        return await fail('checks', 'Health or tests failed');
      }
      await stage('checks', 'ok', `${report.checks.smoke.length} test(s) passed`);

      // The reviewer must start from empty tables, without what the tests left behind.
      for (const table of Object.keys(this.previewTables(manifest))) await this.db(physicalName(ns, table)).del();

      await this.supersedePending(manifest.id, releaseId);
      report.summary = 'Ready for review';
      await save({ status: 'in_review', stage: null });
    } catch (failure) {
      const error = failure as Error;
      await this.store.log(releaseId, 'error', error.stack ?? error.message);
      await this.teardownPreview((await this.store.getRelease(releaseId))!);
      await fail(report.stages.at(-1)?.id ?? 'intake', error.message);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  // Network rules a person already approved for this app: those of its live version.
  private async approvedNetwork(appId: string) {
    const app = await this.store.getApp(appId);
    const live = app?.live_release_id ? valid(await this.store.getRelease(app.live_release_id)) : null;
    return live?.manifest.permissions?.network ?? [];
  }

  // Hyphens become underscores in physical names, so `crm-data` + `customer` and `crm` + `data_customer`
  // would share `app_crm_data_customer`. A physical table another app already holds is refused, so an
  // app never reads or writes another app's private rows. Uninstalled apps keep their tables, and their claim.
  private async foreignTables(appId: string, tables: Record<string, unknown>) {
    const ns = liveNamespace(appId);
    const wanted = new Map(
      Object.keys(tables)
        .filter((name) => !name.startsWith('shared.'))
        .map((name) => [physicalName(ns, name), name]),
    );
    const clashes: { table: string; owner: string; physical: string }[] = [];
    for (const other of await this.store.listApps()) {
      if (other.id === appId) continue;
      for (const name of Object.keys(other.applied_tables)) {
        const physical = physicalName(liveNamespace(other.id), name);
        const table = wanted.get(physical);
        if (table) clashes.push({ table, owner: other.id, physical });
      }
    }
    return clashes;
  }

  private async assertOwnTables(appId: string, tables: Record<string, unknown>) {
    const [clash] = await this.foreignTables(appId, tables);
    if (clash) {
      throw new DecisionError(`The table ${clash.table} maps to ${clash.physical}, which belongs to the app ${clash.owner}.`);
    }
  }

  async submit({
    sourceType,
    sourceLabel,
    user,
    prepare,
  }: {
    sourceType: string;
    sourceLabel: string;
    user: Submitter;
    prepare: Prepare;
  }) {
    if (this.waiting.length >= this.config.limits.pipelineQueue) {
      throw Object.assign(new Error('Too many versions this.waiting to be processed: try again in a few minutes.'), {
        statusCode: 429,
      });
    }
    const id = `rel${randomBytes(6).toString('hex')}`;
    await this.store.createRelease({
      id,
      status: 'processing',
      stage: 'intake',
      source_type: sourceType,
      source_label: sourceLabel,
      submitted_by: user.name,
      submitted_token: user.tokenId ?? null,
    });
    await this.store.audit(user.name, 'release.submit', { releaseId: id, detail: { source: sourceLabel } });
    const done = this.enqueue(() =>
      this.runPipeline(id, prepare, user.apps).catch((error: Error) => this.store.log(id, 'error', error.stack ?? error.message)),
    );
    return { id, done };
  }

  private async raiseChangeAlerts(release: ValidRelease, report: Report) {
    const { permissions, exposure, firstRelease } = report.diff!;
    const added = (label: string, diff: { added: string[] }) => diff.added.length && `${label}: ${diff.added.join(', ')}`;
    const parts = [
      added('exposed data', exposure.data),
      added('MCP tools', exposure.mcp),
      added('network', permissions.network),
      added('shared read', permissions.reads),
      added('shared write', permissions.writes),
    ].filter(Boolean);
    if (parts.length) {
      const prefix = firstRelease ? 'New app' : 'New access';
      await this.store.addAlert(
        release.app_id,
        release.id,
        `${prefix} ${release.manifest.name} ${release.version} — ${parts.join('; ')}`,
      );
    }
  }

  async approve(
    id: string,
    { user, comment, allowDestructive }: Actor & { comment?: string | null | undefined; allowDestructive: boolean },
  ) {
    const release = valid(await this.store.getRelease(id));
    if (release?.status !== 'in_review') throw new DecisionError('This version is not this.waiting for review.');

    const app = (await this.store.getApp(release.app_id))!;
    const tables = release.manifest.tables ?? {};
    // Checked again: another app may have been approved with a clashing table since the submission.
    await this.assertOwnTables(release.app_id, tables);
    const schema = diffSchema(app.applied_tables, tables);
    const destructive = schema.filter((change) => change.destructive);
    if (destructive.length && !allowDestructive) {
      throw new DecisionError('This version contains destructive changes: explicit confirmation required.');
    }

    const ns = liveNamespace(release.app_id);
    const applied = await this.db.transaction((trx) =>
      applySchema(trx, {
        ns,
        before: app.applied_tables,
        after: tables,
        allowDestructive: destructive.length > 0,
        snapshotSuffix: release.id,
      }),
    );

    await this.teardownPreview(release);
    const previous = app.live_release_id;
    const mount = this.registry.mountRelease(release, { preview: false });

    if (previous) await this.store.updateRelease(previous, { status: 'superseded' });
    await this.store.ensureGroup(release.manifest.group);
    await this.store.updateApp(release.app_id, {
      name: release.manifest.name,
      group_id: release.manifest.group ?? null,
      status: 'live',
      live_release_id: id,
      applied_tables: tables,
    });

    const report = { ...release.report, migration: applied };
    report.liveHealth = await runHealth(mount, this.dispatch);
    if (report.liveHealth && !report.liveHealth.ok) {
      await this.store.addAlert(release.app_id, id, `Health failed after ${release.manifest.name} ${release.version} went live`);
    }
    await this.store.updateRelease(id, {
      status: 'live',
      report,
      decided_at: new Date().toISOString(),
      decided_by: user.name,
      decision_comment: comment ?? null,
    });
    await this.raiseChangeAlerts(release, report);
    await this.store.audit(user.name, 'release.approve', {
      appId: release.app_id,
      releaseId: id,
      detail: { version: release.version, comment, destructive: destructive.length, migration: applied.length },
    });
    return this.store.getRelease(id);
  }

  async decline(id: string, { user, comment, status }: Actor & { comment?: string | null | undefined; status: ReleaseStatus }) {
    const release = valid(await this.store.getRelease(id));
    if (release?.status !== 'in_review') throw new DecisionError('This version is not this.waiting for review.');
    if (!comment?.trim()) throw new DecisionError('Explain the decision: this comment is sent back to the agent.');

    await this.teardownPreview(release);
    await this.store.updateRelease(id, {
      status,
      decided_at: new Date().toISOString(),
      decided_by: user.name,
      decision_comment: comment,
    });
    await this.store.audit(user.name, status === 'rejected' ? 'release.reject' : 'release.request_changes', {
      appId: release.app_id,
      releaseId: id,
      detail: { version: release.version, comment },
    });
    return this.store.getRelease(id);
  }

  // Removing the owner of a shared table would silently break the apps that read it.
  private async assertNoDependents(app: AppRow) {
    const owned = Object.keys(app.applied_tables).filter((name) => name.startsWith('shared.'));
    const dependents: string[] = [];
    for (const other of await this.store.listApps()) {
      if (other.id === app.id || !other.live_release_id) continue;
      const { manifest } = valid(await this.store.getRelease(other.live_release_id));
      const { reads = [], writes = [] } = manifest.permissions ?? {};
      if (owned.some((name) => reads.includes(name) || writes.includes(name))) dependents.push(other.name);
    }
    if (dependents.length) {
      throw new DecisionError(`Shared tables used by: ${dependents.join(', ')}.`);
    }
  }

  async rollback(appId: string, releaseId: string | undefined, { user }: Actor) {
    const app = await this.store.getApp(appId);
    const target = releaseId ? valid(await this.store.getRelease(releaseId)) : undefined;
    if (!releaseId || !app?.live_release_id || !target || target.app_id !== appId) {
      throw new DecisionError('Version not found for this app.');
    }
    if (!wasApproved(target)) {
      throw new DecisionError('Only an already approved version can be put back online.');
    }

    const ns = liveNamespace(appId);
    const tables = target.manifest.tables ?? {};
    await this.assertOwnTables(appId, tables);
    const restored = await restoreMissing(this.db, { ns, target: tables });
    await this.store.updateRelease(app.live_release_id, { status: 'superseded' });
    await this.store.updateRelease(releaseId, { status: 'live' });
    await this.store.updateApp(appId, {
      name: target.manifest.name,
      group_id: target.manifest.group ?? null,
      status: 'live',
      live_release_id: releaseId,
      applied_tables: tables,
    });
    this.registry.mountRelease(target, { preview: false });
    await this.store.audit(user.name, 'release.rollback', {
      appId,
      releaseId,
      detail: { version: target.version, from: app.live_release_id, restored },
    });
    return { restored };
  }

  // An agent does not change what is live: it reports the need, and a person decides from the app's page.
  async requestRollback(
    appId: string,
    releaseId: string | undefined,
    { actor, reason }: { actor: string; reason?: string | null | undefined },
  ) {
    const app = await this.store.getApp(appId);
    const candidates = (await this.store.listReleases({ appId })).filter(wasApproved);
    const target = releaseId ? candidates.find((release) => release.id === releaseId) : candidates[0];
    if (!app?.live_release_id || !target) throw new DecisionError('No approved version to put back online for this app.');
    const why = reason?.trim() ? `: ${reason.trim().slice(0, 500)}` : '';
    const message = `${actor} asks to roll ${app.name} back to version ${target.version}${why}`;
    await this.store.addAlert(appId, target.id, message, 'rollback_request');
    await this.store.audit(actor, 'release.rollback_request', {
      appId,
      releaseId: target.id,
      detail: { version: target.version, reason: reason ?? null },
    });
    return target;
  }

  async setEnabled(appId: string, enabled: boolean, { user }: Actor) {
    const app = await this.store.getApp(appId);
    if (!app?.live_release_id) throw new DecisionError('This app has no live version.');
    if (enabled) {
      this.registry.mountRelease(valid(await this.store.getRelease(app.live_release_id)), { preview: false });
    } else {
      await this.assertNoDependents(app);
      this.registry.unmount(appId);
    }
    await this.store.updateApp(appId, { status: enabled ? 'live' : 'disabled' });
    await this.store.audit(user.name, enabled ? 'app.enable' : 'app.disable', { appId });
  }

  // The data stays in the database: a reinstall finds its tables again.
  async uninstall(appId: string, { user }: Actor) {
    const app = await this.store.getApp(appId);
    if (!app) throw new DecisionError('App not found.');
    await this.assertNoDependents(app);
    await this.supersedePending(appId);
    this.registry.unmount(appId);
    if (app.live_release_id) await this.store.updateRelease(app.live_release_id, { status: 'superseded' });
    await this.store.updateApp(appId, { status: 'uninstalled', live_release_id: null });
    await this.store.audit(user.name, 'app.uninstall', { appId });
  }

  // At startup: no version can stay "processing", and the mounts are rebuilt.
  async resume() {
    for (const release of await this.store.listReleases({ statuses: ['processing'] })) {
      await this.store.updateRelease(release.id, { status: 'failed', stage: null });
      await this.store.log(release.id, 'error', 'Processing interrupted by a restart: this.submit again.');
    }
    const apps = await this.store.listApps();
    for (const app of apps.filter((row) => row.status === 'live' && row.live_release_id)) {
      this.registry.mountRelease(valid(await this.store.getRelease(app.live_release_id!)), { preview: false });
    }
    for (const release of await this.store.listReleases({ statuses: ['in_review'] })) {
      if (existsSync(join(this.releaseDir(release.id), 'app'))) {
        this.registry.mountRelease(valid(release), {
          preview: true,
          approvedNetwork: await this.approvedNetwork(release.app_id!),
        });
      }
    }
  }
}
