import { useState, type FormEvent, type ReactNode } from 'react';
import { api, messageOf } from '../api/client';
import type { DatabaseTarget, Settings, SettingsSaved } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { DatabaseForm, waitForServer } from '../settings/DatabaseForm';
import { IdentityForm } from '../settings/IdentityForm';
import { LaunchpadForm, launchpadPayload, type LaunchpadDraft } from '../settings/LaunchpadForm';

const STEPS = ['Welcome', 'Identity', 'Database', 'Done'] as const;
const FINISH = STEPS.length - 1;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="stepper">
      {STEPS.map((label, index) => (
        <li key={label} className={index === current ? 'current' : index < current ? 'done' : ''}>
          <span className="step-dot">{index < current ? <Icon name="check" /> : index + 1}</span>
          <span className="step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

interface FooterProps {
  onBack?: () => void;
  onSkip?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}

function Footer({ onBack, onSkip, onNext, nextDisabled = false }: FooterProps) {
  return (
    <div className="setup-foot">
      {onBack && (
        <button className="btn ghost" type="button" onClick={onBack}>
          Back
        </button>
      )}
      <span className="spacer" />
      {onSkip && (
        <button className="btn ghost" type="button" onClick={onSkip}>
          Skip
        </button>
      )}
      <button className="btn primary" type="button" disabled={nextDisabled} onClick={onNext}>
        Continue
      </button>
    </div>
  );
}

// A step stays mounted once shown: going back loses neither what was entered nor a successful test.
function StepBody({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div className="setup-body" hidden={!shown}>
      {children}
    </div>
  );
}

// The first sign-in wizard. Nothing is saved before the last step: every choice is sent in one request.
export function SetupWizard({ settings }: { settings: Settings }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [launchpad, setLaunchpad] = useState<LaunchpadDraft>(settings.launchpad);
  const [testId, setTestId] = useState<string | null>(null);
  // Without a choice, the current database stays in place: only an unchecked PostgreSQL blocks the next step.
  const [database, setDatabase] = useState<DatabaseTarget | null>(
    settings.database.client === 'pg' ? null : { client: 'better-sqlite3' },
  );
  const [databaseTouched, setDatabaseTouched] = useState(false);

  const { identity } = settings;
  // Without a provider nobody could sign in afterwards: in that case the Identity step cannot be skipped.
  const installing = settings.mode === 'setup';
  const go = (next: number) => {
    setStep(next);
    scrollTo(0, 0);
  };
  const next = () => go(step + 1);
  const back = () => go(step - 1);

  const changesDatabase = Boolean(database && (database.client !== settings.database.client || 'url' in database));
  const databaseLocked = settings.database.locked;

  const finishLater = async () => {
    await api('/api/settings', { method: 'PUT', body: { completeSetup: true } });
    location.href = '/';
  };

  const finish = async () => {
    const body = {
      launchpad: launchpadPayload(launchpad, { compact: true }),
      completeSetup: true,
      ...(testId ? { identity: { testId } } : {}),
      ...(changesDatabase ? { database } : {}),
    };
    const result = await api<SettingsSaved>('/api/settings', { method: 'PUT', body });
    if (result.restart === 'running') await waitForServer();
    else if (result.restart === 'manual') toast('Restart the server to switch databases.');
    location.href = '/';
  };

  const identityDone = identity.locked || Boolean(testId);
  const identityLabel = testId
    ? 'OIDC provider checked'
    : identity.configured
      ? 'OIDC provider already configured'
      : 'Local session, to configure in the settings';
  const databaseLabel = changesDatabase
    ? database!.client === 'pg'
      ? 'PostgreSQL, checked'
      : 'SQLite'
    : settings.database.client === 'pg'
      ? settings.database.label
      : 'SQLite';

  return (
    <section className="setup-card">
      <Stepper current={step} />

      <StepBody shown={step === 0}>
        <h1>Welcome to Archipel</h1>
        <p className="setup-lead">A few settings to get started. Everything can be changed later in the settings.</p>
        <LaunchpadForm draft={launchpad} onChange={setLaunchpad} compact />
        {!installing && (
          <div className="setup-later">
            <ActionButton className="ghost small" onAction={finishLater}>
              Set everything up later
            </ActionButton>
          </div>
        )}
        <Footer onNext={next} />
      </StepBody>

      <StepBody shown={step === 1}>
        <h1>Identity</h1>
        <p className="setup-lead">
          {installing
            ? 'Archipel does not manage accounts: sign-in goes through your OIDC provider. This is the only required step here, because nobody could sign in without it. To try it without a provider, run npm run dev.'
            : 'Archipel does not manage accounts: sign-in goes through your OIDC provider. You can skip this step and stay in a local session.'}
        </p>
        <IdentityForm identity={identity} onResult={setTestId} />
        <Footer
          onBack={back}
          onSkip={!installing && !identity.locked ? next : undefined}
          onNext={next}
          nextDisabled={!identityDone}
        />
      </StepBody>

      <StepBody shown={step === 2}>
        <h1>Database</h1>
        <p className="setup-lead">SQLite is enough to start, with nothing to install. PostgreSQL suits lasting shared use.</p>
        {(settings.database.apps > 0 || settings.database.tokens > 0) && (
          <div className="banner amber">
            This instance already has data. Archipel does not copy it: it would stay in the current database. If in doubt, skip
            this step.
          </div>
        )}
        <DatabaseForm
          database={settings.database}
          onChange={(target) => {
            setDatabase(target);
            setDatabaseTouched(true);
          }}
        />
        <Footer onBack={back} onNext={next} nextDisabled={!databaseLocked && databaseTouched && !database} />
      </StepBody>

      {step === FINISH && (
        <div className="setup-body">
          <h1>All set</h1>
          <p className="setup-lead">Nothing is applied before you click below.</p>
          <dl className="definition setup-summary">
            <dt>Platform</dt>
            <dd>{launchpad.name}</dd>
            <dt>Sign-in</dt>
            <dd>{identityLabel}</dd>
            <dt>Database</dt>
            <dd>{databaseLabel}</dd>
          </dl>
          <ActionButton className="primary large block" onAction={finish}>
            {installing ? 'Finish and sign in' : 'Open Archipel'}
          </ActionButton>
          <div className="setup-foot">
            <button className="btn ghost" type="button" onClick={back}>
              Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// Without a provider, only the code written in the server logs opens the wizard.
export function UnlockScreen({ onUnlocked }: { onUnlocked: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api('/api/setup/unlock', { method: 'POST', body: { code } });
      await onUnlocked();
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  return (
    <section className="setup-card">
      <form className="setup-body" onSubmit={submit}>
        <img className="setup-mark" src="/ui/logo" alt="" width="56" height="56" />
        <h1>Install Archipel</h1>
        <p className="setup-lead">Enter the setup code shown in the server logs. It proves that you control this machine.</p>
        <div className="field">
          <label htmlFor="setup-code">Setup code</label>
          <input
            id="setup-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX"
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div role="alert">{error && <div className="banner red">{error}</div>}</div>
        <button className="btn primary large block" type="submit">
          Continue
        </button>
      </form>
    </section>
  );
}
