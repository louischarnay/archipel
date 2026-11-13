import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG } from '../config/tokens.js';
import type { Config, User } from '../types.js';
import type { IssuerSettings } from './oidc.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DRAFT_TTL_MS = 15 * 60_000;

export interface Draft {
  settings: IssuerSettings;
  result: { user: User; error?: undefined } | { user?: undefined; error: string } | null;
  expires: number;
}

// 15 characters over 31 symbols, about 74 bits: out of reach of an online guess.
function generateCode() {
  const groups = Array.from({ length: 3 }, () =>
    Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''),
  );
  return groups.join('-');
}

// Without an OIDC provider, nothing identifies the person installing: only the code shown
// in the server logs proves they have access to it. It dies with setup mode.
@Injectable()
export class Setup {
  readonly code: string | null;
  private readonly drafts = new Map<string, Draft>();

  constructor(@Inject(CONFIG) config: Pick<Config, 'auth'>) {
    this.code = config.auth.mode === 'setup' ? generateCode() : null;
  }

  private purge() {
    for (const [id, draft] of this.drafts) {
      if (draft.expires < Date.now()) this.drafts.delete(id);
    }
  }

  checkCode(given: unknown) {
    if (!this.code || typeof given !== 'string') return false;
    const expected = Buffer.from(this.code);
    const actual = Buffer.from(given.trim().toUpperCase());
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // A provider under test stays in memory: nothing is activated before a successful round trip.
  createDraft(settings: IssuerSettings) {
    this.purge();
    const id = randomBytes(16).toString('hex');
    this.drafts.set(id, { settings, result: null, expires: Date.now() + DRAFT_TTL_MS });
    return id;
  }

  draft(id: string | undefined) {
    this.purge();
    return (id !== undefined && this.drafts.get(id)) || null;
  }

  forget(id: string) {
    this.drafts.delete(id);
  }
}
