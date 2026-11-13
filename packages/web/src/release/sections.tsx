import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Checks, Finding, ListDiff, ManifestIssue, Manifest, ReleaseDetail, ReleaseDiff, Report } from '../api/types';
import { Icon } from '../components/Icon';
import { Section } from '../components/Layout';

// Each section of the technical tab reads one part of the report the pipeline wrote for this version.

const STAGES = [
  ['intake', 'Intake'],
  ['validate', 'Manifest'],
  ['scan', 'Scan'],
  ['diff', 'Diff'],
  ['preview', 'Preview'],
  ['checks', 'Tests'],
] as const;

const CHANGE_LABELS = {
  add_table: 'New table',
  add_column: 'New column',
  drop_table: 'Table dropped',
  drop_column: 'Column dropped',
  change_type: 'Type changed',
  change_values: 'Values changed',
};

export function Stages({ release }: { release: ReleaseDetail }) {
  const done = new Map((release.report.stages ?? []).map((stage) => [stage.id, stage.status]));
  // While the pipeline runs, the stage in progress is the first one without a result.
  const runningIndex = release.status === 'processing' ? STAGES.findIndex(([id]) => id !== 'intake' && !done.has(id)) : -1;
  return (
    <div className="stages">
      {STAGES.map(([id, label], index) => {
        const state = done.get(id) ?? (id === 'intake' && done.size ? 'ok' : index === runningIndex ? 'running' : '');
        return (
          <div className={`stage ${state}`.trim()} key={id}>
            <span className="dot" />
            {label}
          </div>
        );
      })}
    </div>
  );
}

type RowTone = 'add' | 'remove' | 'danger' | '';

function DiffRow({ tone = '', tag, children }: { tone?: RowTone; tag: string; children: ReactNode }) {
  return (
    <div className={`diff-row ${tone}`.trim()}>
      <span className="tag">{tag}</span>
      {children}
    </div>
  );
}

// What was added, removed and kept, in that order.
function ListDiffRows({ label, diff }: { label: string; diff: ListDiff }) {
  return (
    <>
      {diff.added.map((item) => (
        <DiffRow key={`+${item}`} tone="add" tag={`+ ${label}`}>
          {item}
        </DiffRow>
      ))}
      {diff.removed.map((item) => (
        <DiffRow key={`-${item}`} tone="remove" tag={`− ${label}`}>
          {item}
        </DiffRow>
      ))}
      {diff.unchanged.map((item) => (
        <DiffRow key={item} tag={label}>
          {item}
        </DiffRow>
      ))}
    </>
  );
}

const isEmpty = (...diffs: ListDiff[]) =>
  diffs.every((diff) => !diff.added.length && !diff.removed.length && !diff.unchanged.length);

export function PermissionsSection({ diff }: { diff: ReleaseDiff }) {
  const { network, reads, writes, llm } = diff.permissions;
  const llmChanged = llm.before !== llm.after;
  const nothing = isEmpty(network, reads, writes) && !llmChanged && !llm.after;
  return (
    <Section
      title="Permissions"
      note={diff.firstRelease ? 'First version: everything is new.' : `Compared with version ${diff.previousVersion}.`}
    >
      {nothing ? (
        <p className="section-note">This app asks for no network access and no shared table.</p>
      ) : (
        <div className="diff-list">
          <ListDiffRows label="Network" diff={network} />
          <ListDiffRows label="Read" diff={reads} />
          <ListDiffRows label="Write" diff={writes} />
          {llmChanged && <DiffRow tone="add" tag="LLM">{`${llm.before ?? 'none'} → ${llm.after ?? 'none'}`}</DiffRow>}
          {!llmChanged && llm.after && <DiffRow tag="LLM">{llm.after}</DiffRow>}
        </div>
      )}
    </Section>
  );
}

export function SchemaSection({ diff }: { diff: ReleaseDiff }) {
  return (
    <Section title="Schema">
      {diff.schema.length ? (
        <div className="diff-list">
          {diff.schema.map((change) => (
            <DiffRow
              key={`${change.kind}-${change.table}-${change.column ?? ''}`}
              tone={change.destructive ? 'danger' : ''}
              tag={CHANGE_LABELS[change.kind]}
            >
              <code>{change.column ? `${change.table}.${change.column}` : change.table}</code>
              {change.reason && <span className="why">{change.reason}</span>}
            </DiffRow>
          ))}
        </div>
      ) : (
        <p className="section-note">No schema change.</p>
      )}
    </Section>
  );
}

export function ExposureSection({ manifest, diff }: { manifest: Manifest; diff: ReleaseDiff }) {
  const { data, mcp } = diff.exposure;
  const routes = manifest.controllers ?? [];
  return (
    <Section title="Exposed data and routes">
      {isEmpty(data, mcp) && !routes.length ? (
        <p className="section-note">This app exposes nothing.</p>
      ) : (
        <div className="diff-list">
          <ListDiffRows label="Data" diff={data} />
          <ListDiffRows label="MCP tool" diff={mcp} />
          {routes.map((controller) => (
            <DiffRow key={controller.path} tag="Route">
              <code>{controller.path}</code>
              <span className="why">{controller.needs?.length ? controller.needs.join(', ') : 'any signed-in user'}</span>
            </DiffRow>
          ))}
        </div>
      )}
    </Section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="finding">
      <span className={finding.severity === 'block' ? 'finding-block' : 'finding-warn'}>
        <Icon name="warn" />
      </span>
      <div>
        <div className="title">{finding.title}</div>
        {finding.file && <div className="where mono">{finding.line ? `${finding.file}:${finding.line}` : finding.file}</div>}
        {finding.hint && <div className="hint">{finding.hint}</div>}
      </div>
    </div>
  );
}

