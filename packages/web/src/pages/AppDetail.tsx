import { Fragment } from 'react';
import { api } from '../api/client';
import type { AppDetail, AuditEntry, ReleaseSummary } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { AppStatusBadge, ReleaseStatusBadge } from '../components/Badge';
import { useConfirm } from '../components/Confirm';
import { Icon } from '../components/Icon';
import { Logs, Section } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { formatDate } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad } from '../lib/use-load';
import { useShell } from '../shell/context';

const AUDIT_LABELS: Record<string, string> = {
  'release.approve': 'approved',
  'release.reject': 'rejected',
  'release.request_changes': 'requested changes on',
  'release.rollback': 'put back online',
  'app.disable': 'disabled the app',
  'app.enable': 'enabled the app',
  'app.uninstall': 'uninstalled the app',
};

function describeAudit(entry: AuditEntry) {
  const version = entry.detail?.version ? ` version ${entry.detail.version}` : '';
  return `${AUDIT_LABELS[entry.action] ?? entry.action}${version}`;
}

// A version a person approved before, and that another one replaced since.
const canGoBackOnline = (release: ReleaseSummary) => release.status === 'superseded' && Boolean(release.decided_by);

export function AppDetailPage({ id }: { id: string }) {
  const { refreshNav } = useShell();
  const confirm = useConfirm();
  const toast = useToast();
  const state = useLoad(() => api<AppDetail>(`/api/apps/${id}`), [id]);

  const reload = async () => {
    await state.reload();
    refreshNav();
  };

  const act = (action: 'enable' | 'disable', message: string) => async () => {
    await api(`/api/apps/${id}/${action}`, { method: 'POST' });
    toast(message);
    await reload();
  };

  const uninstall = async (name: string) => {
    const ok = await confirm({
      title: `Uninstall ${name}?`,
      text: 'The app will be removed from the launchpad. Its tables stay in the database: a new install will find them again.',
      confirm: 'Uninstall',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/apps/${id}/uninstall`, { method: 'POST' });
    toast('App uninstalled');
    refreshNav();
    navigate('/apps');
  };

  const rollback = async (release: ReleaseSummary) => {
    const ok = await confirm({
      title: `Go back to version ${release.version}?`,
      text: 'The live version will be replaced. No data is deleted; missing columns are recreated empty.',
      confirm: 'Put back online',
    });
    if (!ok) return;
    await api(`/api/apps/${id}/rollback`, { method: 'POST', body: { releaseId: release.id } });
    toast(`Version ${release.version} back online`);
    await reload();
  };

  return (
    <Async state={state}>
      {({ app, manifest, releases, logs, audit }) => {
        const hasLive = releases.some((release) => release.status === 'live');
        const network = manifest?.permissions?.network ?? [];
        const tools = manifest?.exposes?.mcp ?? [];
        return (
          <div className="page">
            <a className="back" href="#/apps">
              <Icon name="back" />
              Apps
            </a>
            <div className="page-head">
              <div className="title-row">
                <AppIcon app={{ ...app, hasIcon: Boolean(manifest?.icon) }} />
                <div>
                  <h1>{app.name}</h1>
                  <p>{manifest ? `Version ${manifest.version}` : 'Not live yet'}</p>
                </div>
                <AppStatusBadge status={app.status} />
              </div>
              <div className="actions">
                {app.status === 'live' && manifest?.frontend && (
                  <a className="btn" href={`#/open/${id}`}>
                    Open
                  </a>
                )}
                {app.status === 'live' && <ActionButton onAction={act('disable', 'App disabled')}>Disable</ActionButton>}
                {app.status === 'disabled' && <ActionButton onAction={act('enable', 'App enabled')}>Enable</ActionButton>}
                <ActionButton className="danger" onAction={() => uninstall(app.name)}>
                  Uninstall
                </ActionButton>
              </div>
            </div>

            <Section title="Versions">
              <div className="release-list">
                {releases.map((release) => (
                  <div className="release-card" key={release.id}>
                    <a className="body" href={`#/review/${release.id}`}>
                      <div className="name">
                        {release.version ? `Version ${release.version}` : 'Version without a valid manifest'}
                      </div>
                      <div className="meta">{`${formatDate(release.created_at)} · ${release.submitted_by}`}</div>
                    </a>
                    <ReleaseStatusBadge status={release.status} />
                    {hasLive && canGoBackOnline(release) && (
                      <ActionButton className="small" onAction={() => rollback(release)}>
                        Put back online
                      </ActionButton>
                    )}
                  </div>
                ))}
              </div>
            </Section>

            {(network.length > 0 || tools.length > 0) && (
              <Section title="Network and tools">
                <dl className="definition">
                  {network.length > 0 && (
                    <>
                      <dt>Network</dt>
                      <dd>{network.join(', ')}</dd>
                    </>
                  )}
                  {tools.length > 0 && (
                    <>
                      <dt>MCP tools</dt>
                      <dd>{tools.map((tool) => tool.name).join(', ')}</dd>
                    </>
                  )}
                </dl>
              </Section>
            )}

            <Section title="Logs of the live version">
              {logs.length ? <Logs lines={logs} /> : <p className="section-note">No logs yet.</p>}
            </Section>

            {audit.length > 0 && (
              <Section title="History">
                <dl className="definition">
                  {audit.map((entry) => (
                    <Fragment key={entry.id}>
                      <dt>{formatDate(entry.at)}</dt>
                      <dd>{`${entry.actor} — ${describeAudit(entry)}`}</dd>
                    </Fragment>
                  ))}
                </dl>
              </Section>
            )}
          </div>
        );
      }}
    </Async>
  );
}
