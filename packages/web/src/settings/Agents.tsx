import { useState, type FormEvent } from 'react';
import { api, messageOf } from '../api/client';
import type { AgentToken, IssuedToken } from '../api/types';
import { ActionButton, CopyButton } from '../components/ActionButton';
import { Async } from '../components/Async';
import { Badge } from '../components/Badge';
import { useConfirm } from '../components/Confirm';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { EmptyState, Field } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { formatDate } from '../lib/format';
import { useLoad } from '../lib/use-load';

const DURATIONS = [
  [30, '30 days'],
  [90, '90 days'],
  [365, '1 year'],
] as const;

// The skill and the CLI live on the agent's side: these commands only contain the address, the token is pasted at the keyboard.
const SKILLS_DIR = '~/.claude/skills';
const INSTALL_COMMAND = `mkdir -p ${SKILLS_DIR} && curl -fsSL ${location.origin}/agent/skill.tar.gz | tar -xz -C ${SKILLS_DIR}`;
const LOGIN_COMMAND = `node ${SKILLS_DIR}/archipel/scripts/archipel.mjs login ${location.origin}`;

const isActive = (token: AgentToken) => !token.revoked_at && new Date(token.expires_at) > new Date();

const appIds = (value: string) => [
  ...new Set(
    value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

function TokenStatus({ token }: { token: AgentToken }) {
  if (token.revoked_at) return <Badge>Revoked</Badge>;
  return isActive(token) ? <Badge tone="green">Active</Badge> : <Badge tone="amber">Expired</Badge>;
}

interface StepProps {
  number: number;
  title: string;
  text: string;
  command?: string;
  onFeedback: (message: string) => void;
}

function Step({ number, title, text, command, onFeedback }: StepProps) {
  return (
    <li className="step">
      <span className="step-number" aria-hidden="true">
        {number}
      </span>
      <div className="step-body">
        <div className="step-title">{title}</div>
        <p className="step-text">{text}</p>
        {command && (
          <div className="command">
            <code className="secret">{command}</code>
            <CopyButton text={command} onFeedback={onFeedback} />
          </div>
        )}
      </div>
    </li>
  );
}

// `issued`: a token was just created and is still on screen, ready to paste.
function ClaudeCodeSteps({ issued }: { issued: boolean }) {
  const [feedback, setFeedback] = useState('');
  const connect = issued
    ? 'Run this command, then paste the token above when asked.'
    : 'Create a token, run this command and paste it when asked.';
  return (
    <>
      <ol className="steps">
        <Step
          number={1}
          title="Install the Archipel skill"
          text="On the machine where Claude Code runs. The skill teaches it to write an app, deploy it in preview and read each review. It contains the CLI and only needs Node 22. Run the command again to update it."
          command={INSTALL_COMMAND}
          onFeedback={setFeedback}
        />
        <Step
          number={2}
          title="Connect it to this platform"
          text={`${connect} It is not displayed; it is checked, then saved in ~/.config/archipel, outside your projects.`}
          command={LOGIN_COMMAND}
          onFeedback={setFeedback}
        />
        <Step
          number={3}
          title="Ask for an app"
          text={
            'In Claude Code, for example: "Create an Archipel app to track equipment loans". It arrives in Review with its report, and nothing goes live without your decision. If you request changes, Claude Code reads your comment and fixes it.'
          }
          onFeedback={setFeedback}
        />
      </ol>
      <p className="section-note" role="status">
        {feedback}
      </p>
    </>
  );
}

// The token only exists in plain text in this response: once the window is closed, another one must be created.
function IssuedToken({ issued, onDone }: { issued: IssuedToken; onDone: () => void }) {
  const [feedback, setFeedback] = useState('');
  const environment = `export ARCHIPEL_URL=${location.origin}\nexport ARCHIPEL_TOKEN=${issued.token}`;
  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <h2>{`Token ${issued.name} created`}</h2>
      </div>
      <div className="banner amber">Copy it now: it will not be shown again.</div>
      <div className="field">
        <span className="field-label">Token</span>
        <div className="command">
          <code className="secret">{issued.token}</code>
          <CopyButton text={issued.token} onFeedback={setFeedback} />
        </div>
      </div>
      <p className="section-note" role="status">
        {feedback}
      </p>
      <h3 className="dialog-subtitle">Connect Claude Code</h3>
      <ClaudeCodeSteps issued />
      <details className="more">
        <summary>Other agent or continuous integration</summary>
        <p className="step-text">
          The CLI also reads ARCHIPEL_URL and ARCHIPEL_TOKEN, which take precedence over the saved connection. Keep them in a
          secrets manager, never in a repository.
        </p>
        <div className="command">
          <pre className="secret">{environment}</pre>
          <CopyButton text={environment} onFeedback={setFeedback} />
        </div>
      </details>
      <div className="dialog-foot">
        <button className="btn primary" type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function CreateTokenDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', days: 90, apps: '' });
  const [sending, setSending] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    try {
      const body = { name: form.name, days: form.days, apps: appIds(form.apps) };
      setIssued(await api<IssuedToken>('/api/agent-tokens', { method: 'POST', body }));
    } catch (error) {
      toast(messageOf(error), 'error');
      setSending(false);
    }
  };

  return (
    <Dialog className="wide" label="Create an agent token" onClose={onClose}>
      {issued ? (
        <IssuedToken issued={issued} onDone={onClose} />
      ) : (
        <form className="dialog-body" onSubmit={submit}>
          <div className="dialog-head">
            <h2>Create an agent token</h2>
            <button className="btn ghost small" type="button" aria-label="Close" onClick={onClose}>
              <Icon name="cross" />
            </button>
          </div>
          <Field label="Name" hint="Shown as the author of submitted versions.">
            {(id) => (
              <input
                id={id}
                type="text"
                maxLength={64}
                placeholder="claude-code"
                required
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Duration">
            {(id) => (
              <select id={id} value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })}>
                {DURATIONS.map(([days, label]) => (
                  <option key={days} value={days}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Allowed apps" hint="Ids separated by commas. Leave empty to allow all apps.">
            {(id) => (
              <input
                id={id}
                type="text"
                placeholder="tickets, customers"
                value={form.apps}
                onChange={(event) => setForm({ ...form, apps: event.target.value })}
              />
            )}
          </Field>
          <p className="step-text">
            With this token, an agent submits versions in preview and reads their reports. It cannot approve, change what is live,
            or create another token. It is shown only once, with the steps to connect Claude Code.
          </p>
          <div className="dialog-foot">
            <button className="btn primary" type="submit" disabled={sending}>
              Create token
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function TokensTable({ tokens, onRevoke }: { tokens: AgentToken[]; onRevoke: (token: AgentToken) => Promise<void> }) {
  return (
    <div className="table-scroll">
      <table className="table static">
        <thead>
          <tr>
            {['Name', 'Status', 'Apps', 'Last used', 'Expires', ''].map((label) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.id}>
              <td>
                <div>{token.name}</div>
                <div className="sub mono">{token.id}</div>
              </td>
              <td>
                <TokenStatus token={token} />
              </td>
              <td>
                {token.apps ? (
                  token.apps.join(', ')
                ) : (
                  <Badge tone="amber" title="This token can submit a version of any app.">
                    All
                  </Badge>
                )}
              </td>
              <td>{token.last_used_at ? formatDate(token.last_used_at) : 'Never'}</td>
              <td>{formatDate(token.expires_at)}</td>
              <td className="cell-actions">
                {isActive(token) && (
                  <ActionButton className="small danger" onAction={() => onRevoke(token)}>
                    Revoke
                  </ActionButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Agent tokens: one per agent, issued by a person, revocable at any time.
export function AgentsPanel() {
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const state = useLoad(() => api<{ tokens: AgentToken[] }>('/api/agent-tokens'), []);

  const revoke = async (token: AgentToken) => {
    const confirmed = await confirm({
      title: `Revoke ${token.name}?`,
      text: 'The agent using it loses access immediately. Versions already submitted stay in place.',
      confirm: 'Revoke',
      danger: true,
    });
    if (!confirmed) return;
    await api(`/api/agent-tokens/${token.id}/revoke`, { method: 'POST' });
    await state.reload();
  };

  const closeDialog = () => {
    setCreating(false);
    void state.reload();
  };

  const createButton = (className: string, label: string) => (
    <button className={`btn primary ${className}`.trim()} type="button" onClick={() => setCreating(true)}>
      <Icon name="plus" />
      {label}
    </button>
  );

  return (
    <Async state={state}>
      {({ tokens }) => (
        <div>
          <section className="section connect">
            <div className="section-head">
              <h2>Connect Claude Code</h2>
            </div>
            <p className="section-note">
              Optional: without an agent, everything is done from this interface. With one, Claude Code develops and deploys the
              apps, and you keep every go-live decision.
            </p>
            <ClaudeCodeSteps issued={false} />
          </section>
          <div className="section-head tokens-head">
            <h2>Tokens</h2>
            {tokens.length > 0 && createButton('small', 'Create a token')}
          </div>
          {tokens.length ? (
            <TokensTable tokens={tokens} onRevoke={revoke} />
          ) : (
            <EmptyState
              title="No tokens"
              text="Create one per agent: you can limit it to some apps, see when it was last used and revoke it."
            >
              {createButton('', 'Create a token')}
            </EmptyState>
          )}
          {creating && <CreateTokenDialog onClose={closeDialog} />}
        </div>
      )}
    </Async>
  );
}
