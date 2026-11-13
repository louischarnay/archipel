import { useEffect, useState, type ChangeEvent } from 'react';
import type { Branding } from '../api/types';
import { Icon } from '../components/Icon';
import { Field } from '../components/Layout';
import { applyBranding } from '../lib/branding';

// `logo`: undefined keeps the current one, null removes it, a data URL replaces it.
export type LaunchpadDraft = Branding & { logo?: string | null };

const ACCENTS = [
  ['ocean', 'Ocean'],
  ['lagon', 'Lagoon'],
  ['foret', 'Forest'],
  ['corail', 'Coral'],
  ['prune', 'Plum'],
  ['ardoise', 'Slate'],
] as const;

const LOGO_MAX_BYTES = 256 * 1024;
const LOGO_HINT = 'PNG, JPEG or WebP, 256 KB at most.';

// What the API expects from a draft. The wizard only asks for the essentials: the rest waits in the settings.
export function launchpadPayload(draft: LaunchpadDraft, { compact = false } = {}) {
  const { name, title, welcome, loginMessage, accent, background, showGroups, openMode, logo } = draft;
  if (compact) return { name, accent };
  const values = { name, title, welcome, loginMessage, accent, background, showGroups, openMode };
  return logo === undefined ? values : { ...values, logo };
}

interface ChoiceProps<T extends string> {
  name: string;
  label: string;
  options: readonly (readonly [T, string])[];
  value: string;
  onChange: (value: T) => void;
}

export function RadioRow<T extends string>({ name, label, options, value, onChange }: ChoiceProps<T>) {
  return (
    <fieldset className="choices">
      <legend>{label}</legend>
      <div className="choice-row">
        {options.map(([id, text]) => (
          <label className="choice" key={id}>
            <input type="radio" name={name} value={id} checked={id === value} onChange={() => onChange(id)} />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AccentPicker({ value, onChange }: { value: string; onChange: (accent: string) => void }) {
  return (
    <fieldset className="choices">
      <legend>Colour</legend>
      <div className="swatches">
        {ACCENTS.map(([id, label]) => (
          <label className="swatch" key={id} title={label} style={{ '--swatch': `var(--accent-${id})` } as React.CSSProperties}>
            <input
              className="sr-only"
              type="radio"
              name="accent"
              value={id}
              checked={id === value}
              onChange={() => onChange(id)}
            />
            <span className="swatch-dot" />
            <span className="swatch-name">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LogoField({ draft, onChange }: { draft: LaunchpadDraft; onChange: (logo: string | null) => void }) {
  const [feedback, setFeedback] = useState(LOGO_HINT);
  const preview = draft.logo === undefined ? '/ui/logo' : (draft.logo ?? '/ui/mark.svg');
  const hasLogo = draft.logo === undefined ? draft.hasLogo : draft.logo !== null;

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) return setFeedback('Image too large: 256 KB at most.');
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      onChange(reader.result as string);
      setFeedback(file.name);
    });
    reader.readAsDataURL(file);
  };

  const remove = () => {
    onChange(null);
    setFeedback('');
  };

  return (
    <div className="field">
      <span className="field-label">Logo</span>
      <div className="logo-row">
        <img className="logo-preview" src={preview} alt="" />
        <label className="btn small">
          <input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={pick} />
          <Icon name="upload" />
          Choose an image
        </label>
        {hasLogo && (
          <button className="btn small ghost" type="button" onClick={remove}>
            Remove
          </button>
        )}
      </div>
      <div className="hint" role="status">
        {feedback}
      </div>
    </div>
  );
}

interface Props {
  draft: LaunchpadDraft;
  onChange: (draft: LaunchpadDraft) => void;
  compact?: boolean;
}

// How the launchpad looks. The colours apply as they are picked, before anything is saved.
export function LaunchpadForm({ draft, onChange, compact = false }: Props) {
  const set = (patch: Partial<LaunchpadDraft>) => onChange({ ...draft, ...patch });
  const text = (key: 'name' | 'title' | 'welcome' | 'loginMessage', maxLength: number, placeholder?: string) => (id: string) => (
    <input
      id={id}
      type="text"
      maxLength={maxLength}
      placeholder={placeholder}
      required={key === 'name'}
      value={draft[key]}
      onChange={(event) => set({ [key]: event.target.value })}
    />
  );

  const { accent, background } = draft;
  useEffect(() => applyBranding({ accent, background }), [accent, background]);

  return (
    <div className="form-stack">
      <Field label="Platform name" hint="Shown in the menu, the browser tab and the sign-in page.">
        {text('name', 40)}
      </Field>
      <AccentPicker value={draft.accent} onChange={(value) => set({ accent: value })} />
      {!compact && (
        <>
          <LogoField draft={draft} onChange={(logo) => set({ logo })} />
          <Field label="Launchpad title">{text('title', 40)}</Field>
          <Field label="Welcome message" hint="Shown under the launchpad title.">
            {text('welcome', 200, 'Optional')}
          </Field>
          <Field label="Sign-in message" hint="Replaces the introduction text of the sign-in page.">
            {text('loginMessage', 200, 'Optional')}
          </Field>
          <RadioRow
            name="background"
            label="Background"
            options={[
              ['islands', 'Sea chart'],
              ['plain', 'Plain'],
            ]}
            value={draft.background}
            onChange={(value) => set({ background: value })}
          />
          <RadioRow
            name="openMode"
            label="Opening apps"
            options={[
              ['embedded', 'In the launchpad'],
              ['tab', 'In a new tab'],
            ]}
            value={draft.openMode}
            onChange={(openMode) => set({ openMode })}
          />
          <label className="check">
            <input type="checkbox" checked={draft.showGroups} onChange={(event) => set({ showGroups: event.target.checked })} />
            Group apps by app group on the launchpad
          </label>
        </>
      )}
    </div>
  );
}
