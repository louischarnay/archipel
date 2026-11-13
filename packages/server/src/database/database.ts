import { chmodSync, existsSync } from 'node:fs';
import knex, { type Knex } from 'knex';

// Injection token for the open Knex connection.
export const DATABASE = Symbol('archipel.database');

// Data abstraction layer: everything goes through Knex, the driver is chosen by configuration
// (DB_CLIENT / DB_URL). SQLite stays the default to remain lightweight.
export async function openDatabase(config: { db: { client: string; connection: string } }) {
  const sqlite = config.db.client === 'better-sqlite3';
  const db = knex({
    client: config.db.client,
    connection: sqlite ? { filename: config.db.connection } : config.db.connection,
    useNullAsDefault: sqlite,
    pool: sqlite ? { min: 1, max: 1 } : undefined,
  });
  await migratePlatform(db);
  if (sqlite) {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${config.db.connection}${suffix}`;
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
  return db;
}

async function migratePlatform(db: Knex) {
  const create = async (name: string, build: (table: Knex.CreateTableBuilder) => void) => {
    if (!(await db.schema.hasTable(name))) await db.schema.createTable(name, build);
  };

  await create('platform_groups', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
  });

  await create('platform_apps', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('group_id');
    t.string('status').notNullable().defaultTo('pending'); // pending | live | disabled | uninstalled
    t.string('live_release_id');
    t.text('applied_tables').notNullable().defaultTo('{}'); // schema actually applied in the database
    t.timestamp('created_at').notNullable();
  });

  await create('platform_releases', (t) => {
    t.string('id').primary();
    t.string('app_id').index();
    t.string('version');
    t.string('status').notNullable(); // processing | failed | in_review | changes_requested | rejected | live | superseded
    t.string('stage');
    t.string('source_type').notNullable(); // archive | git
    t.string('source_label').notNullable();
    t.string('submitted_by').notNullable();
    t.text('manifest');
    t.text('report').notNullable().defaultTo('{}');
    t.timestamp('created_at').notNullable();
    t.timestamp('decided_at');
    t.string('decided_by');
    t.text('decision_comment');
  });

  if (!(await db.schema.hasColumn('platform_releases', 'submitted_token'))) {
    await db.schema.alterTable('platform_releases', (t) => void t.string('submitted_token'));
  }

  await create('platform_agent_tokens', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('token_hash').notNullable().unique(); // the token itself is never stored
    t.timestamp('created_at').notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('revoked_at');
  });

  await create('platform_sessions', (t) => {
    t.string('id').primary();
    t.string('token_hash').notNullable().unique(); // the cookie itself is never stored
    t.text('user').notNullable();
    t.timestamp('created_at').notNullable();
    t.timestamp('last_seen_at').notNullable();
    t.timestamp('expires_at').notNullable().index();
    t.timestamp('auth_time').notNullable();
    t.timestamp('revoked_at');
    t.string('ip');
    t.string('user_agent');
  });

  await create('platform_logs', (t) => {
    t.increments('id');
    t.string('release_id').notNullable().index();
    t.string('level').notNullable();
    t.text('message').notNullable();
    t.timestamp('at').notNullable();
  });

  await create('platform_audit', (t) => {
    t.increments('id');
    t.timestamp('at').notNullable();
    t.string('actor').notNullable();
    t.string('action').notNullable();
    t.string('app_id').index();
    t.string('release_id');
    t.text('detail');
  });

  const addColumns = async (table: string, build: { first: string; add: (table: Knex.AlterTableBuilder) => void }) => {
    if (!(await db.schema.hasColumn(table, build.first))) await db.schema.alterTable(table, build.add);
  };

  await addColumns('platform_audit', {
    first: 'hash',
    add: (t) => {
      t.string('hash');
      t.string('actor_type');
      t.string('actor_id');
      t.string('ip');
      t.string('request_id');
    },
  });

  await addColumns('platform_agent_tokens', {
    first: 'apps',
    add: (t) => {
      t.text('apps'); // null: all apps
      t.timestamp('last_used_at');
    },
  });

  await create('platform_alerts', (t) => {
    t.increments('id');
    t.timestamp('at').notNullable();
    t.string('app_id').notNullable();
    t.string('release_id');
    t.text('message').notNullable();
    t.timestamp('acknowledged_at');
    t.string('acknowledged_by');
  });

  await addColumns('platform_alerts', {
    first: 'kind',
    add: (t) => {
      t.string('kind'); // `rollback_request`: already described by an activity line
    },
  });

  await create('platform_links', (t) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.text('url').notNullable();
    t.string('group_id');
    t.binary('icon');
    t.string('icon_type');
    t.timestamp('created_at').notNullable();
    t.string('created_by').notNullable();
  });
}
