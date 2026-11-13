import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, messageOf } from '../api/client';
import type { Command, CommandField, CommandResult, Launchpad } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { Banner } from '../components/Layout';
import { navigate } from '../lib/router';
import { useShell } from './context';
import { itemLink, launchpadItems } from './launchpad-items';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const SHORTCUT_LABEL = IS_MAC ? '⌘K' : 'Ctrl K';

const PAGES: { title: string; path: string; icon: IconName; adminOnly?: boolean }[] = [
  { title: 'Launchpad', path: '/', icon: 'home' },
  { title: 'Apps', path: '/apps', icon: 'apps', adminOnly: true },
  { title: 'Review', path: '/review', icon: 'review', adminOnly: true },
  { title: 'Tables', path: '/tables', icon: 'database', adminOnly: true },
  { title: 'Settings', path: '/settings', icon: 'settings', adminOnly: true },
];

interface Entry {
  group: string;
  title: string;
  sub?: string;
  visual: ReactNode;
  badge?: string;
  search: string;
  run: () => void;
}

// Ignoring accents and case: "cafe" must find "Café".
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const CircleIcon = ({ name }: { name: IconName }) => (
  <span className="palette-icon">
    <Icon name={name} />
  </span>
);

const isNumeric = (type: CommandField['type']) => type === 'integer' || type === 'number';

