import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { CONFIG } from '../config/tokens.js';
import { DATABASE } from './database.js';
import { subkey } from '../config/keys.js';
import { auditOrigin } from '../http/request-context.js';
import type {
  Alert,
  AppRow,
  AuditEntry,
  Config,
  ExternalLink,
  Group,
  LogEntry,
  Release,
  ReleaseStatus,
  SessionRecord,
  StoredAgentToken,
} from '../types.js';

const LOG_LIMIT = 500;
const TOUCH_EVERY_MS = 60_000;
const AUDIT_BATCH = 1000;
const AUDIT_FIELDS = ['actor', 'action', 'app_id', 'release_id', 'detail', 'actor_type', 'actor_id', 'ip', 'request_id'] as const;

interface AuditRow {
  at: string;
  actor: string;
  action: string;
  app_id: string | null;
  release_id: string | null;
  detail: string | null;
  actor_type: string;
  actor_id: string | null;
  ip: string | null;
  request_id: string | null;
}

export interface AuditOptions {
  appId?: string | null;
  releaseId?: string | null;
  detail?: object;
  actor?: { type: string; id: string };
}

export interface ReleaseFilter {
  appId?: string | undefined;
  statuses?: ReleaseStatus[];
  submittedToken?: string;
  byAgent?: boolean;
  limit?: number;
}

type RawRelease = Omit<Release, 'manifest' | 'report'> & { manifest: string | null; report: string };
type NewRelease = Pick<Release, 'id' | 'status' | 'stage' | 'source_type' | 'source_label' | 'submitted_by' | 'submitted_token'>;
type Raw<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };

const now = () => new Date().toISOString();

const parseRelease = (row: RawRelease): Release => ({
  ...row,
  manifest: row.manifest ? (JSON.parse(row.manifest) as Release['manifest']) : null,
  report: JSON.parse(row.report) as Release['report'],
});

const parseApp = (row: Raw<AppRow, 'applied_tables'>): AppRow => ({
  ...row,
  applied_tables: JSON.parse(row.applied_tables!) as AppRow['applied_tables'],
});

const parseSession = (row: Raw<SessionRecord, 'user'>): SessionRecord => ({
  ...row,
  user: JSON.parse(row.user!) as SessionRecord['user'],
});

const parseToken = (row: Raw<StoredAgentToken, 'apps'>): StoredAgentToken => ({
  ...row,
  apps: row.apps ? (JSON.parse(row.apps) as string[]) : null,
});

const parseAudit = (row: Raw<AuditEntry, 'detail'>): AuditEntry => ({
  ...row,
  detail: row.detail ? (JSON.parse(row.detail) as AuditEntry['detail']) : null,
});

// Each line seals the previous one: without the secret, changing or removing a line shows up at verification.
function auditMac(key: Buffer, previous: string, row: AuditRow) {
  const fields = [new Date(row.at).toISOString(), ...AUDIT_FIELDS.map((field) => row[field] ?? null)];
  return createHmac('sha256', key).update(previous).update('\0').update(JSON.stringify(fields)).digest();
}

// Platform queries, apart from the deployment logic.
@Injectable()
export class Store {
  // One write at a time: two lines must not seal the same previous one.
  private auditTail: Promise<void> = Promise.resolve();
  private readonly secrets: string[];

  constructor(
    @Inject(DATABASE) readonly db: Knex,
    @Inject(CONFIG) config: Pick<Config, 'secrets'>,
  ) {
    this.secrets = config.secrets;
  }

  private async appendAudit(row: AuditRow) {
    const last = await this.db('platform_audit').whereNotNull('hash').orderBy('id', 'desc').first('hash');
    const { key, kid } = subkey(this.secrets[0]!, 'audit');
    const mac = auditMac(key, last?.hash ?? '', row).toString('base64url');
    await this.db('platform_audit').insert({ ...row, hash: `${kid}.${mac}` });
  }

  async listApps(): Promise<AppRow[]> {
    return (await this.db('platform_apps').whereNot('status', 'uninstalled').orderBy('name')).map(parseApp);
  }
  async getApp(id: string): Promise<AppRow | undefined> {
    const row = await this.db('platform_apps').where({ id }).first();
    return row && parseApp(row);
  }
  // The name and group of an existing app only change when a version is approved.
  async ensureApp({ id, name, group_id }: Pick<AppRow, 'id' | 'name' | 'group_id'>): Promise<void> {
    const existing = await this.getApp(id);
    if (!existing) await this.db('platform_apps').insert({ id, name, group_id, created_at: now() });
    else if (existing.status === 'uninstalled') await this.updateApp(id, { status: 'pending' });
  }
  async updateApp(id: string, patch: Partial<AppRow>): Promise<void> {
    const row: Record<string, unknown> = { ...patch };
    if (row.applied_tables) row.applied_tables = JSON.stringify(row.applied_tables);
    await this.db('platform_apps').where({ id }).update(row);
  }

