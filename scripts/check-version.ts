#!/usr/bin/env node
// Checks the platform version: one semver number shared by the root and every workspace.
// With --newer-than <git ref>, it must also be greater than the version at that ref, so that each change ships under its own number.
// Prints the version on success.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const fail = (message: string): never => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const root = read('package.json');
const { version } = root;
if (!SEMVER.test(version)) fail(`package.json version "${version}" is not MAJOR.MINOR.PATCH`);

for (const workspace of root.workspaces) {
  const other = read(`${workspace}/package.json`).version;
  if (other !== version) {
    fail(
      `${workspace}/package.json has version ${other}, the root has ${version}. Bump with: npm run version:bump -- <major|minor|patch>`,
    );
  }
}

const refIndex = process.argv.indexOf('--newer-than');
if (refIndex !== -1) {
  const ref = process.argv[refIndex + 1];
  if (!ref) fail('--newer-than needs a git ref');
  const previous = JSON.parse(execFileSync('git', ['show', `${ref}:package.json`], { encoding: 'utf8' })).version;
  const parts = (value: string): [number, number, number] => {
    const [, major = 0, minor = 0, patch = 0] = (SEMVER.exec(value) ?? []).map(Number);
    return [major, minor, patch];
  };
  const [a, b] = [parts(version), parts(previous)];
  const greater = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (!greater) {
    fail(
      `Version ${version} is not greater than ${previous} on ${ref}. Bump it with: npm run version:bump -- <major|minor|patch>`,
    );
  }
}

console.log(version);
