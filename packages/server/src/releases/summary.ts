import type { Release, Report } from '../types.js';

function flagsOf(report: Report) {
  return {
    permissions: Boolean(report.diff?.permissions?.changed),
    exposure: Boolean(report.diff?.exposure?.changed),
    destructive: Boolean(report.diff?.schema?.some((change) => change.destructive)),
    findings: report.scan?.findings?.length ?? 0,
  };
}

// A version as lists show it: no manifest, no report, only what tells it apart and what needs attention.
export const releaseSummary = (release: Release) => ({
  id: release.id,
  app_id: release.app_id,
  name: release.manifest?.name ?? release.app_id ?? 'Version without a valid manifest',
  version: release.version,
  status: release.status,
  stage: release.stage,
  source_type: release.source_type,
  source_label: release.source_label,
  submitted_by: release.submitted_by,
  created_at: release.created_at,
  decided_at: release.decided_at,
  decided_by: release.decided_by,
  decision_comment: release.decision_comment,
  summary: release.report.summary ?? null,
  flags: flagsOf(release.report),
});

// An agent is named after its token in everything it submits.
export const agentName = (token: { name: string }) => `agent:${token.name}`;