  async listGroups(): Promise<Group[]> {
    return this.db('platform_groups').orderBy('name');
  }
  async ensureGroup(id: string | null | undefined) {
    if (!id) return;
    const name = id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
    await this.db('platform_groups').insert({ id, name }).onConflict('id').ignore();
  }
  async renameGroup(id: string, name: string): Promise<number> {
    return this.db('platform_groups').where({ id }).update({ name });
  }

  async listLinks(): Promise<ExternalLink[]> {
    const rows = await this.db('platform_links').orderBy('name').select('id', 'name', 'url', 'group_id', 'icon_type');
    return rows.map(({ icon_type, ...row }) => ({ ...row, hasIcon: Boolean(icon_type) }));
  }
  async addLink(
    { hasIcon: _, ...link }: ExternalLink,
    icon: { bytes: Buffer; type: string } | null,
    createdBy: string,
  ): Promise<void> {
    await this.db('platform_links').insert({
      ...link,
      icon: icon?.bytes ?? null,
      icon_type: icon?.type ?? null,
      created_at: now(),
      created_by: createdBy,
    });
  }
  async removeLink(id: string): Promise<void> {
    await this.db('platform_links').where({ id }).del();
  }
  async getLinkIcon(id: string): Promise<{ icon: Buffer; icon_type: string } | undefined> {
    return this.db('platform_links').where({ id }).whereNotNull('icon_type').first('icon', 'icon_type');
  }

  async createRelease(release: NewRelease & Partial<Pick<Release, 'manifest' | 'report'>>) {
    await this.db('platform_releases').insert({
      ...release,
      manifest: release.manifest ? JSON.stringify(release.manifest) : null,
      report: JSON.stringify(release.report ?? {}),
      created_at: now(),
    });
  }
  async getRelease(id: string): Promise<Release | undefined> {
    const row = await this.db('platform_releases').where({ id }).first();
    return row && parseRelease(row);
  }
  async updateRelease(id: string, patch: Partial<Release>) {
    const row: Record<string, unknown> = { ...patch };
    if ('manifest' in row) row.manifest = JSON.stringify(row.manifest);
    if ('report' in row) row.report = JSON.stringify(row.report);
    await this.db('platform_releases').where({ id }).update(row);
  }
  async listReleases(filter: ReleaseFilter = {}): Promise<Release[]> {
    const query = this.db('platform_releases').orderBy('created_at', 'desc').orderBy('id', 'desc');
    if (filter.appId) query.where('app_id', filter.appId);
    if (filter.statuses) query.whereIn('status', filter.statuses);
    if (filter.submittedToken) query.where('submitted_token', filter.submittedToken);
    if (filter.byAgent) query.whereNotNull('submitted_token');
    if (filter.limit) query.limit(filter.limit);
    return (await query).map(parseRelease);
  }

  async createAgentToken({
    apps,
    ...row
  }: Pick<StoredAgentToken, 'id' | 'name' | 'expires_at' | 'apps'> & { token_hash: string }) {
    await this.db('platform_agent_tokens').insert({ ...row, apps: apps ? JSON.stringify(apps) : null, created_at: now() });
  }
  async findAgentToken(tokenHash: string): Promise<StoredAgentToken | null> {
    const row = await this.db('platform_agent_tokens').where({ token_hash: tokenHash }).whereNull('revoked_at').first();
    return row && new Date(row.expires_at) > new Date() ? parseToken(row) : null;
  }
  async touchAgentToken({ id, last_used_at: seen }: Pick<StoredAgentToken, 'id' | 'last_used_at'>) {
    if (seen && Date.now() - new Date(seen).getTime() < TOUCH_EVERY_MS) return;
    await this.db('platform_agent_tokens').where({ id }).update({ last_used_at: now() });
  }
  async listAgentTokens(): Promise<StoredAgentToken[]> {
    const rows = await this.db('platform_agent_tokens')
      .select('id', 'name', 'apps', 'created_at', 'expires_at', 'revoked_at', 'last_used_at')
      .orderBy('created_at', 'desc');
    return rows.map(parseToken);
  }
  async revokeAgentToken(id: string): Promise<number> {
    return this.db('platform_agent_tokens').where({ id }).whereNull('revoked_at').update({ revoked_at: now() });
  }

