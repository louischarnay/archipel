import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { DatabaseSettings, DatabaseTarget } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { Banner, Field } from '../components/Layout';
import { plural } from '../lib/format';
import { RadioRow } from './LaunchpadForm';

const SQLITE = 'better-sqlite3';
const POSTGRES = 'pg';

type Engine = typeof SQLITE | typeof POSTGRES;

interface TestResult {
  ok: boolean;
  error?: string;
  version?: string;
  apps?: number | null;
}

interface Props {
  database: DatabaseSettings;
  // The database to switch to. For PostgreSQL it is only given once the connection is checked.
  onChange: (target: DatabaseTarget | null) => void;
}

export function DatabaseForm({ database, onChange }: Props) {
  const [engine, setEngine] = useState<Engine>(database.client === POSTGRES ? POSTGRES : SQLITE);
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<ReactNode>(null);

  if (database.locked) {
    return (
      <div className="form-stack">
        <Banner icon="key">
          <span>The database is set by the server's environment (DB_CLIENT, DB_URL): change it there.</span>
        </Banner>
        <dl className="definition">
          <dt>Connection</dt>
          <dd>{database.label}</dd>
        </dl>
      </div>
    );
  }

  const select = (next: Engine) => {
    setEngine(next);
    setUrl('');
    setStatus(null);
    onChange(next === SQLITE ? { client: SQLITE } : null);
  };

  const test = async () => {
    setStatus(null);
    onChange(null);
    const target = { client: POSTGRES, url } as const;
    const result = await api<TestResult>('/api/settings/database/test', { method: 'POST', body: target });
    if (!result.ok) {
      return setStatus(
        <Banner tone="red" icon="warn">
          {`Connection failed: ${result.error}`}
        </Banner>,
      );
    }
    const content =
      result.apps === null || result.apps === undefined
        ? 'the database holds no platform yet, its tables will be created.'
        : `the database already holds a platform with ${plural(result.apps, 'app')}.`;
    setStatus(
      <Banner tone="green" icon="check">
        {`${result.version}: ${content}`}
      </Banner>,
    );
    onChange(target);
  };

  return (
    <div className="form-stack">
      <RadioRow
        name="database"
        label="Engine"
        options={[
          [SQLITE, 'SQLite'],
          [POSTGRES, 'PostgreSQL'],
        ]}
        value={engine}
        onChange={select}
      />
      {engine === SQLITE && (
        <p className="section-note">
          {database.client === SQLITE ? `A file on this server: ${database.label}` : 'A local file in the Archipel data folder.'}
        </p>
      )}
      {engine === POSTGRES && (
        <div className="form-stack">
          {database.client === POSTGRES && (
            <dl className="definition">
              <dt>Current connection</dt>
              <dd>{database.label}</dd>
            </dl>
          )}
          <Field label="Connection URL" hint="It is kept in data/instance.json, readable only by the server's account.">
            {(id) => (
              <input
                id={id}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  database.client === POSTGRES
                    ? 'New full URL, password included'
                    : 'postgres://archipel:password@host:5432/archipel'
                }
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setStatus(null);
                  onChange(null);
                }}
              />
            )}
          </Field>
          <div className="form-actions">
            <ActionButton className="primary" onAction={test}>
              Test the connection
            </ActionButton>
          </div>
        </div>
      )}
      <div role="status">{status}</div>
    </div>
  );
}

// After a database switch the server restarts: wait until it answers again.
export async function waitForServer() {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
  await pause();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const healthy = await fetch('/health').then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) return;
    await pause();
  }
  throw new Error('The server no longer answers: check its logs.');
}
