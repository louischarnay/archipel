// Verifies the audit log chain, for an administrator with access to the server.
import { loadStorage } from '../config/config.js';
import { openDatabase } from '../database/database.js';
import { Store } from '../database/store.js';

const storage = loadStorage();
const db = await openDatabase(storage);
try {
  const result = await new Store(db, storage).verifyAudit();
  console.log(JSON.stringify(result, null, 2));
  if (result.broken) process.exitCode = 1;
} finally {
  await db.destroy();
}
