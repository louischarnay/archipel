import { useEffect } from 'react';
import { api } from '../api/client';
import type { Launchpad } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { Icon } from '../components/Icon';
import { navigate } from '../lib/router';
import { useLoad } from '../lib/use-load';

// What an app's frame may do. Never `allow-same-origin`: its page must not reach the launchpad's session.
export const APP_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

// A live app inside the launchpad frame.
export function ViewerPage({ id }: { id: string }) {
  const state = useLoad(async () => (await api<Launchpad>('/api/launchpad')).apps.find((app) => app.id === id) ?? false, [id]);
  const missing = state.data === false;

  useEffect(() => {
    if (missing) navigate('/');
  }, [missing]);

  return (
    <Async state={state}>
      {(app) => {
        if (!app) return null;
        const src = `${app.route}/`;
        return (
          <div className="viewer">
            <div className="viewer-bar">
              <AppIcon app={app} small />
              {app.name}
              <span className="spacer" />
              <a className="btn ghost small" href={src} target="_blank" rel="noopener">
                <Icon name="external" />
                Full screen
              </a>
            </div>
            <iframe src={src} title={app.name} sandbox={APP_SANDBOX} />
          </div>
        );
      }}
    </Async>
  );
}
