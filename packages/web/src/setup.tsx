import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api/client';
import type { Settings } from './api/types';
import { ConfirmProvider } from './components/Confirm';
import { ToastProvider } from './components/Toasts';
import { SetupWizard, UnlockScreen } from './setup/SetupWizard';
import './styles.css';

const loadSettings = () => api<Settings>('/api/settings');

const { required, unlocked } = await api<{ required: boolean; unlocked: boolean }>('/api/setup/state');
const initial = required && !unlocked ? null : await loadSettings();

function Setup() {
  const [settings, setSettings] = useState(initial);
  if (!settings) return <UnlockScreen onUnlocked={async () => setSettings(await loadSettings())} />;
  return <SetupWizard settings={settings} />;
}

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <Setup />
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
