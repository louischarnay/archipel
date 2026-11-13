import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { isAllowed, parseRule, type Manifest } from '@archipel/manifest-schema';

interface Rule {
  id: string;
  title: string;
  hint?: string;
}

interface PatternRule extends Rule {
  severity: Severity;
  pattern: RegExp;
}

type Severity = 'block' | 'warn';

export interface Finding extends Rule {
  severity: Severity;
  hint: string | undefined;
  file: string;
  line: number | undefined;
}

export interface ScanReport {
  findings: Finding[];
  files: { path: string; size: number }[];
  blocked: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.json',
  '.html',
  '.htm',
  '.css',
  '.yaml',
  '.yml',
  '.env',
  '.txt',
  '.md',
  '.svg',
]);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

// `block` prevents the app from starting at all, `warn` is shown to the reviewer.
const SECRET_RULES = [
  { id: 'secret.private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, title: 'Private key in the code' },
  { id: 'secret.aws', pattern: /\bAKIA[0-9A-Z]{16}\b/, title: 'AWS key in the code' },
  { id: 'secret.github', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, title: 'GitHub token in the code' },
  { id: 'secret.api_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, title: 'API key in the code' },
  {
    id: 'secret.assignment',
    pattern: /(?:password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    title: 'Probable hard-coded secret',
  },
];

const SERVER_RULES: PatternRule[] = [
  {
    id: 'exec.child_process',
    severity: 'block',
    pattern: /['"`](?:node:)?child_process['"`]/,
    title: 'System command execution',
    hint: 'Controllers do not start processes: go through the SDK.',
  },
  {
    id: 'fs.direct',
    severity: 'block',
    pattern: /['"`](?:node:)?fs(?:\/promises)?['"`]/,
    title: 'Direct file system access',
    hint: 'Controllers depend only on the SDK (ctx).',
  },
  {
    id: 'net.raw',
    severity: 'block',
    pattern: /['"`](?:node:)?(?:net|tls|dgram|dns|http|http2|https|inspector|worker_threads|vm|cluster|module|repl|v8|wasi)['"`]/,
    title: 'Forbidden system module',
    hint: 'Use ctx.fetch, limited to permissions.network.',
  },
  {
    id: 'exec.dynamic',
    severity: 'block',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\b(?:import|require)\s*\(\s*(?!(['"`])[^'"`$+]*\1\s*[,)])/,
    title: 'Dynamic code',
    hint: 'Remove eval, new Function and computed imports.',
  },
  {
    id: 'env.read',
    severity: 'block',
    pattern:
      /\bprocess\s*(?:\.\s*|\[\s*['"`])(?:env|binding|_linkedBinding|dlopen|mainModule|getBuiltinModule)\b|\bprocess\s*\[(?!\s*['"`])/,
    title: 'Access to process internals',
    hint: "Controllers have no access to the host's environment.",
  },
  {
    id: 'net.websocket',
    severity: 'block',
    pattern: /\bnew\s+WebSocket\b|\bglobalThis\s*\[/,
    title: 'Network outside ctx.fetch',
    hint: 'Use ctx.fetch, limited to permissions.network.',
  },
  {
    id: 'deps.import',
    severity: 'warn',
    pattern: /(?:^|\n)\s*import\s(?!type\s)[^'"]*['"](?![./])(?!node:)[^'"]+['"]/,
    title: 'External dependency imported',
    hint: 'No npm install is run: this import will fail at runtime.',
  },
];

const FRONTEND_RULES: PatternRule[] = [
  {
    id: 'frontend.remote_script',
    severity: 'warn',
    pattern: /<script[^>]+src=["']https?:\/\//i,
    title: 'Script loaded from an external domain',
    hint: 'The domain must be listed in permissions.network.',
  },
];

function* walk(dir: string): Generator<{ path: string; size: number }> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) yield* walk(path);
    } else {
      yield { path, size: stat.size };
    }
  }
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

// First-level review by patterns: it catches the usual cases in generated code,
// it does not prove that code written to get around it is harmless. The barrier is isolation at runtime.
export function scanRelease(root: string, manifest: Manifest): ScanReport {
  const findings: Finding[] = [];
  const add = (rule: Rule, severity: Severity, file: string, line?: number) =>
    findings.push({ id: rule.id, severity, title: rule.title, hint: rule.hint, file, line });
  const controllerFiles = new Set((manifest.controllers ?? []).map((c) => relative(root, join(root, c.handler))));
  const frontendDir = manifest.frontend?.dir ? relative(root, join(root, manifest.frontend.dir)) : null;
  const inFrontend = (file: string) => frontendDir !== null && Boolean(frontendDir) && file.startsWith(frontendDir + sep);
  const allowedHosts = manifest.permissions?.network ?? [];
  const hostsSeen = new Map<string, { file: string; line: number }>();
  const files: ScanReport['files'] = [];

  for (const { path, size } of walk(root)) {
    const file = relative(root, path);
    files.push({ path: file, size });
    const extension = extname(file).toLowerCase();
    const base = file.split('/').pop()!;
    if (base === '.env' || base.startsWith('.env.')) {
      add(
        {
          id: 'secret.env_file',
          title: '.env file in the archive',
          hint: 'Remove it: secrets are not shipped with the app.',
        },
        'block',
        file,
      );
    }
    if (!TEXT_EXTENSIONS.has(extension) || size > MAX_SCANNED_BYTES) continue;
    const text = readFileSync(path, 'utf8');

    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(text);
      if (match) add({ ...rule, hint: 'Remove this secret and revoke it.' }, 'block', file, lineOf(text, match.index));
    }
    // A controller can import any file of the app, including a frontend bundle.
    // Those bundles often contain these patterns legitimately: they are reported without blocking.
    if (SCRIPT_EXTENSIONS.has(extension)) {
      const bundled = inFrontend(file) && !controllerFiles.has(file);
      for (const rule of SERVER_RULES) {
        const match = rule.pattern.exec(text);
        if (match) add(rule, bundled ? 'warn' : rule.severity, file, lineOf(text, match.index));
      }
    }
    if (['.html', '.htm'].includes(extension)) {
      for (const rule of FRONTEND_RULES) {
        const match = rule.pattern.exec(text);
        if (match) add(rule, rule.severity, file, lineOf(text, match.index));
      }
    }
    if (SCRIPT_EXTENSIONS.has(extension) || ['.html', '.htm'].includes(extension)) {
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
        const host = match[1]!.toLowerCase();
        if (!hostsSeen.has(host) && !isAllowed(host, allowedHosts)) {
          hostsSeen.set(host, { file, line: lineOf(text, match.index) });
        }
      }
    }
  }

  for (const [host, where] of hostsSeen) {
    if (host === 'www.w3.org') continue;
    add(
      {
        id: 'network.undeclared',
        title: `Undeclared domain: ${host}`,
        hint: `Add ${host} to permissions.network if it is really called.`,
      },
      'warn',
      where.file,
      where.line,
    );
  }

  for (const rule of allowedHosts.filter((item) => parseRule(item).internal)) {
    add(
      {
        id: 'network.internal',
        title: `Access to an internal service: ${parseRule(rule).host}`,
        hint: 'This rule allows http and private addresses: check that the app needs it.',
      },
      'warn',
      'app.manifest.yaml',
    );
  }

  return { findings, files, blocked: findings.some((finding) => finding.severity === 'block') };
}
