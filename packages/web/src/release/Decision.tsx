import { useRef, useState } from 'react';
import { api } from '../api/client';
import type { ReleaseDetail } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { ReleaseStatusBadge } from '../components/Badge';
import { useToast } from '../components/Toasts';
import { formatDate } from '../lib/format';

interface Props {
  release: ReleaseDetail;
  onDecided: () => Promise<void>;
}

// The reviewer's decision. A changed permission or a data loss must be ticked before the version can go live.
export function DecisionPanel({ release, onDecided }: Props) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [destructiveAllowed, setDestructiveAllowed] = useState(false);
  const commentBox = useRef<HTMLTextAreaElement>(null);

  const asksPermissions = Boolean(release.report.diff?.permissions.changed);
  const asksDestructive = release.flags.destructive;
  const blocked = (asksPermissions && !permissionsChecked) || (asksDestructive && !destructiveAllowed);

  const decide = async (action: 'approve' | 'request-changes' | 'reject', message: string) => {
    // The comment of a refusal is all the agent gets back.
    if (action !== 'approve' && !comment.trim()) {
      commentBox.current?.focus();
      throw new Error('Add a comment: it will be sent to the agent.');
    }
    const body = {
      comment: comment.trim() || undefined,
      ...(action === 'approve' ? { allowDestructive: destructiveAllowed } : {}),
    };
    await api(`/api/releases/${release.id}/${action}`, { method: 'POST', body });
    toast(message);
    await onDecided();
  };

  return (
    <aside className="decision">
      <h2>Decision</h2>
      <div className="field">
        <label htmlFor="decision-comment">Comment</label>
        <textarea
          id="decision-comment"
          ref={commentBox}
          placeholder="Sent as is to the agent that created the app"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      {asksPermissions && (
        <label className="check">
          <input type="checkbox" checked={permissionsChecked} onChange={(event) => setPermissionsChecked(event.target.checked)} />
          I have checked the requested permissions
        </label>
      )}
      {asksDestructive && (
        <label className="check">
          <input type="checkbox" checked={destructiveAllowed} onChange={(event) => setDestructiveAllowed(event.target.checked)} />
          I allow the data loss shown in the schema; a copy of the tables will be kept
        </label>
      )}
      <ActionButton className="primary block" disabled={blocked} onAction={() => decide('approve', 'Version live')}>
        Approve and go live
      </ActionButton>
      <ActionButton className="block" onAction={() => decide('request-changes', 'Changes requested')}>
        Request changes
      </ActionButton>
      <ActionButton className="danger block" onAction={() => decide('reject', 'Version rejected')}>
        Reject
      </ActionButton>
    </aside>
  );
}

// Once decided, or when the pipeline stopped before review: what happened, and why.
export function OutcomePanel({ release }: { release: ReleaseDetail }) {
  if (release.status === 'processing') {
    return (
      <aside className="decision">
        <h2>Decision</h2>
        <p className="decision-note">Checks are running.</p>
      </aside>
    );
  }
  return (
    <aside className="decision">
      <h2>Decision</h2>
      <ReleaseStatusBadge status={release.status} />
      <p className="decision-note">
        {release.decided_by
          ? `${release.decided_by}, ${formatDate(release.decided_at)}`
          : (release.summary ?? 'No decision for this version.')}
      </p>
      {release.decision_comment && <p>{release.decision_comment}</p>}
    </aside>
  );
}
