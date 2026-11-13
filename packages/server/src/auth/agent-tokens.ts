import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../database/store.js';

export const hashAgentToken = (token: string) => createHash('sha256').update(token).digest('hex');

// The token is returned only here, once: only its hash stays in the database.
export async function issueAgentToken(
  store: Store,
  { name, days = 90, apps = null }: { name: string; days?: number; apps?: string[] | null },
) {
  const token = `arc_${randomBytes(32).toString('base64url')}`;
  const id = `agt${randomBytes(6).toString('hex')}`;
  const expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
  await store.createAgentToken({ id, name, token_hash: hashAgentToken(token), expires_at, apps });
  return { id, name, token, expires_at, apps };
}
