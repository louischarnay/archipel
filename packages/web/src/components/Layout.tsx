import { useId, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}

export function PageHead({ title, lead, children }: { title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lead && <p>{lead}</p>}
      </div>
      {children}
    </div>
  );
}

interface SectionProps {
  title?: string;
  note?: string;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Section({ title, note, actions, className = '', children }: SectionProps) {
  return (
    <section className={`section ${className}`.trim()}>
      {title && (
        <div className="section-head">
          <div>
            <h2>{title}</h2>
            {note && <p className="section-note">{note}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Banner({
  tone = '',
  icon,
  children,
}: {
  tone?: 'red' | 'green' | 'amber' | '';
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`.trim()}>
      {icon && <Icon name={icon} />}
      {typeof children === 'string' && icon ? <p>{children}</p> : children}
    </div>
  );
}

interface Tab<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
}

interface SegmentsProps<T extends string> {
  tabs: Tab<T>[];
  selected: T;
  onSelect: (id: T) => void;
  label?: string;
  className?: string;
}

// A row of tabs: views of one list, or sections of one page.
export function Segments<T extends string>({ tabs, selected, onSelect, label, className = '' }: SegmentsProps<T>) {
  return (
    <div className={`segments ${className}`.trim()} role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          title={tab.title}
          aria-label={tab.title}
          aria-selected={tab.id === selected}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// A labelled control. `children` receives the id that ties the label to it.
export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Logs({ lines }: { lines: { id: number; level: string; message: string; at: string }[] }) {
  return (
    <pre className="logs">
      {lines.map((line) => (
        <span key={line.id} className={line.level}>
          <span className="at">{line.at.slice(11, 19)} </span>
          {`${line.message}\n`}
        </span>
      ))}
    </pre>
  );
}
