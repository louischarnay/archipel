import type {} from '@fastify/swagger';
import type { Manifest, Table, ValidationResult } from '@archipel/manifest-schema';
import type { loadConfig } from './config/config.js';
import type { ReleaseDiff } from './pipeline/diff.js';
import type { ScanReport } from './pipeline/scan.js';
import type { Checks, Health } from './pipeline/smoke.js';

// Read once at startup. The settings page changes `instance`, `auth` and `publicUrl` in place.
export type Config = ReturnType<typeof loadConfig>;

export interface User {
  sub: string;
  name: string;
  email: string | null;
  groups: string[];
  admin: boolean;
}

export interface Session {
  id: string;
  user: User;
  authTime: number;
}

export interface SessionRow {
  id: string;
  user: User;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface SessionRecord extends SessionRow {
  token_hash: string;
  expires_at: string;
  auth_time: string;
  revoked_at: string | null;
}

export interface AgentToken {
  id: string;
  name: string;
  apps: string[] | null; // null: all apps
}

export interface StoredAgentToken extends AgentToken {
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Group {
  id: string;
  name: string;
}

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  group_id: string | null;
  hasIcon: boolean;
}

export interface AppRow {
  id: string;
  name: string;
  group_id: string | null;
  status: string;
  live_release_id: string | null;
  applied_tables: Record<string, Table>;
  created_at: string;
}

export type ReleaseStatus = 'processing' | 'failed' | 'in_review' | 'changes_requested' | 'rejected' | 'live' | 'superseded';

export interface Stage {
  id: string;
  status: string;
  detail: string;
  at: string;
}

export interface Report {
  stages?: Stage[];
  summary?: string;
  source?: unknown;
  validation?: ValidationResult;
  scan?: ScanReport;
  diff?: ReleaseDiff;
  checks?: Checks;
  migration?: unknown[];
  liveHealth?: Health | null;
}

export interface Release {
  id: string;
  app_id: string | null;
  version: string | null;
  status: ReleaseStatus;
  stage: string | null;
  source_type: string;
  source_label: string;
  submitted_by: string;
  submitted_token: string | null;
  manifest: Manifest | null;
  report: Report;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_comment: string | null;
}

// A version past validation: the manifest and the app are known.
export interface ValidRelease extends Release {
  app_id: string;
  version: string;
  manifest: Manifest;
}

export interface LogEntry {
  id: number;
  release_id: string;
  level: string;
  message: string;
  at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  app_id: string | null;
  release_id: string | null;
  detail: Record<string, unknown> | null;
  hash: string | null;
  actor_type: string | null;
  actor_id: string | null;
  ip: string | null;
  request_id: string | null;
}

export interface Alert {
  id: number;
  at: string;
  app_id: string;
  release_id: string | null;
  message: string;
  kind: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

// Identity set by the authentication hook: an agent never has a `user`.
declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    agent: StoredAgentToken | null;
    session: Session | null;
  }
}
