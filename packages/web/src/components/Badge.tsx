import type { ReactNode } from 'react';
import type { AppStatus, ReleaseStatus } from '../api/types';

export type Tone = 'accent' | 'amber' | 'red' | 'green' | '';

export function Badge({ tone = '', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={`badge ${tone}`.trim()} title={title}>
      {children}
    </span>
  );
}

const RELEASE_STATUS: Record<ReleaseStatus, [string, Tone]> = {
  processing: ['Processing', 'accent'],
  in_review: ['To review', 'amber'],
  failed: ['Blocked', 'red'],
  changes_requested: ['Changes requested', 'amber'],
  rejected: ['Rejected', 'red'],
  live: ['Live', 'green'],
  superseded: ['Superseded', ''],
};

const APP_STATUS: Partial<Record<AppStatus, [string, Tone]>> = {
  live: ['Live', 'green'],
  pending: ['Not live yet', ''],
  disabled: ['Disabled', 'amber'],
};

export function ReleaseStatusBadge({ status }: { status: ReleaseStatus }) {
  const [label, tone] = RELEASE_STATUS[status] ?? [status, ''];
  return <Badge tone={tone}>{label}</Badge>;
}

export function AppStatusBadge({ status }: { status: AppStatus }) {
  const [label, tone] = APP_STATUS[status] ?? [status, ''];
  return <Badge tone={tone}>{label}</Badge>;
}
