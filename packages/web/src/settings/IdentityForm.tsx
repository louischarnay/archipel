import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, messageOf } from '../api/client';
import type { IdentitySettings, IdentityTestResult } from '../api/types';
import { ActionButton, CopyButton } from '../components/ActionButton';
import { Icon } from '../components/Icon';
import { Banner, Field } from '../components/Layout';

const POLL_MS = 1000;

type Values = Record<
  'publicUrl' | 'providerName' | 'issuer' | 'clientId' | 'clientSecret' | 'scopes' | 'groupsClaim' | 'adminGroup',
  string
>;

function TestOutcome({ result }: { result: Exclude<IdentityTestResult, { status: 'waiting' }> }) {
  if (result.status === 'failed') {
    return (
      <Banner tone="red" icon="warn">
        {`Sign-in refused: ${result.error}`}
      </Banner>
    );
  }
  if (result.status === 'ok') {
    return (
      <Banner tone="green" icon="check">
        {`Sign-in succeeded: ${result.user.name}, administrator.`}
      </Banner>
    );
  }
  const groups = result.user.groups.join(', ') || 'none';
  return (
    <Banner tone="red" icon="warn">
      {`${result.user.name} signed in but is not a member of "${result.adminGroup}". Groups received: ${groups}. Fix the group, or the groups claim, then run the test again.`}
    </Banner>
  );
}

interface Props {
  identity: IdentitySettings;
  // The id of a successful test sign-in, or null as soon as what was entered no longer matches it.
  onResult: (testId: string | null) => void;
}

// The OIDC provider. Nothing is activated from here: the form only proves, by a real sign-in, that the settings work.
export function IdentityForm({ identity, onResult }: Props) {
  const [values, setValues] = useState<Values>(() => ({
    // Without a saved value, the browser's address is the best guess: the callback cookie depends on it.
    publicUrl: identity.publicUrlLocked || identity.configured ? identity.publicUrl : location.origin,
    providerName: identity.providerName,
    issuer: identity.issuer,
    clientId: identity.clientId,
    clientSecret: '',
    scopes: identity.scopes,
    groupsClaim: identity.groupsClaim,
    adminGroup: identity.adminGroup,
  }));
  const [status, setStatus] = useState<ReactNode>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const poll = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(poll.current), []);

  if (identity.locked) {
    return (
      <div className="form-stack">
        <Banner icon="key">
          <span>Identity is set by the server's environment (OIDC_ISSUER): change it there.</span>
        </Banner>
        <dl className="definition">
          <dt>Issuer</dt>
          <dd>{identity.issuer}</dd>
          <dt>Client ID</dt>
          <dd>{identity.clientId}</dd>
          <dt>Admin group</dt>
          <dd>{identity.adminGroup}</dd>
        </dl>
      </div>
    );
  }

  // A test only vouches for the values it ran with.
  const reset = () => {
    clearTimeout(poll.current);
    setStatus(null);
    onResult(null);
  };

  const input =
    (key: keyof Values, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    (id: string) => (
      <input
        id={id}
        type="text"
        {...props}
        value={values[key]}
        onChange={(event) => {
          setValues({ ...values, [key]: event.target.value });
          reset();
        }}
      />
    );

  const waitForLogin = (id: string) => {
    clearTimeout(poll.current);
    const check = async () => {
      let result: IdentityTestResult;
      try {
        result = await api<IdentityTestResult>(`/api/settings/identity/test/${id}`);
      } catch (error) {
        return setStatus(<Banner tone="red">{messageOf(error)}</Banner>);
      }
      if (result.status === 'waiting') {
        poll.current = setTimeout(check, POLL_MS);
        return;
      }
      setStatus(<TestOutcome result={result} />);
      onResult(result.status === 'ok' ? id : null);
    };
    poll.current = setTimeout(check, POLL_MS);
  };

  const startTest = async () => {
    reset();
    const result = await api<{ ok: boolean; error?: string; id: string; loginUrl: string }>('/api/settings/identity/test', {
      method: 'POST',
      body: values,
    });
    if (!result.ok) {
      return setStatus(
        <Banner tone="red" icon="warn">
          {result.error ?? 'Provider unreachable.'}
        </Banner>,
      );
    }
    setStatus(
      <Banner>
        <p>Provider found. Sign in with an administrator account: Archipel activates nothing before this check.</p>
        <a
          className="btn primary small"
          href={result.loginUrl}
          target="_blank"
          rel="noopener"
          onClick={() => waitForLogin(result.id)}
        >
          <Icon name="external" />
          Sign in
        </a>
      </Banner>,
    );
  };

  const callbackUrl = `${values.publicUrl.replace(/\/$/, '')}/auth/callback`;

  return (
    <div className="form-stack">
      <Field label="Public address of Archipel" hint="The address used in the browser, reverse proxy included.">
        {input('publicUrl', { type: 'url', disabled: identity.publicUrlLocked })}
      </Field>
      <div className="field">
        <span className="field-label">Callback URL to declare at the provider</span>
        <code className="secret">{callbackUrl}</code>
        <div className="copy-row">
          <CopyButton text={callbackUrl} onFeedback={setCopyFeedback} />
          <span className="hint" role="status">
            {copyFeedback}
          </span>
        </div>
      </div>
      <Field label="Issuer">{input('issuer', { type: 'url', placeholder: 'https://id.example.com' })}</Field>
      <div className="form-pair">
        <Field label="Client ID">{input('clientId')}</Field>
        <Field label="Client secret">
          {input('clientSecret', {
            type: 'password',
            autoComplete: 'new-password',
            placeholder: identity.hasClientSecret ? 'Unchanged if left empty' : 'Empty for a public client',
          })}
        </Field>
      </div>
      <Field label="Display name" hint={'On the sign-in button: "Continue with …".'}>
        {input('providerName', { maxLength: 40, placeholder: 'Entra ID, Pocket ID, Keycloak…' })}
      </Field>
      <Field label="Administrator group" hint="Its members can access review and settings.">
        {input('adminGroup')}
      </Field>
      <details className="more">
        <summary>Advanced settings</summary>
        <div className="form-stack">
          <Field label="Scopes">{input('scopes')}</Field>
          <Field label="Groups claim">{input('groupsClaim')}</Field>
        </div>
      </details>
      <div className="form-actions">
        <ActionButton className="primary" onAction={startTest}>
          Test the connection
        </ActionButton>
      </div>
      <div role="status">{status}</div>
    </div>
  );
}
