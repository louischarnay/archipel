import { createContext, useContext } from 'react';
import type { Me } from '../api/types';

// What every page can reach: who is signed in, and the parts of the frame a page may need to refresh or open.
export interface Shell {
  me: Me;
  // After the launchpad settings changed: name, colours and logo are read again.
  refreshBranding: () => Promise<void>;
  // After anything that changes the sidebar: live apps, versions waiting for review.
  refreshNav: () => void;
  navVersion: number;
  // Bumped when an external link is added, so the Apps page lists it without a page change.
  linksVersion: number;
  logoVersion: number;
  openAddApp: () => void;
  openPalette: () => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell is only available inside the launchpad shell');
  return shell;
}
