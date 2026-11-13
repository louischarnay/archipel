import { useState } from 'react';
import { api } from '../api/client';
import type { ReleaseCounts, ReleaseFlags, ReleaseSummary, ReleaseView } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { Badge, ReleaseStatusBadge } from '../components/Badge';
import { EmptyState, PageHead, Segments } from '../components/Layout';
import { formatDate } from '../lib/format';
import { useLoad } from '../lib/use-load';
import { useShell } from '../shell/context';

const VIEWS: { id: ReleaseView; label: string; emptyTitle: string; emptyText: string }[] = [
  {
    id: 'queue',
    label: 'To review',
    emptyTitle: 'Nothing to review',
    emptyText: 'New versions will appear here after their automatic checks.',
  },
  {
    id: 'blocked',
    label: 'Blocked',
    emptyTitle: 'No blocked versions',
    emptyText: 'A blocked version failed the manifest, the scan or the tests.',
  },
  { id: 'history', label: 'History', emptyTitle: 'No decisions', emptyText: 'Versions already handled will appear here.' },
];

// The view survives a visit to a version and back.
let lastView: ReleaseView = 'queue';

export function FlagBadges({ flags }: { flags: ReleaseFlags }) {
  return (
    <>
      {flags.destructive && <Badge tone="red">Destructive</Badge>}
      {flags.permissions && <Badge tone="amber">Permissions</Badge>}
      {flags.exposure && <Badge tone="amber">Exposed data</Badge>}
      {flags.findings > 0 && <Badge>{`${flags.findings} in scan`}</Badge>}
    </>
  );
}

export function ReviewPage() {
  const { navVersion } = useShell();
  const [view, setView] = useState(lastView);
  const state = useLoad(async () => {
    const [counts, { releases }] = await Promise.all([
      api<ReleaseCounts>('/api/releases/counts'),
      api<{ releases: ReleaseSummary[] }>(`/api/releases?view=${view}`),
    ]);
    return { counts, releases, view };
  }, [view, navVersion]);

  const select = (next: ReleaseView) => {
    lastView = next;
    setView(next);
  };

  return (
    <div className="page">
      <PageHead title="Review" lead="No version goes live without a human decision." />
      <Async state={state}>
        {({ counts, releases, view: shown }) => {
          const current = VIEWS.find((item) => item.id === shown)!;
          return (
            <>
              <Segments
                selected={view}
                onSelect={select}
                tabs={VIEWS.map(({ id, label }) => ({
                  id,
                  label: (
                    <>
                      {label}
                      <span className="num">{counts[id]}</span>
                    </>
                  ),
                }))}
              />
              {releases.length ? (
                <div className="release-list">
                  {releases.map((release) => (
                    <a className="release-card" key={release.id} href={`#/review/${release.id}`}>
                      <AppIcon app={{ id: release.app_id, name: release.name, hasIcon: Boolean(release.app_id) }} />
                      <div className="body">
                        <div className="name">{release.version ? `${release.name} ${release.version}` : release.name}</div>
                        <div className="meta">{`${release.submitted_by} · ${formatDate(release.created_at)} · ${release.source_label}`}</div>
                      </div>
                      <div className="flags">
                        <FlagBadges flags={release.flags} />
                        {shown !== 'queue' && <ReleaseStatusBadge status={release.status} />}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <EmptyState title={current.emptyTitle} text={current.emptyText} />
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}
