import { api } from '../api/client';
import type { Launchpad } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { Icon } from '../components/Icon';
import { EmptyState, PageHead } from '../components/Layout';
import { useLoad } from '../lib/use-load';
import { useShell } from '../shell/context';
import { itemLink, launchpadItems, type LaunchpadItem } from '../shell/launchpad-items';

interface TileSection {
  title: string | null;
  items: LaunchpadItem[];
}

// One section per app group, then the apps that have none.
function sectionsOf({ groups }: Launchpad, items: LaunchpadItem[], showGroups: boolean): TileSection[] {
  if (!showGroups) return [{ title: null, items }];
  return [
    ...groups.map((group) => ({ title: group.name, items: items.filter((item) => item.group === group.id) })),
    { title: groups.length ? 'Other apps' : null, items: items.filter((item) => !item.group) },
  ].filter((section) => section.items.length);
}

export function LaunchpadPage() {
  const { me, navVersion, openAddApp } = useShell();
  const state = useLoad(() => api<Launchpad>('/api/launchpad'), [navVersion]);
  const { title, welcome, showGroups, openMode } = me.branding;
  const { admin } = me.user;

  return (
    <Async state={state}>
      {(launchpad) => {
        const items = launchpadItems(launchpad);
        return (
          <div className="page">
            <PageHead title={title} lead={welcome} />
            {!items.length && (
              <EmptyState
                title="No live apps"
                text={
                  admin
                    ? 'Add a first app: it will go through review before appearing here.'
                    : 'Apps will appear here as soon as they go live.'
                }
              >
                {admin && (
                  <button className="btn primary" type="button" onClick={openAddApp}>
                    <Icon name="plus" />
                    Add an app
                  </button>
                )}
              </EmptyState>
            )}
            {sectionsOf(launchpad, items, showGroups).map((section) => (
              <section className="group-section" key={section.title ?? ''}>
                {section.title && <div className="group-title">{section.title}</div>}
                <div className="tiles">
                  {section.items.map((item) => (
                    <a className="tile" key={item.id} {...itemLink(item, openMode)}>
                      <AppIcon app={item} />
                      <span className="tile-name">{item.name}</span>
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </div>
        );
      }}
    </Async>
  );
}
