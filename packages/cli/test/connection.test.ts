import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionFile, forgetConnection, resolveConnection, saveConnection } from '../src/connection.js';

const home = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'archipel-connection-')) });
const saved = { url: 'https://apps.example.com', token: 'arc_saved' };

describe('CLI connection', () => {
  it('saves the token in a file only its account can read', () => {
    const env = home();
    const file = saveConnection(saved, env);
    expect(file).toBe(connectionFile(env));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveConnection(env)).toEqual({ ...saved, source: 'file' });
  });

  it('the environment wins as a whole, without borrowing the token from the file', () => {
    const env = home();
    saveConnection(saved, env);
    expect(resolveConnection({ ...env, ARCHIPEL_URL: 'https://elsewhere.example.com' })).toEqual({
      url: 'https://elsewhere.example.com',
      token: undefined,
      source: 'env',
    });
  });

  it('a missing or unreadable file gives no connection', () => {
    const env = home();
    expect(resolveConnection(env)).toEqual({ source: 'none' });
    saveConnection(saved, env);
    writeFileSync(connectionFile(env), '{ not json');
    expect(resolveConnection(env)).toEqual({ source: 'none' });
  });

  it('logout removes the file, even when it is missing', () => {
    const env = home();
    saveConnection(saved, env);
    forgetConnection(env);
    expect(existsSync(connectionFile(env))).toBe(false);
    expect(() => forgetConnection(env)).not.toThrow();
  });
});
