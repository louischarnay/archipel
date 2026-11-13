import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Kind = 'info' | 'error';
type Toast = (message: string, kind?: Kind) => void;

const ToastContext = createContext<Toast>(() => {});

export const useToast = () => useContext(ToastContext);

// Short messages in a corner of the screen. An error stays longer than a confirmation.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: Kind }[]>([]);

  const toast = useCallback<Toast>((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, kind }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div id="toasts" role="status" aria-live="polite">
        {toasts.map(({ id, message, kind }) => (
          <div key={id} className={`toast ${kind}`}>
            {message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
