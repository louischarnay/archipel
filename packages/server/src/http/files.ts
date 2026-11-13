import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

// Resolves a requested path under `root`; null if it leaves it or does not exist.
export function resolveInside(root: string, relative: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const target = resolve(base, `.${sep}${decoded}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return existsSync(target) ? target : null;
}

export function sendFile(reply: FastifyReply, path: string, headers: Record<string, string> = {}) {
  reply.headers({
    'content-type': contentType(path),
    'content-length': statSync(path).size,
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  return reply.send(createReadStream(path));
}

export const readText = (path: string | URL) => readFileSync(path, 'utf8');
