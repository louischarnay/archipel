import { execFile } from 'node:child_process';
import { cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { MANIFEST_FILE } from '@archipel/manifest-schema';
import { extract } from 'tar';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { shareReadOnly } from '../runtime/sandbox/launchers.js';
import type { Config } from '../types.js';

interface Limits {
  extractedBytes: number;
  extractedFiles: number;
}

type Budget = ReturnType<typeof createBudget>;

const run = promisify(execFile);

const MEGABYTE = 1024 * 1024;
const DEFAULT_LIMITS = { extractedBytes: 200 * MEGABYTE, extractedFiles: 5000 };
// A JSON or an SVG compresses well, but not beyond this: used to refuse a bomb before writing it.
const MAX_ZIP_RATIO = 200;
const RATIO_APPLIES_FROM = MEGABYTE;

export class IntakeError extends Error {}

// Caps shared by the whole archive: a bomb is often spread over many files.
function createBudget({ extractedBytes, extractedFiles }: Limits) {
  let bytes = 0;
  let files = 0;
  const tooLarge = () => new IntakeError(`Archive too large once extracted (limit ${extractedBytes / MEGABYTE} MB).`);
  return {
    addFile() {
      files += 1;
      if (files > extractedFiles) throw new IntakeError(`Archive has too many files (limit ${extractedFiles} files).`);
    },
    addBytes(count: number) {
      bytes += count;
      if (bytes > extractedBytes) throw tooLarge();
    },
    meter() {
      return new Transform({
        transform: (chunk: Buffer, encoding, done) => {
          try {
            this.addBytes(chunk.length);
            done(null, chunk);
          } catch (error) {
            done(error as Error);
          }
        },
      });
    },
  };
}

const unreadable = (error: Error) =>
  error instanceof IntakeError ? error : new IntakeError(`Unreadable archive: ${error.message}`);

export async function extractArchive(file: string, filename: string, target: string, limits: Limits = DEFAULT_LIMITS) {
  mkdirSync(target, { recursive: true });
  const budget = createBudget(limits);
  if (/\.zip$/i.test(filename)) {
    await extractZip(file, target, budget).catch((error) => {
      throw unreadable(error);
    });
  } else if (/\.(tar\.gz|tgz|tar)$/i.test(filename)) {
    await extractTar(file, filename, target, budget).catch((error) => {
      throw unreadable(error);
    });
  } else {
    throw new IntakeError('Unsupported archive format: use .zip, .tar.gz or .tgz.');
  }
  return locateRoot(target);
}

async function extractTar(file: string, filename: string, target: string, budget: Budget) {
  // Throwing from this filter would escape the stream and bring the process down: note it, then refuse.
  let refused: Error | null = null;
  const unpack = extract({
    cwd: target,
    filter: (path, entry) => {
      const { type } = entry as { type?: string };
      if (type === 'SymbolicLink' || type === 'Link') {
        refused ??= new IntakeError(`The archive contains a symbolic link: ${path}`);
      }
      try {
        budget.addFile();
      } catch (error) {
        refused ??= error as Error;
      }
      return !refused;
    },
  });
  const source = createReadStream(file);
  const metered = budget.meter();
  if (/\.tar$/i.test(filename)) await pipeline(source, metered, unpack as unknown as NodeJS.WritableStream);
  else await pipeline(source, createGunzip(), metered, unpack as unknown as NodeJS.WritableStream);
  if (refused) throw refused;
}

function extractZip(file: string, target: string, budget: Budget) {
  return new Promise<void>((done, fail) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return fail(error);
      const stop = (reason: Error) => {
        zip.close();
        fail(reason);
      };
      zip.on('error', stop);
      zip.on('end', done);
      zip.on('entry', (entry: Entry) => writeZipEntry(zip, entry, target, budget).then(() => zip.readEntry(), stop));
      zip.readEntry();
    });
  });
}

async function writeZipEntry(zip: ZipFile, entry: Entry, target: string, budget: Budget) {
  const output = resolve(target, entry.fileName);
  if (!output.startsWith(resolve(target) + sep)) {
    throw new IntakeError(`Forbidden path in the archive: ${entry.fileName}`);
  }
  if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
    throw new IntakeError(`The archive contains a symbolic link: ${entry.fileName}`);
  }
  if (entry.fileName.endsWith('/')) {
    mkdirSync(output, { recursive: true });
    return;
  }
  budget.addFile();
  const { compressedSize, uncompressedSize } = entry;
  if (uncompressedSize > RATIO_APPLIES_FROM && uncompressedSize / Math.max(compressedSize, 1) > MAX_ZIP_RATIO) {
    throw new IntakeError(`Abnormal compression, archive refused: ${entry.fileName}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const stream = await new Promise<NodeJS.ReadableStream>((done, fail) => {
    zip.openReadStream(entry, (error, opened) => (error ? fail(error) : done(opened)));
  });
  await pipeline(stream, budget.meter(), createWriteStream(output));
}

export async function cloneRepository(
  url: string,
  ref: string | null,
  target: string,
  config: Pick<Config, 'gitProtocols' | 'limits'>,
) {
  if (typeof url !== 'string' || url.startsWith('-')) throw new IntakeError('Invalid Git URL.');
  const args = ['clone', '--depth', '1', '--no-tags', '--single-branch'];
  if (ref) {
    if (ref.startsWith('-')) throw new IntakeError('Invalid Git reference.');
    args.push('--branch', ref);
  }
  args.push('--', url, target);
  try {
    await run('git', args, {
      timeout: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // The repository is foreign: neither the account's nor the machine's configuration applies.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: config.gitProtocols,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch (failure) {
    const error = failure as Error & { stderr?: string };
    throw new IntakeError(`Clone failed: ${error.stderr?.trim() || error.message}`);
  }
  const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: target });
  rmSync(join(target, '.git'), { recursive: true, force: true });
  checkTree(target, createBudget(config.limits));
  return { root: locateRoot(target), commit: stdout.trim() };
}

function checkTree(dir: string, budget: Budget) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new IntakeError(`The repository contains a symbolic link: ${name}`);
    if (stat.isDirectory()) {
      checkTree(path, budget);
    } else {
      budget.addFile();
      budget.addBytes(stat.size);
    }
  }
}

// Also accepts an archive whose whole content sits in a single root folder.
function locateRoot(dir: string) {
  if (existsSync(join(dir, MANIFEST_FILE))) return dir;
  const entries = readdirSync(dir).filter((name) => !name.startsWith('.') && name !== '__MACOSX');
  if (entries.length === 1 && lstatSync(join(dir, entries[0]!)).isDirectory()) {
    const nested = join(dir, entries[0]!);
    if (existsSync(join(nested, MANIFEST_FILE))) return nested;
  }
  throw new IntakeError(`No ${MANIFEST_FILE} at the root of the app.`);
}

export function moveInto(root: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(root, target, { recursive: true });
  shareReadOnly(target);
}
