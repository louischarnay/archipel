import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Me } from '../api/types';
import { applyBranding } from '../lib/branding';
import { navigate, usePath } from '../lib/router';
import { AppDetailPage } from '../pages/AppDetail';
import { AppsPage } from '../pages/Apps';
import { LaunchpadPage } from '../pages/Launchpad';
import { ReleasePage } from '../pages/Release';
import { ReviewPage } from '../pages/Review';
import { SettingsPage } from '../pages/Settings';
import { TablesPage } from '../pages/Tables';
import { ViewerPage } from '../pages/Viewer';
import { AddAppDialog } from './AddAppDialog';
import { AgentDock } from './AgentDock';
import { ShellContext, type Shell } from './context';
import { Palette } from './Palette';
import { Sidebar } from './Sidebar';

interface Route {
  pattern: RegExp;
  adminOnly?: boolean;
  render: (params: string[]) => ReactNode;
}

const ROUTES: Route[] = [
  { pattern: /^\/$/, render: () => <LaunchpadPage /> },
  { pattern: /^\/open\/([\w-]+)$/, render: ([id]) => <ViewerPage id={id!} /> },
  { pattern: /^\/apps$/, adminOnly: true, render: () => <AppsPage /> },
  { pattern: /^\/apps\/([\w-]+)$/, adminOnly: true, render: ([id]) => <AppDetailPage key={id} id={id!} /> },
  { pattern: /^\/review$/, adminOnly: true, render: () => <ReviewPage /> },
  { pattern: /^\/review\/([\w-]+)$/, adminOnly: true, render: ([id]) => <ReleasePage key={id} id={id!} /> },
  { pattern: /^\/tables$/, adminOnly: true, render: () => <TablesPage /> },
  { pattern: /^\/settings(?:\/(\w+))?$/, adminOnly: true, render: ([tab]) => <SettingsPage tab={tab} /> },
];

// Saved links to pages that moved stay valid.
const MOVED: Record<string, string> = { '/agents': '/settings/agents', '/data': '/tables' };

// The page for a path, or the path to go to instead.
function resolve(path: string, admin: boolean): { page: ReactNode } | { redirect: string } {
  if (MOVED[path]) return { redirect: MOVED[path] };
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match && (admin || !route.adminOnly)) return { page: route.render(match.slice(1)) };
  }
  return { redirect: '/' };
}

// A single notice: the detail stays on hover, and `npm run dev` with OIDC keeps apps unisolated.
function DevBar({ me }: { me: Me }) {
  const notes = [
    me.authMode === 'dev' && 'Local session, without OIDC',
    me.user.admin && !me.isolated && 'Apps not isolated',
  ].filter(Boolean);
  if (!notes.length) return null;
  return (
    <div className="dev-bar" title={notes.join(' · ')}>
      Development mode
    </div>
  );
}

function isPaletteShortcut(event: KeyboardEvent) {
  return event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
}

// The frame around every page: sidebar, command palette, activity dock, and the page the hash names.
export function App({ initialMe }: { initialMe: Me }) {
  const [me, setMe] = useState(initialMe);
  const [navVersion, setNavVersion] = useState(0);
  const [linksVersion, setLinksVersion] = useState(0);
  const [logoVersion, setLogoVersion] = useState(() => Date.now());
  const [overlay, setOverlay] = useState<'palette' | 'add-app' | null>(null);
  const path = usePath();
  const main = useRef<HTMLElement>(null);

  const refreshNav = useCallback(() => setNavVersion((version) => version + 1), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openAddApp = useCallback(() => setOverlay('add-app'), []);
  // One dialog at a time: the palette does not open over a confirmation or a form.
  const openPalette = useCallback(() => {
    if (!document.querySelector('dialog[open]')) setOverlay('palette');
  }, []);

  const refreshBranding = useCallback(async () => {
    const next = await api<Me>('/api/me');
    setMe(next);
    setLogoVersion(Date.now());
    applyBranding(next.branding);
    document.title = next.branding.name;
    refreshNav();
  }, [refreshNav]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      setOverlay((current) => (current === 'palette' ? null : document.querySelector('dialog[open]') ? current : 'palette'));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const resolved = resolve(path, me.user.admin);
  const redirect = 'redirect' in resolved ? resolved.redirect : null;
  useEffect(() => {
    if (redirect) navigate(redirect);
  }, [redirect]);
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [path]);

  const shell = useMemo<Shell>(
    () => ({ me, refreshBranding, refreshNav, navVersion, linksVersion, logoVersion, openAddApp, openPalette }),
    [me, refreshBranding, refreshNav, navVersion, linksVersion, logoVersion, openAddApp, openPalette],
  );

  return (
    <ShellContext.Provider value={shell}>
      <Sidebar path={path} />
      <div className="content">
        <DevBar me={me} />
        <main className="main" ref={main}>
          {'page' in resolved && resolved.page}
        </main>
      </div>
      {me.user.admin && <AgentDock />}
      {overlay === 'palette' && <Palette onClose={closeOverlay} />}
      {overlay === 'add-app' && (
        <AddAppDialog
          onClose={closeOverlay}
          onLinkAdded={() => {
            setLinksVersion((version) => version + 1);
            refreshNav();
          }}
        />
      )}
    </ShellContext.Provider>
  );
}
