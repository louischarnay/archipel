import { useState } from 'react';
import { api } from '../api/client';
import type { AppSummary, ExternalLink, Group, Launchpad } from '../api/types';
import { ActionButton } from '../components/ActionButton';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { AppStatusBadge, Badge } from '../components/Badge';
import { useConfirm } from '../components/Confirm';
import { Icon } from '../components/Icon';
import { EmptyState, PageHead, Section } from '../components/Layout';
import { useToast } from '../components/Toasts';
import { navigate } from '../lib/router';
import { useLoad } from '../lib/use-load';
import { useShell } from '../shell/context';

const Missing = () => <span className="sub">—</span>;

function AppsTable({ apps }: { apps: AppSummary[] }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {['App', 'Group', 'Version', 'Status', ''].map((title) => (
              <th key={title}>{title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.id} onClick={() => navigate(`/apps/${app.id}`)}>
              <td>
                <div className="title-row">
                  <AppIcon app={app} small />
                  <a href={`#/apps/${app.id}`}>
                    <div>{app.name}</div>
                    <div className="sub mono">{app.id}</div>
                  </a>
                </div>
              </td>
              <td>{app.groupName ?? <Missing />}</td>
              <td className="mono">{app.version ?? <Missing />}</td>
              <td>
                <AppStatusBadge status={app.status} />
              </td>
              <td>
                <div className="chips">
                  {app.inReview > 0 && <Badge tone="amber">To review</Badge>}
                  {app.blocked && <Badge tone="red">Latest version blocked</Badge>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinksSection({ links, groups, onChange }: { links: ExternalLink[]; groups: Group[]; onChange: () => Promise<void> }) {
  const confirm = useConfirm();
  const toast = useToast();
  const groupName = new Map(groups.map((group) => [group.id, group.name]));

  const remove = async (link: ExternalLink) => {
    const ok = await confirm({
      title: `Remove ${link.name}?`,
      text: 'The link will disappear from the launchpad.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await api(`/api/links/${link.id}`, { method: 'DELETE' });
    toast('Link removed');
    await onChange();
  };

  return (
    <Section className="gap-small" title="External links" note="They open in a new tab and are visible to everyone signed in.">
      {links.map((link) => (
        <div className="link-row" key={link.id}>
          <AppIcon app={{ ...link, iconUrl: `/api/links/${link.id}/icon` }} small />
          <a className="body" href={link.url} target="_blank" rel="noopener noreferrer">
            <div className="name">{link.name}</div>
            <div className="sub">{link.url}</div>
          </a>
          {link.group && <Badge>{groupName.get(link.group) ?? link.group}</Badge>}
          <ActionButton className="small danger" onAction={() => remove(link)}>
            Remove
          </ActionButton>
        </div>
      ))}
    </Section>
  );
}

function GroupRow({ group }: { group: Group }) {
  const [name, setName] = useState(group.name);
  const toast = useToast();
  const rename = async () => {
    await api(`/api/groups/${group.id}`, { method: 'PATCH', body: { name } });
    toast('Group renamed');
  };
  return (
    <div className="group-row">
      <input
        type="text"
        value={name}
        aria-label={`Name of group ${group.id}`}
        onChange={(event) => setName(event.target.value)}
      />
      <ActionButton className="small" onAction={rename}>
        Rename
      </ActionButton>
    </div>
  );
}

export function AppsPage() {
  const { openAddApp, refreshNav, linksVersion } = useShell();
  const state = useLoad(async () => {
    const [{ apps, groups }, { links }] = await Promise.all([
      api<{ apps: AppSummary[]; groups: Group[] }>('/api/apps'),
      api<Launchpad>('/api/launchpad'),
    ]);
    return { apps, groups, links };
  }, [linksVersion]);

  const reload = async () => {
    await state.reload();
    refreshNav();
  };

  return (
    <Async state={state}>
      {({ apps, groups, links }) => (
        <div className="page">
          <PageHead title="Apps" lead="All apps deployed on this instance.">
            <button className="btn primary" type="button" onClick={openAddApp}>
              <Icon name="plus" />
              Add an app
            </button>
          </PageHead>
          {apps.length ? (
            <AppsTable apps={apps} />
          ) : (
            <EmptyState title="No apps" text="Drop an archive or a Git link containing an app.manifest.yaml." />
          )}
          {links.length > 0 && <LinksSection links={links} groups={groups} onChange={reload} />}
          {groups.length > 0 && (
            <Section
              className="gap-large"
              title="App groups"
              note="A group organises the launchpad. Permissions stay defined by each app."
            >
              {groups.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
            </Section>
          )}
        </div>
      )}
    </Async>
  );
}
