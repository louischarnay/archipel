import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Config } from '../../types.js';

export type SandboxChild = ChildProcessWithoutNullStreams & { containerName?: string };

export interface Launcher {
  start(): SandboxChild;
  kill(child: SandboxChild): void;
}

const run = promisify(execFile);
const RUNNER = fileURLToPath(new URL('../../../runner/runner.mjs', import.meta.url));
const CONTAINER_RUNNER = '/runner/runner.mjs';
const CONTAINER_APP = '/app';
const PULL_TIMEOUT_MS = 5 * 60_000;
const ENGINE_TIMEOUT_MS = 10_000;
// The V8 heap must give way before the container limit: the error is then readable in the logs.
const heapMb = (memoryMb: number) => Math.floor(memoryMb * 0.75);
const STDIO = 'pipe';

// Development mode: a separate process, without environment. This is not a barrier against hostile code.
export function processLauncher({ root, limits }: { root: string; limits: Pick<Config['limits'], 'sandboxMemoryMb'> }): Launcher {
  return {
    start() {
      const real = realpathSync(root);
      return spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${real}`,
          `--allow-fs-read=${dirname(RUNNER)}`,
          `--max-old-space-size=${heapMb(limits.sandboxMemoryMb)}`,
          RUNNER,
          real,
        ],
        { env: {}, stdio: STDIO },
      );
    },
    kill: (child) => child.kill('SIGKILL'),
  };
}

export function containerArguments({
  name,
  instance,
  root,
  runner,
  sandbox,
  limits,
}: {
  name: string;
  instance: string;
  root: string;
  runner: string;
  sandbox: Pick<Config['sandbox'], 'cpus' | 'pids' | 'runtime' | 'image'>;
  limits: Pick<Config['limits'], 'sandboxMemoryMb'>;
}) {
  const { sandboxMemoryMb: memory } = limits;
  return [
    'run',
    '--rm',
    '-i',
    '--name',
    name,
    '--label',
    `archipel.instance=${instance}`,
    '--log-driver',
    'none',
    '--network',
    'none',
    '--ipc',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '--memory',
    `${memory}m`,
    '--memory-swap',
    `${memory}m`,
    '--cpus',
    String(sandbox.cpus),
    '--pids-limit',
    String(sandbox.pids),
    '--ulimit',
    'nofile=256:256',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount',
    `type=bind,src=${root},dst=${CONTAINER_APP},readonly`,
    '--mount',
    `type=bind,src=${runner},dst=${dirname(CONTAINER_RUNNER)},readonly`,
    ...(sandbox.runtime ? ['--runtime', sandbox.runtime] : []),
    sandbox.image,
    'node',
    `--max-old-space-size=${heapMb(memory)}`,
    CONTAINER_RUNNER,
    CONTAINER_APP,
  ];
}

const instanceOf = (config: Pick<Config, 'dataDir'>) => createHash('sha256').update(config.dataDir).digest('hex').slice(0, 12);
const runnerDir = (config: Pick<Config, 'dataDir'>) => join(config.dataDir, 'runner');

export function containerLauncher({ key, root, config }: { key: string; root: string; config: Config }): Launcher {
  const { sandbox, limits } = config;
  const instance = instanceOf(config);
  return {
    start() {
      const name = `archipel-${key}-${randomBytes(4).toString('hex')}`;
      const args = containerArguments({
        name,
        instance,
        root: realpathSync(root),
        runner: realpathSync(runnerDir(config)),
        sandbox,
        limits,
      });
      const child: SandboxChild = spawn(sandbox.engine!, args, { stdio: STDIO });
      child.containerName = name;
      return child;
    },
    // Node as PID 1 ignores SIGTERM: only the engine can stop an infinite loop.
    kill(child) {
      child.kill('SIGKILL');
      execFile(sandbox.engine!, ['rm', '-f', child.containerName!], () => {});
    },
  };
}

async function detectEngine(requested: string | null) {
  for (const engine of requested ? [requested] : ['docker', 'podman']) {
    try {
      await run(engine, ['info', '--format', '{{.ServerVersion}}'], { timeout: ENGINE_TIMEOUT_MS });
      return engine;
    } catch {
      // Try the next engine.
    }
  }
  return null;
}

// Refuses to start without isolation: better a stopped platform than generated code in the host process.
export async function prepareSandbox(config: Config) {
  const { sandbox } = config;
  if (sandbox.mode !== 'container') return;
  const engine = await detectEngine(sandbox.engine);
  if (!engine) {
    throw new Error('Isolation impossible: start Docker or Podman. Outside `npm run dev`, app code only runs in a container.');
  }
  sandbox.engine = engine;
  // The engine resolves paths on its side: outside `data/`, the runner would not exist for it if the host is in a container.
  cpSync(dirname(RUNNER), runnerDir(config), { recursive: true });
  shareReadOnly(runnerDir(config));
  await run(engine, ['image', 'inspect', sandbox.image], { timeout: ENGINE_TIMEOUT_MS }).catch(() =>
    run(engine, ['pull', sandbox.image], { timeout: PULL_TIMEOUT_MS }),
  );

  // Orphan containers from an abrupt stop.
  const { stdout } = await run(engine, ['ps', '-aq', '--filter', `label=archipel.instance=${instanceOf(config)}`], {
    timeout: ENGINE_TIMEOUT_MS,
  });
  const orphans = stdout.split('\n').filter(Boolean);
  if (orphans.length) await run(engine, ['rm', '-f', ...orphans], { timeout: ENGINE_TIMEOUT_MS });
}

// The container's account is not the server's: the code must stay readable to it, never writable.
export function shareReadOnly(path: string) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) shareReadOnly(join(path, name));
  } else {
    chmodSync(path, 0o644);
  }
}
