import { createHash, hkdfSync } from 'node:crypto';

// One key per use, derived from the secret: a leak of one opens nothing else, and a token cannot change use.
const subkeys = new Map<string, { key: Buffer; kid: string }>();

export function subkey(secret: string, audience: string) {
  const id = `${audience}\0${secret}`;
  if (!subkeys.has(id)) {
    const key = Buffer.from(hkdfSync('sha256', secret, '', `archipel:${audience}`, 32));
    subkeys.set(id, { key, kid: createHash('sha256').update(key).digest('base64url').slice(0, 8) });
  }
  return subkeys.get(id)!;
}