// A manifest issue reads like a scan finding: what, where, how to fix.
const asFinding = (issue: ManifestIssue, severity: Finding['severity']): Finding => ({
  severity,
  title: issue.message,
  file: issue.path,
  hint: issue.hint,
});

export function ValidationSection({ validation }: { validation: Report['validation'] }) {
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  if (!errors.length && !warnings.length) return null;
  const findings = [...errors.map((issue) => asFinding(issue, 'block')), ...warnings.map((issue) => asFinding(issue, 'warn'))];
  return (
    <Section title="Manifest">
      {findings.map((finding) => (
        <FindingRow key={`${finding.file}-${finding.title}`} finding={finding} />
      ))}
    </Section>
  );
}

export function ScanSection({ scan }: { scan: Report['scan'] }) {
  if (!scan) return null;
  return (
    <Section title="Code scan" note="Search for risky patterns, which does not replace reading the code.">
      {scan.findings.length ? (
        scan.findings.map((finding, index) => <FindingRow key={index} finding={finding} />)
      ) : (
        <p className="section-note">Nothing found.</p>
      )}
    </Section>
  );
}

function TestRow({ label, ok, generated, error }: { label: string; ok: boolean; generated?: boolean; error?: string | null }) {
  return (
    <>
      <div className="test-row">
        <Icon name={ok ? 'check' : 'cross'} className={ok ? 'ok' : 'ko'} />
        {label}
        {generated && <span className="auto">generated</span>}
      </div>
      {error && <div className="test-error mono">{error}</div>}
    </>
  );
}

export function TestsSection({ checks }: { checks: Checks | undefined }) {
  if (!checks) return null;
  const { health, smoke } = checks;
  return (
    <Section title="Health and tests">
      {health && (
        <TestRow label={`Health: ${health.status}`} ok={health.ok} error={health.ok ? null : JSON.stringify(health.body)} />
      )}
      {smoke.map((test) => (
        <TestRow
          key={test.name}
          label={test.name}
          ok={test.ok}
          generated={test.generated}
          error={test.message ? `${test.status}, expected ${test.expected}: ${test.message}` : null}
        />
      ))}
    </Section>
  );
}

interface FileContent {
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

// The files of the version, controllers first: they are what runs on the server.
export function CodeSection({ release }: { release: ReleaseDetail }) {
  const files = release.report.scan?.files ?? [];
  const handlers = new Set((release.manifest?.controllers ?? []).map((controller) => controller.handler.replace(/^\.\//, '')));
  const isHandler = (path: string) => Number(handlers.has(path));
  const sorted = [...files].sort((a, b) => isHandler(b.path) - isHandler(a.path) || a.path.localeCompare(b.path));
  const first = sorted.find((file) => handlers.has(file.path))?.path ?? sorted[0]?.path ?? null;

  const [selected, setSelected] = useState(first);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!selected) return;
    let current = true;
    api<FileContent>(`/api/releases/${release.id}/file?path=${encodeURIComponent(selected)}`).then(
      ({ content, binary, tooLarge }) => {
        if (current) setText(binary ? 'Binary file.' : tooLarge ? 'File too large to preview.' : (content ?? ''));
      },
      (error: Error) => current && setText(error.message),
    );
    return () => {
      current = false;
    };
  }, [release.id, selected]);

  if (!sorted.length) return null;
  return (
    <Section title="Code" note="Controllers first: they are what runs on the server.">
      <div className="code-browser">
        <div className="code-files">
          {sorted.map((file) => (
            <button key={file.path} type="button" aria-selected={file.path === selected} onClick={() => setSelected(file.path)}>
              {file.path}
            </button>
          ))}
        </div>
        <pre className="code-view">{text}</pre>
      </div>
    </Section>
  );
}

// What the technical tab asks the reviewer to look at, counted on its tab.
export function attentionCount({ flags, report }: ReleaseDetail) {
  const failedTests = (report.checks?.smoke ?? []).filter((test) => !test.ok).length;
  const failedHealth = report.checks?.health && !report.checks.health.ok ? 1 : 0;
  return (
    Number(flags.destructive) +
    Number(flags.permissions) +
    (report.scan?.findings.length ?? 0) +
    (report.validation?.errors.length ?? 0) +
    failedTests +
    failedHealth
  );
}

// What an agent needs to fix a version, without the interface.
export function agentReport(release: ReleaseDetail) {
  const report = {
    app: release.app_id,
    version: release.version,
    status: release.status,
    decision: release.decided_by ? { by: release.decided_by, comment: release.decision_comment } : null,
    summary: release.summary,
    validation: release.report.validation,
    scan: release.report.scan?.findings,
    checks: release.report.checks,
    logs: release.logs.filter((line) => line.level !== 'info').map((line) => line.message),
  };
  return JSON.stringify(report, null, 2);
}
