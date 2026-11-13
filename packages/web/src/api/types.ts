// Shapes returned by the platform API, as declared in the server's `http/schemas.ts`.

export interface User {
  sub: string;
  name: string;
  email: string | null;
  groups: string[];
  admin: boolean;
}

export type OpenMode = 'embedded' | 'tab';

export interface Branding {
  name: string;
  title: string;
  welcome: string;
  loginMessage: string;
  accent: string;
  background: string;
  showGroups: boolean;
  openMode: OpenMode;
  hasLogo: boolean;
}

export interface Me {
  user: User;
  authMode: 'dev' | 'oidc' | 'setup';
  isolated: boolean;
  branding: Branding;
}

export interface Group {
  id: string;
  name: string;
}

export interface LaunchpadApp {
  id: string;
  name: string;
  group: string | null;
  route: string;
  version: string;
  hasIcon: boolean;
}

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  group: string | null;
  hasIcon: boolean;
}

export interface Launchpad {
  apps: LaunchpadApp[];
  links: ExternalLink[];
  groups: Group[];
}

export type AppStatus = 'live' | 'pending' | 'disabled' | 'uninstalled';

export interface AppSummary {
  id: string;
  name: string;
  status: AppStatus;
  group: string | null;
  groupName: string | null;
  version: string | null;
  route: string | null;
  hasIcon: boolean;
  inReview: number;
  blocked: boolean;
  updated_at: string;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  icon?: string;
  frontend?: { dir: string; route: string };
  controllers?: { path: string; handler: string; needs?: string[] }[];
  permissions?: { reads?: string[]; writes?: string[]; network?: string[] };
  exposes?: { data?: string[]; mcp?: { name: string; description: string }[] };
}

export type ReleaseStatus = 'processing' | 'failed' | 'in_review' | 'changes_requested' | 'rejected' | 'live' | 'superseded';

export interface ReleaseFlags {
  permissions: boolean;
  exposure: boolean;
  destructive: boolean;
  findings: number;
}

export interface ReleaseSummary {
  id: string;
  app_id: string | null;
  name: string;
  version: string | null;
  status: ReleaseStatus;
  stage: string | null;
  source_type: string;
  source_label: string;
  submitted_by: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_comment: string | null;
  summary: string | null;
  flags: ReleaseFlags;
}

export interface LogLine {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: { version?: string } | null;
}

export interface AppDetail {
  app: {
    id: string;
    name: string;
    group_id: string | null;
    status: AppStatus;
    live_release_id: string | null;
    created_at: string;
  };
  manifest: Manifest | null;
  releases: ReleaseSummary[];
  logs: LogLine[];
  audit: AuditEntry[];
}

export interface ListDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface PermissionsDiff {
  changed: boolean;
  network: ListDiff;
  reads: ListDiff;
  writes: ListDiff;
  llm: { before: string | null; after: string | null };
}

export interface SchemaChange {
  kind: 'add_table' | 'add_column' | 'drop_table' | 'drop_column' | 'change_type' | 'change_values';
  table: string;
  column?: string;
  destructive: boolean;
  reason?: string;
}

export interface ReleaseDiff {
  firstRelease: boolean;
  previousVersion: string | null;
  schema: SchemaChange[];
  permissions: PermissionsDiff;
  exposure: { changed: boolean; data: ListDiff; mcp: ListDiff };
}

export interface Finding {
  severity: 'block' | 'warn';
  title: string;
  file?: string;
  line?: number;
  hint?: string;
}

export interface ManifestIssue {
  path: string;
  message: string;
  hint?: string;
}

export interface Checks {
  ok: boolean;
  health: { ok: boolean; status: number; body: unknown } | null;
  smoke: { name: string; ok: boolean; generated?: boolean; status?: number; expected?: number; message?: string }[];
}

export interface Report {
  stages?: { id: string; status: string; detail: string; at: string }[];
  summary?: string;
  validation?: { errors: ManifestIssue[]; warnings: ManifestIssue[] };
  scan?: { blocked: boolean; findings: Finding[]; files: { path: string }[] };
  diff?: ReleaseDiff;
  checks?: Checks;
}

export interface ReleaseDetail extends ReleaseSummary {
  manifest: Manifest | null;
  report: Report;
  previewUrl: string | null;
  logs: LogLine[];
}

export interface Alert {
  id: number;
  at: string;
  app_id: string;
  release_id: string | null;
  message: string;
  kind: string | null;
}

export type ActivityEvent =
  | { type: 'submit'; at: string; agent: string; release: ReleaseSummary }
  | {
      type: 'rollback_request';
      at: string;
      agent: string;
      app: { id: string; name: string };
      version: string | null;
      reason: string | null;
    };

export interface Activity {
  events: ActivityEvent[];
  alerts: Alert[];
}

export type ReleaseView = 'queue' | 'blocked' | 'history';
export type ReleaseCounts = Record<ReleaseView, number>;

export type TableAccess = 'owner' | 'read' | 'write';

export interface TableColumn {
  name: string;
  type: string;
  pk: boolean;
  required: boolean;
  to: string | null;
}

export interface AppTable {
  name: string;
  physical: string;
  shared: boolean;
  access: TableAccess;
  exposed: boolean;
  crud: boolean;
  rbac: { read: string[]; write: string[] };
  rows: number | null;
  columns: TableColumn[];
}

export interface AppTables {
  id: string;
  name: string;
  hasIcon: boolean;
  tables: AppTable[];
}

export interface CommandField {
  name: string;
  type: 'uuid' | 'string' | 'integer' | 'number' | 'boolean';
}

export interface Command {
  app: { id: string; name: string };
  name: string;
  description: string;
  fields: CommandField[];
}

export interface CommandResult {
  status: number;
  result: unknown;
}

export interface IdentitySettings {
  locked: boolean;
  configured: boolean;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  groupsClaim: string;
  adminGroup: string;
  providerName: string;
  publicUrl: string;
  publicUrlLocked: boolean;
}

export interface DatabaseSettings {
  locked: boolean;
  client: string;
  label: string;
  supported: boolean;
  apps: number;
  tokens: number;
}

export interface Settings {
  mode: 'dev' | 'oidc' | 'setup';
  launchpad: Branding;
  identity: IdentitySettings;
  database: DatabaseSettings;
  setup: { completedAt: string | null };
}

export type DatabaseTarget = { client: 'better-sqlite3' } | { client: 'pg'; url: string };

export interface SettingsSaved {
  ok: boolean;
  restart: 'running' | 'manual' | null;
}

export type IdentityTestResult =
  | { status: 'waiting' }
  | { status: 'failed'; error: string }
  | { status: 'ok' | 'refused'; user: { name: string; email: string | null; groups: string[] }; adminGroup: string };

export interface SessionRow {
  id: string;
  name: string;
  email: string | null;
  admin: boolean;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export interface AgentToken {
  id: string;
  name: string;
  apps: string[] | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface IssuedToken {
  id: string;
  name: string;
  token: string;
  expires_at: string;
  apps: string[] | null;
}
