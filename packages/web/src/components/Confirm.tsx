import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';

interface Question {
  title: string;
  text: string;
  confirm: string;
  danger?: boolean;
}

type Confirm = (question: Question) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));

// `const ok = await confirm({ ... })`: asks before an action that removes or replaces something.
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ question: Question; answer: (ok: boolean) => void } | null>(null);

  const confirm = useCallback<Confirm>((question) => new Promise((answer) => setPending({ question, answer })), []);

  const close = (ok: boolean) => {
    pending?.answer(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Dialog onClose={() => close(false)}>
          <div className="dialog-body">
            <h2>{pending.question.title}</h2>
            <p>{pending.question.text}</p>
            <div className="dialog-foot">
              <button className="btn" type="button" onClick={() => close(false)}>
                Cancel
              </button>
              <button
                className={`btn ${pending.question.danger ? 'danger' : 'primary'}`}
                type="button"
                onClick={() => close(true)}
              >
                {pending.question.confirm}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}
