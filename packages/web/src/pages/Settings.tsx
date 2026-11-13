import { useState } from 'react';
import { api } from '../api/client';
import type { DatabaseTarget, Settings, SettingsSaved } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { Async } from '../components/Async';
import { useConfirm } from '../components/Confirm';
import { PageHead, Segments } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { plural } from '../lib/format';
import { navigate } from '../lib/router';
import { useLoad } from '../lib/use-load';
import { AgentsPanel } from '../settings/Agents';
import { DatabaseForm, waitForServer } from '../settings/DatabaseForm';
import { IdentityForm } from '../settings/IdentityForm';
import { LaunchpadForm, launchpadPayload, type LaunchpadDraft } from '../settings/LaunchpadForm';
import { SessionsPanel } from '../settings/Sessions';
import { useShell } from '../shell/context';

const TABS = [
  { id: 'launchpad', label: 'Launchpad' },
  { id: 'identity', label: 'Identity' },
  { id: 'database', label: 'Database' },
  { id: 'agents', label: 'Agents' },
  { id: 'sessions', label: 'Sessions' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const isTab = (value: string | undefined): value is TabId => TABS.some((tab) => tab.id === value);

const save = (body: unknown) => api<SettingsSaved>('/api/settings', { method: 'PUT', body });

function LaunchpadPanel({ settings }: { settings: Settings }) {
  const { refreshBranding } = useShell();
  const toast = useToast();
  const [draft, setDraft] = useState<LaunchpadDraft>(settings.launchpad);

  const submit = async () => {
    await save({ launchpad: launchpadPayload(draft) });
    await refreshBranding();
    toast('Launchpad saved');
  };

  return (
    <section className="section">
      <LaunchpadForm draft={draft} onChange={setDraft} />
      <div className="form-actions">
        <ActionButton className="primary" onAction={submit}>
          Save
        </ActionButton>
      </div>
    </section>
  );
}

function IdentityPanel({ settings }: { settings: Settings }) {
  const { identity, mode } = settings;
  const toast = useToast();
  const [testId, setTestId] = useState<string | null>(null);

  const activate = async () => {
    await save({ identity: { testId } });
    toast('Provider activated');
    location.reload();
  };

  return (
    <section className="section">
      {mode === 'dev' && (
        <div className="banner amber">
          {identity.configured
            ? 'Started with npm run dev: local sign-in stays available next to the provider.'
            : 'Local development session. Without a provider, Archipel stays limited to this machine.'}
        </div>
      )}
      <IdentityForm identity={identity} onResult={setTestId} />
      {!identity.locked && (
        <div className="form-actions">
          <ActionButton className="primary" disabled={!testId} onAction={activate}>
            Activate this provider
          </ActionButton>
        </div>
      )}
    </section>
  );
}

function DatabasePanel({ settings }: { settings: Settings }) {
  const { database } = settings;
  const confirm = useConfirm();
  const toast = useToast();
  const [target, setTarget] = useState<DatabaseTarget | null>(null);
  const unchanged = target?.client === database.client && !('url' in target);

  const apply = async () => {
    const lost = [database.apps && plural(database.apps, 'app'), database.tokens && plural(database.tokens, 'token')]
      .filter(Boolean)
      .join(' and ');
    const confirmed = await confirm({
      title: 'Switch databases?',
      text: `Archipel does not copy data: ${lost || 'the current content'} will stay in the old database, intact but invisible. Switch back to it to find it again.`,
      confirm: 'Switch databases',
      danger: true,
    });
    if (!confirmed) return;
    const result = await save({ database: target });
    if (result.restart !== 'running') return toast('Saved: restart the server to switch databases.');
    toast('Restarting');
    await waitForServer();
    location.reload();
  };

  return (
    <section className="section">
      {!database.locked && !database.supported && (
        <div className="banner amber">{`${database.client} database configured outside the interface.`}</div>
      )}
      <DatabaseForm database={database} onChange={setTarget} />
      {!database.locked && (
        <div className="form-actions">
          <ActionButton className="primary" disabled={!target || unchanged} onAction={apply}>
            Apply and restart
          </ActionButton>
        </div>
      )}
    </section>
  );
}

export function SettingsPage({ tab: requested }: { tab: string | undefined }) {
  const tab = isTab(requested) ? requested : 'launchpad';
  const state = useLoad(() => api<Settings>('/api/settings'), [tab]);

  return (
    <div className="page">
      <PageHead title="Settings" lead="None of this is required: each setting keeps its default value until you change it." />
      <Segments label="Settings sections" tabs={[...TABS]} selected={tab} onSelect={(id) => navigate(`/settings/${id}`)} />
      <Async state={state}>
        {(settings) => (
          <>
            {tab === 'launchpad' && <LaunchpadPanel settings={settings} />}
            {tab === 'identity' && <IdentityPanel settings={settings} />}
            {tab === 'database' && <DatabasePanel settings={settings} />}
            {tab === 'agents' && <AgentsPanel />}
            {tab === 'sessions' && <SessionsPanel />}
          </>
        )}
      </Async>
    </div>
  );
}
