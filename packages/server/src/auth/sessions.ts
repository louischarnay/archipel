import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Store } from '../database/store.js';
import type { Session, SessionRecord, User } from '../types.js';

export const SESSION_TTL_S = 8 * 3600;
const IDLE_MS = 3600_000;
const CACHE_MS = 5000;
const TOUCH_EVERY_MS = 60_000;
const MAX_USER_AGENT = 200;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const ms = (value: string) => new Date(value).getTime();

const alive = (session: SessionRecord | undefined): session is SessionRecord =>
  session !== undefined &&
  !session.revoked_at &&
  ms(session.expires_at) > Date.now() &&
  Date.now() - ms(session.last_seen_at) < IDLE_MS;

interface SessionOrigin {
  authTime?: number | undefined;
  ip?: string | null;
  userAgent?: string | null;
}

// Server-side sessions: signing out or revoking takes effect at once, including on app tokens.
// Only the cookie's hash is stored: the database does not let anyone impersonate someone.
@Injectable()
export class Sessions {
  private readonly cache = new Map<string, { session: SessionRecord | undefined; at: number }>();

  constructor(private readonly store: Store) {}

  private async lookup(key: string, read: () => Promise<SessionRecord | undefined>) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.session;
    const session = await read();
    this.cache.set(key, { session, at: Date.now() });
    return session;
  }

  async open(user: User, { authTime = Date.now(), ip = null, userAgent = null }: SessionOrigin = {}) {
    const token = randomBytes(32).toString('base64url');
    const at = new Date();
    const session = {
      id: `ses${randomBytes(12).toString('hex')}`,
      token_hash: hash(token),
      user: JSON.stringify(user),
      created_at: at.toISOString(),
      last_seen_at: at.toISOString(),
      expires_at: new Date(at.getTime() + SESSION_TTL_S * 1000).toISOString(),
      auth_time: new Date(authTime).toISOString(),
      ip,
      user_agent: userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    };
    await this.store.purgeSessions();
    await this.store.createSession(session);
    return { id: session.id, token };
  }

  async resolve(token: string): Promise<Session | null> {
    const session = await this.lookup(`token:${hash(token)}`, () => this.store.findSession({ token_hash: hash(token) }));
    if (!alive(session)) return null;
    if (Date.now() - ms(session.last_seen_at) > TOUCH_EVERY_MS) {
      session.last_seen_at = new Date().toISOString();
      await this.store.touchSession(session.id, session.last_seen_at);
    }
    return { id: session.id, user: session.user, authTime: ms(session.auth_time) };
  }

  async isActive(id: unknown) {
    return typeof id === 'string' && alive(await this.lookup(`id:${id}`, () => this.store.findSession({ id })));
  }

  async revoke(id: string) {
    const revoked = await this.store.revokeSession(id);
    this.cache.clear();
    return revoked;
  }

  async list() {
    return (await this.store.listSessions()).filter(alive);
  }
}