function FieldControl({ field }: { field: CommandField }) {
  const { name, type } = field;
  if (type === 'boolean') {
    return (
      <label className="check">
        <input type="checkbox" name={name} />
        {name}
      </label>
    );
  }
  const id = `palette-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{name}</label>
      <input
        id={id}
        name={name}
        type={isNumeric(type) ? 'number' : 'text'}
        step={type === 'number' ? 'any' : undefined}
        required
        autoComplete="off"
        spellCheck={false}
      />
      {type === 'uuid' && <div className="hint">Id in uuid format</div>}
    </div>
  );
}

function readFields(form: HTMLFormElement, fields: CommandField[]) {
  const values: Record<string, unknown> = {};
  for (const { name, type } of fields) {
    const input = form.elements.namedItem(name) as HTMLInputElement;
    values[name] = type === 'boolean' ? input.checked : isNumeric(type) ? Number(input.value) : input.value.trim();
  }
  return values;
}

function Outcome({ response }: { response: CommandResult }) {
  const failed = response.status >= 400;
  const value = response.result as { error?: string } | null;
  const hasDetail = value !== null && !(failed && value?.error);
  return (
    <>
      <div className={`banner ${failed ? 'red' : 'green'}`} role="status">
        <Icon name={failed ? 'warn' : 'check'} />
        <p>{failed ? (value?.error ?? `The app answered ${response.status}.`) : 'Action completed.'}</p>
      </div>
      {hasDetail && <pre className="palette-result mono">{JSON.stringify(value, null, 2)}</pre>}
    </>
  );
}

// An action writes to an app: it always asks for an explicit gesture, even without fields.
function CommandForm({ command, onBack }: { command: Command; onBack: () => void }) {
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    (
      form.current?.querySelector<HTMLElement>('.field input, .check input') ?? form.current?.querySelector('button[type=submit]')
    )?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRunning(true);
    setOutcome(null);
    try {
      const path = `/api/commands/${encodeURIComponent(command.app.id)}/${encodeURIComponent(command.name)}`;
      const input = readFields(event.currentTarget, command.fields);
      setOutcome(<Outcome response={await api<CommandResult>(path, { method: 'POST', body: { input } })} />);
    } catch (error) {
      setOutcome(
        <Banner tone="red" icon="warn">
          {messageOf(error)}
        </Banner>,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <form className="palette-form" ref={form} onSubmit={submit}>
      <div className="palette-form-head">
        <button className="btn ghost small" type="button" aria-label="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
        <div className="palette-text">
          <div className="palette-title">{command.description}</div>
          <div className="palette-sub">{`${command.app.name} · ${command.name}`}</div>
        </div>
      </div>
      {command.fields.map((field) => (
        <FieldControl key={field.name} field={field} />
      ))}
      <div className="form-actions">
        <button className="btn primary" type="submit" disabled={running}>
          Run
        </button>
      </div>
      <div className="form-stack">{outcome}</div>
    </form>
  );
}

// Everything reachable from the keyboard: app actions, live apps, pages of the platform.
export function Palette({ onClose }: { onClose: () => void }) {
  const { me, openAddApp } = useShell();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [command, setCommand] = useState<Command | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const { admin } = me.user;
  const { openMode } = me.branding;

  useEffect(() => {
    const entry = (group: string, title: string, visual: ReactNode, run: () => void, sub?: string, badge?: string): Entry => ({
      group,
      title,
      sub,
      visual,
      badge,
      run,
      search: normalize(`${title} ${sub ?? ''}`),
    });
    const go = (path: string) => () => {
      onClose();
      navigate(path);
    };
    const load = async () => {
      const [{ commands }, launchpad] = await Promise.all([
        api<{ commands: Command[] }>('/api/commands'),
        api<Launchpad>('/api/launchpad'),
      ]);
      const actions = commands.map((item) =>
        entry(
          'App actions',
          item.description,
          <CircleIcon name="bolt" />,
          () => setCommand(item),
          `${item.app.name} · ${item.name}`,
          'MCP',
        ),
      );
      const apps = launchpadItems(launchpad).map((item) => {
        const link = itemLink(item, openMode);
        const open = link.target
          ? () => {
              onClose();
              window.open(link.href, '_blank', 'noopener');
            }
          : go(link.href.slice(1));
        return entry('Go to', item.name, <AppIcon app={item} />, open);
      });
      const pages = PAGES.filter((page) => admin || !page.adminOnly).map((page) =>
        entry('Platform', page.title, <CircleIcon name={page.icon} />, go(page.path)),
      );
      const addApp = entry('Platform', 'Add an app', <CircleIcon name="plus" />, () => {
        onClose();
        openAddApp();
      });
      setEntries([...actions, ...apps, ...pages, ...(admin ? [addApp] : [])]);
    };
    load().catch((error: unknown) => setLoadError(messageOf(error)));
  }, [admin, openMode, onClose, openAddApp]);

  const visible = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return entries.filter((entry) => words.every((word) => entry.search.includes(word)));
  }, [entries, query]);
  const active = Math.min(selected, Math.max(visible.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, visible]);

  useEffect(() => {
    if (!command) input.current?.select();
  }, [command]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length) setSelected((active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      visible[active]?.run();
    }
  };

  // On the key and not on `cancel`: without a gesture between two Escapes, the browser may ignore the cancel and close.
  const onDialogKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !command) return;
    event.preventDefault();
    setCommand(null);
  };

  return (
    <Dialog className="palette" label="Commands" onClose={onClose} dismissOnBackdrop onKeyDown={onDialogKey}>
      {command ? (
        <CommandForm command={command} onBack={() => setCommand(null)} />
      ) : (
        <>
          <div className="palette-search">
            <Icon name="search" />
            <input
              ref={input}
              type="text"
              role="combobox"
              autoFocus
              placeholder="A command or an app"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search for a command or an app"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={visible.length ? `palette-option-${active}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={onSearchKey}
            />
            <kbd>esc</kbd>
          </div>
          <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results" ref={list}>
            {visible.map((entry, index) => (
              <PaletteRow
                key={`${entry.group}-${entry.title}-${entry.sub ?? ''}`}
                entry={entry}
                index={index}
                active={index === active}
                firstOfGroup={entry.group !== visible[index - 1]?.group}
                onHover={() => setSelected(index)}
              />
            ))}
            {!visible.length && <li className="palette-empty">{loadError ?? 'No results'}</li>}
          </ul>
        </>
      )}
    </Dialog>
  );
}

interface RowProps {
  entry: Entry;
  index: number;
  active: boolean;
  firstOfGroup: boolean;
  onHover: () => void;
}

function PaletteRow({ entry, index, active, firstOfGroup, onHover }: RowProps) {
  return (
    <>
      {firstOfGroup && (
        <li className="palette-group" role="presentation">
          {entry.group}
        </li>
      )}
      <li
        className="palette-item"
        id={`palette-option-${index}`}
        role="option"
        aria-selected={active}
        onMouseMove={active ? undefined : onHover}
        onClick={entry.run}
      >
        {entry.visual}
        <div className="palette-text">
          <div className="palette-title">{entry.title}</div>
          {entry.sub && <div className="palette-sub">{entry.sub}</div>}
        </div>
        {entry.badge && <span className="badge mono">{entry.badge}</span>}
      </li>
    </>
  );
}
