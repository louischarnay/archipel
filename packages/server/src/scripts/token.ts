// Agent token management without the interface, for an administrator with access to the server.
import { parseArgs } from 'node:util';
import { issueAgentToken } from '../auth/agent-tokens.js';
import { loadStorage } from '../config/config.js';
import { openDatabase } from '../database/database.js';
import { Store } from '../database/store.js';

const USAGE = `Usage:
  npm run token -- create <name> [--days 90] [--apps tickets,customers]
  npm run token -- list
  npm run token -- revoke <id>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: 'string' }, apps: { type: 'string' } },
});
const [command, argument] = positionals;

const days = Number(values.days ?? 90);
if (!command || !['create', 'list', 'revoke'].includes(command) || (command !== 'list' && !argument) || !(days > 0)) {
  console.error(USAGE);
  process.exit(2);
}

const apps =
  values.apps
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean) ?? null;

const storage = loadStorage();
const db = await openDatabase(storage);
const store = new Store(db, storage);
try {
  if (command === 'create') {
    const issued = await issueAgentToken(store, { name: argument!, days, apps });
    await store.audit('console', 'agent_token.create', { detail: { id: issued.id, name: argument, days, apps } });
    console.log(JSON.stringify(issued, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(await store.listAgentTokens(), null, 2));
  } else if (await store.revokeAgentToken(argument!)) {
    await store.audit('console', 'agent_token.revoke', { detail: { id: argument } });
  } else {
    console.error(`Token ${argument} not found or already revoked`);
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
