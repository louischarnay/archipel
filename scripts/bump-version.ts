#!/usr/bin/env node
// Bumps the shared platform version: npm run version:bump -- <major|minor|patch|X.Y.Z>.
// Root and workspaces move together, then the lockfile follows.
import { execFileSync } from 'node:child_process';

const level = process.argv[2];
if (!level) {
  console.error('Usage: npm run version:bump -- <major|minor|patch|X.Y.Z>');
  process.exit(1);
}
const npm = (...args: string[]) => execFileSync('npm', args, { stdio: ['ignore', 'ignore', 'inherit'] });
npm('version', level, '--no-git-tag-version', '--workspaces', '--include-workspace-root', '--workspaces-update=false');
npm('install', '--package-lock-only', '--ignore-scripts');
execFileSync('node', ['scripts/check-version.ts'], { stdio: 'inherit' });
