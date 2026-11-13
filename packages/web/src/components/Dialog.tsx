import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

interface Props {
  label?: string;
  className?: string;
  onClose: () => void;
  // Clicking the backdrop closes it, as for the command palette.
  dismissOnBackdrop?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

// A modal `<dialog>`: mounting it opens it, and closing it (button, Escape) calls `onClose`, which unmounts it.
export function Dialog({ label, className, onClose, dismissOnBackdrop = false, onKeyDown, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (dismissOnBackdrop && event.target === ref.current) onClose();
  };

  return (
    <dialog ref={ref} className={className} aria-label={label} onClose={onClose} onClick={onClick} onKeyDown={onKeyDown}>
      {children}
    </dialog>
  );
}
