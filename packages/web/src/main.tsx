import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api/client';
import type { Me } from './api/types';
import { ConfirmProvider } from './components/Confirm';
import { ToastProvider } from './components/Toasts';
import { App } from './shell/App';
import './styles.css';

// Without a session, this call sends the browser to the sign-in page and never answers.
const me = await api<Me>('/api/me');

createRoot(document.querySelector('#shell')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <App initialMe={me} />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
