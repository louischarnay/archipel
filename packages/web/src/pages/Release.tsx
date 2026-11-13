import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from '../api/client';
import type { ReleaseDetail } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { ReleaseStatusBadge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { Banner, Logs, Section, Segments } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { formatDate } from '../lib/format';
import { DecisionPanel, OutcomePanel } from '../release/Decision';
import { PreviewPane } from '../release/Preview';
import {
  agentReport,
  attentionCount,
  CodeSection,
  ExposureSection,
  PermissionsSection,
  ScanSection,
  SchemaSection,
  Stages,
  TestsSection,
  ValidationSection,
} from '../release/sections';
import { useShell } from '../shell/context';

type Tab = 'preview' | 'technical';

const POLL_MS = 700;

// Follows a version while the pipeline works on it, then stops asking.
function useRelease(id: string) {
  const { refreshNav } = useShell();
  const [release, setRelease] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to start following again, after a decision sends the version back to the pipeline.
  const [round, setRound] = useState(0);
  const shownStatus = useRef<string | null>(null);

  // Shows a version, and says whether it is still being processed.
  const show = useCallback(
    (next: ReleaseDetail) => {
      setRelease(next);
      if (next.status === 'processing') return true;
      // A version leaving the pipeline, or being decided, changes the Review badge.
      if (shownStatus.current !== next.status) refreshNav();
      shownStatus.current = next.status;
      return false;
    },
    [refreshNav],
  );

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (first: boolean) => {
      try {
        const next = await api<ReleaseDetail>(`/api/releases/${id}`);
        if (active && show(next)) timer = setTimeout(() => void poll(false), POLL_MS);
      } catch (failure) {
        // Only a version that cannot be read at all replaces the page; a missed poll is retried by the next action.
        if (active && first) setError(messageOf(failure));
      }
    };
    void poll(true);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, round, show]);

  const reload = useCallback(async () => {
    if (show(await api<ReleaseDetail>(`/api/releases/${id}`))) setRound((value) => value + 1);
  }, [id, show]);

  return { release, error, reload };
}

function TechnicalDetails({ release }: { release: ReleaseDetail }) {
  const toast = useToast();
  const { report, manifest } = release;
  const diff = manifest ? report.diff : undefined;

  const copyReport = async () => {
    await navigator.clipboard.writeText(agentReport(release));
    toast('Report copied');
  };

  return (
    <div>
      <Section
        title="Pipeline"
        actions={
          release.status !== 'processing' && (
            <button className="btn small" type="button" onClick={copyReport}>
              <Icon name="copy" />
              Copy report
            </button>
          )
        }
      >
        <Stages release={release} />
      </Section>
      {release.status === 'failed' && (
        <Banner tone="red" icon="warn">
          <div>{release.summary ?? 'Processing failed.'}</div>
        </Banner>
      )}
      <ValidationSection validation={report.validation} />
      {diff && manifest && (
        <>
          <PermissionsSection diff={diff} />
          <SchemaSection diff={diff} />
          <ExposureSection manifest={manifest} diff={diff} />
        </>
      )}
      <ScanSection scan={report.scan} />
      <TestsSection checks={report.checks} />
      {manifest && <CodeSection release={release} />}
      {release.logs.length > 0 && (
        <Section title="Logs">
          <Logs lines={release.logs} />
        </Section>
      )}
    </div>
  );
}

// One version: its preview on one tab, everything the pipeline found on the other, and the decision.
export function ReleasePage({ id }: { id: string }) {
  const { release, error, reload } = useRelease(id);
  // The tab the reviewer picked. Until then: the pipeline while checks run, then the preview when there is one.
  const [chosen, setChosen] = useState<Tab | null>(null);

  if (error) {
    return (
      <div className="page">
        <div className="banner red">{error}</div>
      </div>
    );
  }
  if (!release) return null;

  const tab = chosen ?? (release.status !== 'processing' && release.previewUrl ? 'preview' : 'technical');
  const attention = attentionCount(release);
  const title = release.version ? `${release.name} ${release.version}` : release.name;

  return (
    <div className={`page wide release ${tab === 'preview' ? 'previewing' : ''}`.trim()}>
      <a className="back" href="#/review">
        <Icon name="back" />
        Review
      </a>
      <div className="page-head">
        <div className="title-row">
          <AppIcon app={{ id: release.app_id, name: release.name, hasIcon: Boolean(release.manifest?.icon) }} />
          <div>
            <h1>{title}</h1>
            <p>{`${release.submitted_by} · ${formatDate(release.created_at)} · ${release.source_label}`}</p>
          </div>
          <ReleaseStatusBadge status={release.status} />
        </div>
        {release.app_id && release.manifest && (
          <a className="btn" href={`#/apps/${release.app_id}`}>
            View app
          </a>
        )}
      </div>
      <Segments
        className="release-tabs"
        selected={tab}
        onSelect={setChosen}
        tabs={[
          {
            id: 'preview',
            label: (
              <>
                <Icon name="play" />
                Preview
              </>
            ),
          },
          {
            id: 'technical',
            label: (
              <>
                <Icon name="code" />
                Technical details
                {attention > 0 && (
                  <span className="num alert" title={`${attention} to check`}>
                    {attention}
                  </span>
                )}
              </>
            ),
          },
        ]}
      />
      {/* Both panes stay mounted: the preview keeps its state, and the decision keeps its comment. */}
      <div className="release-pane" role="tabpanel" hidden={tab !== 'preview'}>
        <PreviewPane release={release} />
      </div>
      <div className="release-pane" role="tabpanel" hidden={tab !== 'technical'}>
        <div className="review-grid">
          <TechnicalDetails release={release} />
          {release.status === 'in_review' ? (
            <DecisionPanel release={release} onDecided={reload} />
          ) : (
            <OutcomePanel release={release} />
          )}
        </div>
      </div>
    </div>
  );
}