  async createSession(row: object) {
    await this.db('platform_sessions').insert(row);
  }
  async findSession(where: { id: string } | { token_hash: string }): Promise<SessionRecord | undefined> {
    const row = await this.db('platform_sessions').where(where).first();
    return row && parseSession(row);
  }
  async touchSession(id: string, at: string) {
    await this.db('platform_sessions').where({ id }).update({ last_seen_at: at });
  }
  async revokeSession(id: string): Promise<number> {
    return this.db('platform_sessions').where({ id }).whereNull('revoked_at').update({ revoked_at: now() });
  }
  async listSessions(): Promise<SessionRecord[]> {
    const rows = await this.db('platform_sessions')
      .whereNull('revoked_at')
      .where('expires_at', '>', now())
      .orderBy('last_seen_at', 'desc');
    return rows.map(parseSession);
  }
  async purgeSessions() {
    await this.db('platform_sessions').where('expires_at', '<', now()).del();
  }

  async log(releaseId: string, level: string, message: string) {
    await this.db('platform_logs').insert({ release_id: releaseId, level, message, at: now() });
  }
  async logs(releaseId: string, limit = 200): Promise<LogEntry[]> {
    const rows = await this.db('platform_logs').where({ release_id: releaseId }).orderBy('id', 'desc').limit(limit);
    return rows.reverse();
  }
  async trimLogs(releaseId: string) {
    const cutoff = await this.db('platform_logs')
      .where({ release_id: releaseId })
      .orderBy('id', 'desc')
      .offset(LOG_LIMIT)
      .first('id');
    if (cutoff) await this.db('platform_logs').where({ release_id: releaseId }).where('id', '<=', cutoff.id).del();
  }

  audit(name: string, action: string, { appId, releaseId, detail, actor }: AuditOptions = {}) {
    const origin = auditOrigin();
    const row: AuditRow = {
      at: now(),
      actor: name,
      action,
      app_id: appId ?? null,
      release_id: releaseId ?? null,
      detail: detail ? JSON.stringify(detail) : null,
      ...origin,
      ...(actor ? { actor_type: actor.type, actor_id: actor.id } : {}),
    };
    const written = this.auditTail.catch(() => {}).then(() => this.appendAudit(row));
    this.auditTail = written;
    return written;
  }
  // A refusal is written after the response: closing the database must wait for these lines.
  auditSettled() {
    return this.auditTail.catch(() => {});
  }
  // `broken`: first line that does not verify. `unverifiable`: sealed with a key removed since.
  async verifyAudit() {
    const keys = new Map(this.secrets.map((secret) => subkey(secret, 'audit')).map(({ kid, key }) => [kid, key]));
    const result: { entries: number; unchained: number; unverifiable: number; broken: number | null } = {
      entries: 0,
      unchained: 0,
      unverifiable: 0,
      broken: null,
    };
    let previous = '';
    let lastId = 0;
    for (;;) {
      const rows = await this.db('platform_audit').where('id', '>', lastId).orderBy('id').limit(AUDIT_BATCH);
      if (!rows.length) return result;
      for (const row of rows) {
        lastId = row.id;
        if (!row.hash) {
          result.unchained += 1;
          continue;
        }
        result.entries += 1;
        const [kid = '', mac = ''] = (row.hash as string).split('.');
        const key = keys.get(kid);
        if (!key) result.unverifiable += 1;
        else if (!timingSafeEqual(auditMac(key, previous, row), Buffer.from(mac, 'base64url'))) {
          result.broken = row.id;
          return result;
        }
        previous = row.hash;
      }
    }
  }
  async auditFor(appId: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await this.db('platform_audit').where({ app_id: appId }).orderBy('id', 'desc').limit(limit);
    return rows.map(parseAudit);
  }
  async auditByAction(action: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await this.db('platform_audit').where({ action }).orderBy('id', 'desc').limit(limit);
    return rows.map(parseAudit);
  }

  async addAlert(appId: string, releaseId: string, message: string, kind: string | null = null) {
    await this.db('platform_alerts').insert({ at: now(), app_id: appId, release_id: releaseId, message, kind });
  }
  async listOpenAlerts(): Promise<Alert[]> {
    return this.db('platform_alerts').whereNull('acknowledged_at').orderBy('id', 'desc').limit(100);
  }
  async ackAlert(id: string, actor: string): Promise<number> {
    return this.db('platform_alerts')
      .where({ id })
      .whereNull('acknowledged_at')
      .update({ acknowledged_at: now(), acknowledged_by: actor });
  }
}
