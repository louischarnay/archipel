// Claude Code skill ready to serve: the instructions from `skill/`, and the CLI as a single file in `scripts/`.
// It runs with Node alone, without npm install or a cloned repository.
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const target = new URL('dist/skill/archipel/', root);

rmSync(target, { recursive: true, force: true });
cpSync(new URL('skill/', root), target, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('src/cli.ts', root))],
  outfile: fileURLToPath(new URL('scripts/archipel.mjs', target)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  conditions: ['@archipel/source'],
  define: { ARCHIPEL_CLI_VERSION: JSON.stringify(version) },
  // Ajv and yaml are CommonJS: their `require` calls for Node modules need a real `require` inside an ES module.
  banner: {
    js: "import { createRequire as __archipelRequire } from 'node:module';\nconst require = __archipelRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
