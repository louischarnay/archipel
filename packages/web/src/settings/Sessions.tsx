import { api } from '../api/client';
import type { SessionRow } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { Async } from '../components/Async';
import { Badge } from '../components/Badge';
import { useConfirm } from '../components/Confirm';
import { EmptyState } from '../components/Layout';
import { formatDate } from '../lib/format';
import { useLoad } from '../lib/use-load';

const MAX_USER_AGENT = 48;

export function SessionsPanel() {
  const confirm = useConfirm();
  const state = useLoad(() => api<{ sessions: SessionRow[] }>('/api/sessions'), []);

  const revoke = async (session: SessionRow) => {
    const confirmed = await confirm({
      title: `Revoke ${session.name}'s session?`,
      text: session.current
        ? 'You will be signed out of this device.'
        : 'The person is signed out immediately, including from open apps.',
      confirm: 'Revoke',
      danger: true,
    });
    if (!confirmed) return;
    await api(`/api/sessions/${session.id}/revoke`, { method: 'POST' });
    if (session.current) window.location.assign('/login');
    else await state.reload();
  };

  return (
    <Async state={state}>
      {({ sessions }) => (
        <div>
          <p className="section-note tables-legend">
            A session closes after one hour without activity, and after eight hours at the latest.
          </p>
          {sessions.length ? (
            <div className="table-scroll">
              <table className="table static">
                <thead>
                  <tr>
                    {['Account', 'Device', 'Last activity', ''].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <div className="chips">
                          {session.name}
                          {session.current && <Badge tone="accent">This session</Badge>}
                        </div>
                        {session.email && <div className="sub">{session.email}</div>}
                      </td>
                      <td>
                        <div className="sub">{session.ip ?? '—'}</div>
                        <div className="sub" title={session.user_agent ?? ''}>
                          {(session.user_agent ?? '').slice(0, MAX_USER_AGENT)}
                        </div>
                      </td>
                      <td>{formatDate(session.last_seen_at)}</td>
                      <td className="cell-actions">
                        <ActionButton className="small danger" onAction={() => revoke(session)}>
                          Revoke
                        </ActionButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No sessions" text="Open sessions will appear here." />
          )}
        </div>
      )}
    </Async>
  );
}
