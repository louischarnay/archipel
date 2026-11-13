import { readFileSync } from 'node:fs';

declare const ARCHIPEL_CLI_VERSION: string | undefined;

// The skill bundle gets its version at build time: it has no package.json next to it.
export const VERSION =
  typeof ARCHIPEL_CLI_VERSION === 'string'
    ? ARCHIPEL_CLI_VERSION
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
