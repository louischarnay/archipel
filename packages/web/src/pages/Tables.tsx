import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { AppTable, AppTables, TableAccess, TableColumn } from '../api/types';
import { AppIcon } from '../components/AppIcon';
import { Async } from '../components/Async';
import { Badge } from '../components/Badge';
import { Icon } from '../components/Icon';
import { EmptyState, PageHead, Segments } from '../components/Layout';
import { plural } from '../lib/format';
import { useLoad } from '../lib/use-load';

type Filter = 'all' | 'shared' | 'private';

interface TableApp {
  id: string;
  name: string;
  hasIcon: boolean;
  access: TableAccess;
}

// One table of the database, with every app that references it.
interface TableEntry extends AppTable {
  apps: TableApp[];
}

const FILTERS: { id: Filter; label: string; accepts: (table: TableEntry) => boolean }[] = [
  { id: 'all', label: 'All', accepts: () => true },
  { id: 'shared', label: 'Shared', accepts: (table) => table.shared },
  { id: 'private', label: 'Private', accepts: (table) => !table.shared },
];

const ACCESS: Record<TableAccess, string> = { owner: 'Owner', read: 'Read', write: 'Read and write' };

const roles = (items: string[]) => items.join(', ') || 'Administrators only';

// `/api/tables` describes tables app by app: the database name gathers the views of one shared table.
function collectTables(apps: AppTables[]) {
  const tables = new Map<string, TableEntry>();
  for (const app of apps) {
    for (const table of app.tables) {
      const entry = tables.get(table.physical) ?? { ...table, apps: [] };
      const exposed = entry.exposed || table.exposed;
      // The owner's view is the full one: its columns, its generated API, its roles.
      if (table.access === 'owner') Object.assign(entry, table);
      entry.exposed = exposed;
      entry.apps.push({ id: app.id, name: app.name, hasIcon: app.hasIcon, access: table.access });
      tables.set(table.physical, entry);
    }
  }
  const isOwner = (app: TableApp) => Number(app.access === 'owner');
  for (const table of tables.values()) table.apps.sort((a, b) => isOwner(b) - isOwner(a));
  return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function ColumnRow({ column }: { column: TableColumn }) {
  return (
    <div className="column-row">
      <span className="mono">{column.name}</span>
      <span className="type">{column.to ? `${column.type} to ${column.to}` : column.type}</span>
      {column.pk && <Badge>Key</Badge>}
      {column.required && <Badge>Required</Badge>}
    </div>
  );
}

function TableItem({ table }: { table: TableEntry }) {
  const owner = table.apps.find((app) => app.access === 'owner');
  return (
    <details className="table-item">
      <summary>
        <Icon name="chevron" />
        <span className="table-name">{table.name}</span>
        {table.shared ? <Badge tone="accent">Shared</Badge> : <Badge>Private</Badge>}
        {table.exposed && <Badge tone="amber">Exposed</Badge>}
        <span className="table-where">{owner?.name ?? 'Owner offline'}</span>
        <span className="table-rows">{table.rows === null ? 'Unknown row count' : plural(table.rows, 'row')}</span>
      </summary>
      <div className="table-detail">
        <div>
          <h3>{table.apps.length > 1 ? `${table.apps.length} apps reference it` : '1 app references it'}</h3>
          <div className="table-apps">
            {table.apps.map((app) => (
              <a className="table-app" key={app.id} href={`#/apps/${app.id}`}>
                <AppIcon app={app} small />
                <span className="name">{app.name}</span>
                <Badge>{ACCESS[app.access]}</Badge>
              </a>
            ))}
          </div>
        </div>
        <dl className="definition">
          <dt>Database name</dt>
          <dd className="mono">{table.physical}</dd>
          {owner && (
            <>
              <dt>Generated API</dt>
              <dd>{table.crud ? 'Yes' : 'No'}</dd>
              <dt>Read</dt>
              <dd>{roles(table.rbac.read)}</dd>
              <dt>Write</dt>
              <dd>{roles(table.rbac.write)}</dd>
            </>
          )}
        </dl>
        {table.columns.length > 0 && (
          <div className="column-list">
            {table.columns.map((column) => (
              <ColumnRow key={column.name} column={column} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function TablesList({ apps }: { apps: AppTables[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const tables = useMemo(() => collectTables(apps), [apps]);
  if (!tables.length) return <EmptyState title="No tables" text="Tables will appear here after the first go-live." />;

  const shown = tables.filter(FILTERS.find((item) => item.id === filter)!.accepts);
  return (
    <>
      <Segments
        label="Filter tables"
        selected={filter}
        onSelect={setFilter}
        tabs={FILTERS.map(({ id, label, accepts }) => ({
          id,
          label: (
            <>
              {label}
              <span className="num">{tables.filter(accepts).length}</span>
            </>
          ),
        }))}
      />
      <p className="section-note tables-legend">
        Shared: available to the apps that declare it in their permissions. Private: reserved for its app. Exposed: flagged by an
        app in its manifest.
      </p>
      {shown.length ? (
        <div className="tables-list">
          {shown.map((table) => (
            <TableItem key={table.physical} table={table} />
          ))}
        </div>
      ) : (
        <EmptyState title="No tables" text="No table matches this filter." />
      )}
    </>
  );
}

// Schema and row counts only: neither a row nor a value is ever shown here.
export function TablesPage() {
  const state = useLoad(() => api<{ apps: AppTables[] }>('/api/tables'), []);
  return (
    <div className="page">
      <PageHead title="Tables" lead="The tables of live apps, without their data." />
      <Async state={state}>{({ apps }) => <TablesList apps={apps} />}</Async>
    </div>
  );
}
