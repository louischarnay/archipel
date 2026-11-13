import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { api, messageOf } from '../api/client';
import type { Launchpad, ReleaseCounts } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Icon, type IconName } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { recall, remember } from '../lib/storage';
import { useShell } from './context';
import { itemLink, launchpadItems, type LaunchpadItem } from './launchpad-items';
import { SHORTCUT_LABEL } from './Palette';

const WIDTH_KEY = 'archipel.sidebar.width';
const COLLAPSED_KEY = 'archipel.sidebar.collapsed';
const DEFAULT_WIDTH = 236;
const MIN_WIDTH = 190;
const MAX_WIDTH = 380;
const KEY_STEP = 16;

const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

interface NavItemProps {
  href: string;
  icon: IconName;
  label: string;
  current: boolean;
  collapsed: boolean;
  children?: ReactNode;
}

function NavItem({ href, icon, label, current, collapsed, children }: NavItemProps) {
  return (
    <a className="nav-item" href={href} title={collapsed ? label : undefined} aria-current={current ? 'page' : undefined}>
      <Icon name={icon} />
      <span className="nav-text">{label}</span>
      {children}
    </a>
  );
}

// The sidebar keeps its width and its collapsed state in the browser.
function useSidebarFrame() {
  const [width, setWidth] = useState(() => clamp(Number(recall(WIDTH_KEY)) || DEFAULT_WIDTH));
  const [collapsed, setCollapsed] = useState(() => recall(COLLAPSED_KEY) === '1');
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const resizeTo = (next: number) => {
    const clamped = clamp(next);
    setWidth(clamped);
    remember(WIDTH_KEY, clamped);
  };

  const handle = {
    onDoubleClick: () => resizeTo(DEFAULT_WIDTH),
    onKeyDown: (event: KeyboardEvent) => {
      const targets: Record<string, number> = {
        ArrowLeft: width - KEY_STEP,
        ArrowRight: width + KEY_STEP,
        Home: MIN_WIDTH,
        End: MAX_WIDTH,
      };
      const next = targets[event.key];
      if (next === undefined) return;
      event.preventDefault();
      resizeTo(next);
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      drag.current = { startX: event.clientX, startWidth: width };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('sidebar-resizing');
    },
    onPointerMove: (event: PointerEvent) => {
      if (drag.current) setWidth(clamp(drag.current.startWidth + event.clientX - drag.current.startX));
    },
    onPointerUp: () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove('sidebar-resizing');
      remember(WIDTH_KEY, width);
    },
  };

  const toggle = () => {
    remember(COLLAPSED_KEY, collapsed ? 0 : 1);
    setCollapsed(!collapsed);
  };

  return { width, collapsed, toggle, handle };
}

export function Sidebar({ path }: { path: string }) {
  const { me, navVersion, logoVersion, openPalette } = useShell();
  const toast = useToast();
  const { width, collapsed, toggle, handle } = useSidebarFrame();
  const [items, setItems] = useState<LaunchpadItem[]>([]);
  const [pending, setPending] = useState(0);
  const { admin } = me.user;

  // Read again on every page change: an approval elsewhere may have put an app live.
  useEffect(() => {
    let current = true;
    const load = async () => {
      const [launchpad, counts] = await Promise.all([
        api<Launchpad>('/api/launchpad'),
        admin ? api<ReleaseCounts>('/api/releases/counts') : null,
      ]);
      if (!current) return;
      setItems(launchpadItems(launchpad));
      setPending(counts?.queue ?? 0);
    };
    load().catch((error: unknown) => toast(messageOf(error), 'error'));
    return () => {
      current = false;
    };
  }, [path, navVersion, admin, toast]);

  const signOut = async () => {
    const { redirect } = await api<{ redirect: string | null }>('/auth/logout', { method: 'POST' });
    location.href = redirect ?? '/login';
  };

  const toggleLabel = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';

  return (
    <div
      className={`sidebar-frame ${collapsed ? 'collapsed' : ''}`.trim()}
      style={{ '--sidebar-width': `${width}px` } as React.CSSProperties}
    >
      <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`.trim()} aria-label="Main navigation">
        <div className="brand-row">
          <a className="brand" href="#/" aria-label={me.branding.name}>
            <img src={`/ui/logo?v=${logoVersion}`} alt="" />
            <span>{me.branding.name}</span>
          </a>
          <button
            className="btn ghost small sidebar-toggle"
            type="button"
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            onClick={toggle}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <button
          className="palette-trigger"
          type="button"
          onClick={openPalette}
          title={collapsed ? 'Commands' : undefined}
          aria-label="Open commands"
        >
          <Icon name="search" />
          <span className="palette-trigger-label">Commands</span>
          <kbd>{SHORTCUT_LABEL}</kbd>
        </button>
        <div className="nav">
          <NavItem href="#/" icon="home" label="Launchpad" current={path === '/'} collapsed={collapsed} />
          {admin && (
            <>
              <NavItem href="#/apps" icon="apps" label="Apps" current={path.startsWith('/apps')} collapsed={collapsed} />
              <NavItem href="#/review" icon="review" label="Review" current={path.startsWith('/review')} collapsed={collapsed}>
                {pending > 0 && <span className="count">{pending}</span>}
              </NavItem>
              <NavItem href="#/tables" icon="database" label="Tables" current={path === '/tables'} collapsed={collapsed} />
              <NavItem
                href="#/settings"
                icon="settings"
                label="Settings"
                current={path.startsWith('/settings')}
                collapsed={collapsed}
              />
            </>
          )}
        </div>
        <div className="nav sidebar-apps" hidden={!items.length}>
          <div className="nav-label">Live apps</div>
          {items.map((item) => (
            <a
              key={item.id}
              className="nav-item"
              {...itemLink(item, me.branding.openMode)}
              title={collapsed ? item.name : undefined}
              aria-current={path === `/open/${item.id}` ? 'page' : undefined}
            >
              <AppIcon app={item} small />
              <span className="nav-text">{item.name}</span>
            </a>
          ))}
        </div>
        <div className="sidebar-foot">
          <div className="user-row">
            <div className="avatar">{me.user.name.charAt(0).toUpperCase()}</div>
            <span className="user-name">{me.user.name}</span>
            <button className="btn ghost small" type="button" title="Sign out" aria-label="Sign out" onClick={signOut}>
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </nav>
      <div
        className="sidebar-resize"
        role="separator"
        tabIndex={0}
        hidden={collapsed}
        title="Resize the sidebar"
        aria-label="Resize the sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        onPointerCancel={handle.onPointerUp}
        {...handle}
      />
    </div>
  );
}
