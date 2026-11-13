import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { ValidationIssue } from '@archipel/manifest-schema';

const TIMEOUT_MS = 120_000;
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const MAX_ERRORS = 50;

interface Report {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function typeError(line: string): ValidationIssue {
  const match = DIAGNOSTIC.exec(line);
  if (!match) return { path: 'tsconfig.json', message: line, hint: "Fix the app's TypeScript configuration." };
  const [, file, row, column, code, message] = match;
  return {
    path: `${file}:${row}:${column}`,
    message: message!,
    hint: `Type error ${code}: fix the code, or run "archipel types" again if the manifest changed.`,
  };
}

// A TypeScript app is recognised by its tsconfig.json. The compiler is the app's own, resolved from its folder.
export function checkTypes(root: string): Report {
  if (!existsSync(join(root, 'tsconfig.json'))) return { errors: [], warnings: [] };
  let compiler: string;
  try {
    compiler = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    const hint = "Install typescript in the app's folder so that validate can check the types.";
    return { errors: [], warnings: [{ path: 'tsconfig.json', message: 'Types not checked: TypeScript not found', hint }] };
  }
  const { status, stdout, error } = spawnSync(process.execPath, [compiler, '--noEmit', '--pretty', 'false', '-p', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  if (error) {
    return {
      errors: [{ path: 'tsconfig.json', message: `tsc did not complete: ${error.message}`, hint: 'Run the validation again.' }],
      warnings: [],
    };
  }
  if (status === 0) return { errors: [], warnings: [] };
  const lines = stdout.split('\n').filter((line) => line && !line.startsWith(' '));
  return { errors: lines.slice(0, MAX_ERRORS).map(typeError), warnings: [] };
}
