import { useState, type ReactNode } from 'react';
import { messageOf } from '../api/client';
import { Icon } from './Icon';
import { useToast } from './Toasts';

interface Props {
  className?: string;
  title?: string;
  disabled?: boolean;
  onAction: () => Promise<unknown>;
  children: ReactNode;
}

// A button whose asynchronous action disables it during the call and reports its errors.
export function ActionButton({ className = '', title, disabled = false, onAction, children }: Props) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const run = async () => {
    setBusy(true);
    try {
      await onAction();
    } catch (error) {
      toast(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className={`btn ${className}`.trim()} type="button" title={title} disabled={disabled || busy} onClick={run}>
      {children}
    </button>
  );
}

// The feedback shows next to the button: a toast would sit under a dialog's blurred backdrop.
export function CopyButton({ text, onFeedback }: { text: string; onFeedback: (message: string) => void }) {
  const copy = async () => {
    // The clipboard only exists over HTTPS or locally: the text stays selectable in one click.
    try {
      await navigator.clipboard.writeText(text);
      onFeedback('Copied.');
    } catch {
      onFeedback('Copying is not possible here: click the text to select it, then copy it.');
    }
  };
  return (
    <ActionButton className="small" onAction={copy}>
      <Icon name="copy" />
      Copy
    </ActionButton>
  );
}
