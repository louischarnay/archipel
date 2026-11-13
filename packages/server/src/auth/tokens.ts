import { createHmac, timingSafeEqual } from 'node:crypto';
import { subkey } from '../config/keys.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// Signed tokens the platform issues to itself: login state, setup session, app tokens.
// `secrets`: the first key signs, the next ones stay accepted during a rotation.
export function sign(payload: object, secrets: string | string[], audience: string, ttlSeconds: number) {
  const { key, kid } = subkey([secrets].flat()[0]!, audience);
  const body = encode({ ...payload, aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${kid}.${body}.${mac}`;
}

export function verify<T extends object>(
  token: unknown,
  secrets: string | string[],
  audience: string,
): (T & { aud: string; exp: number }) | null {
  if (typeof token !== 'string') return null;
  const [kid, body, mac] = token.split('.');
  if (!kid || !body || !mac) return null;
  const known = [secrets]
    .flat()
    .map((secret) => subkey(secret, audience))
    .find((item) => item.kid === kid);
  if (!known) return null;
  const expected = createHmac('sha256', known.key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { aud: string; exp: number };
  if (payload.aud !== audience || payload.exp < Date.now() / 1000) return null;
  return payload;
}
