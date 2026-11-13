import type { ExternalLink, Launchpad, LaunchpadApp, OpenMode } from '../api/types';

// An entry of the launchpad: a live app, or an external link with its fetched logo.
export type LaunchpadItem = (LaunchpadApp & { url?: undefined; iconUrl?: undefined }) | (ExternalLink & { iconUrl: string });

export const launchpadItems = ({ apps, links }: Pick<Launchpad, 'apps' | 'links'>): LaunchpadItem[] =>
  [...apps, ...links.map((link) => ({ ...link, iconUrl: `/api/links/${link.id}/icon` }))].sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );

// Opening directly keeps the app's page on its URL, without the launchpad frame.
// An external link always opens separately.
export function itemLink(item: LaunchpadItem, openMode: OpenMode) {
  if (item.url !== undefined) return { href: item.url, target: '_blank', rel: 'noopener noreferrer' };
  return openMode === 'tab' ? { href: `${item.route}/`, target: '_blank', rel: 'noopener' } : { href: `#/open/${item.id}` };
}
