import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Activity, ActivityEvent, Alert, ReleaseCounts } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { AppIcon } from '../components/AppIcon';
import { Badge, ReleaseStatusBadge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';
import { recall, remember } from '../lib/storage';
import { useShell } from './context';

const REFRESH_MS = 10_000;
const OPEN_KEY = 'archipel.agent-dock.open';
const SEEN_KEY = 'archipel.agent-dock.seen';

function EventRow({ event }: { event: ActivityEvent }) {
  const when = `${event.agent} · ${formatDate(event.at)}`;
  if (event.type === 'rollback_request') {
    const { app, version, reason } = event;
    const meta = [when, reason].filter(Boolean).join(' · ');
    return (
      <a className="dock-row" href={`#/apps/${app.id}`}>
        <AppIcon app={{ ...app, hasIcon: true }} small />
        <div className="body">
          <div className="name">{`Roll ${app.name} back to version ${version}`}</div>
          <div className="meta" title={meta}>
            {meta}
          </div>
        </div>
        <Badge tone="amber">Rollback requested</Badge>
      </a>
    );
  }
  const { release } = event;
  const meta = [when, release.status === 'failed' ? release.summary : null].filter(Boolean).join(' · ');
  return (
    <a className="dock-row" href={`#/review/${release.id}`}>
      <AppIcon app={{ id: release.app_id, name: release.name, hasIcon: Boolean(release.app_id) }} small />
      <div className="body">
        <div className="name">{release.version ? `${release.name} ${release.version}` : release.name}</div>
        <div className="meta" title={meta}>
          {meta}
        </div>
      </div>
      <ReleaseStatusBadge status={release.status} />
    </a>
  );
}

function AlertRow({ alert, onSeen }: { alert: Alert; onSeen: () => Promise<void> }) {
  const acknowledge = async () => {
    await api(`/api/alerts/${alert.id}/ack`, { method: 'POST' });
    await onSeen();
  };
  return (
    <div className="dock-row dock-alert">
      <span className="dock-alert-icon">
        <Icon name="warn" />
      </span>
      <a className="body" href={`#/apps/${alert.app_id}`}>
        <div className="name">{alert.message}</div>
        <div className="meta">{formatDate(alert.at)}</div>
      </a>
      <ActionButton className="small" title="Mark as seen" onAction={acknowledge}>
        Seen
      </ActionButton>
    </div>
  );
}

// The administrators' only continuous feed: alerts, the agent's list and the Review badge.
export function AgentDock() {
  const { refreshNav } = useShell();
  const [open, setOpen] = useState(() => recall(OPEN_KEY) === '1');
  const [seenAt, setSeenAt] = useState(() => Number(recall(SEEN_KEY)) || 0);
  const [activity, setActivity] = useState<Activity>({ events: [], alerts: [] });
  const queue = useRef<number | null>(null);
  const snapshot = useRef('');

  const load = useCallback(async () => {
    const [next, counts] = await Promise.all([api<Activity>('/api/activity'), api<ReleaseCounts>('/api/releases/counts')]);
    if (queue.current !== null && queue.current !== counts.queue) refreshNav();
    queue.current = counts.queue;
    // Without a change, the list stays in place: a focused link is not replaced.
    const serialized = JSON.stringify(next);
    if (serialized === snapshot.current) return;
    snapshot.current = serialized;
    setActivity(next);
  }, [refreshNav]);

  // No websocket: a new request every ten seconds, paused while the tab is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await load().catch(() => {});
      timer = setTimeout(tick, REFRESH_MS);
    };
    void tick();
    return () => clearTimeout(timer);
  }, [load]);

  const { events, alerts } = activity;
  const latest = events[0] ? Date.parse(events[0].at) : 0;

  // Opening the prompt counts as reading: what it shows is no longer new.
  const seen = open ? Math.max(seenAt, latest) : seenAt;
  useEffect(() => {
    if (open) remember(SEEN_KEY, seen);
  }, [open, seen]);

  const toggle = () => {
    remember(OPEN_KEY, open ? '0' : '1');
    setSeenAt(seen);
    setOpen(!open);
  };

  // An alert counts until it is handled, even with the prompt open.
  const fresh = alerts.length + events.filter((event) => Date.parse(event.at) > seen).length;
  const empty = !alerts.length && !events.length;

  return (
    <aside className={`agent-dock ${open ? 'open' : ''}`.trim()} aria-label="Activity">
      <div className="dock-list" id="agent-dock-list" hidden={!open}>
        {alerts.map((alert) => (
          <AlertRow key={`alert-${alert.id}`} alert={alert} onSeen={load} />
        ))}
        {events.map((event) => (
          <EventRow key={`${event.type}-${event.at}`} event={event} />
        ))}
        {empty && <p className="dock-empty">No activity yet.</p>}
      </div>
      <button className="dock-toggle" type="button" aria-controls="agent-dock-list" aria-expanded={open} onClick={toggle}>
        <Icon name="bolt" />
        <span className="dock-label">Activity</span>
        <span className="count" hidden={!fresh} title={fresh > 1 ? `${fresh} new activities` : 'New activity'}>
          {fresh}
        </span>
        <Icon name="chevron" className="dock-chevron" />
      </button>
    </aside>
  );
}
