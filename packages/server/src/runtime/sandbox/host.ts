import type { Readable } from 'node:stream';
import type { Config } from '../../types.js';
import { ApiError } from '../crud.js';
import type { Launcher, SandboxChild } from './launchers.js';

type LogLevel = 'info' | 'warn' | 'error';

type Limits = Pick<
  Config['limits'],
  'controllerConcurrency' | 'controllerTimeoutMs' | 'sandboxStartMs' | 'sandboxIdleMs' | 'logsPerMinute' | 'hostCallsPerMinute'
>;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Options {
  launcher: Launcher;
  limits: Limits;
  hostCall(method: string, args: unknown[]): Promise<unknown>;
  log(level: LogLevel, message: string): void;
}

// Messages from the runner: the app's code can write anything to this stream.
interface Frame {
  type?: string;
  id?: number;
  level?: LogLevel;
  message?: unknown;
  method?: string;
  args?: unknown;
  value?: unknown;
  error?: { status?: number; message?: unknown; stack?: unknown } | null;
}

const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const WINDOW_MS = 60_000;

function readFrames(stream: Readable, onFrame: (line: string) => void, onOverflow: () => void) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.length > MAX_FRAME_CHARS) return onOverflow();
      if (line) onFrame(line);
    }
    if (buffer.length > MAX_FRAME_CHARS) onOverflow();
  });
}

// One isolated execution per mounted app, started on the first call and stopped after inactivity.
// Everything that comes out of it is untrusted: size, rate and shape of messages are checked here.
export class Sandbox {
  private readonly launcher: Launcher;
  private readonly limits: Limits;
  private readonly hostCall: Options['hostCall'];
  private readonly log: Options['log'];
  private child: SandboxChild | null = null;
  private readonly calls = new Map<number, PendingCall>();
  private nextId = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private window = { start: 0, hostCalls: 0, logs: 0 };

  constructor({ launcher, limits, hostCall, log }: Options) {
    this.launcher = launcher;
    this.limits = limits;
    this.hostCall = hostCall;
    this.log = log;
  }

  private start() {
    const child = this.launcher.start();
    let stderr = '';
    this.child = child;
    readFrames(
      child.stdout,
      (line) => this.onFrame(child, line),
      () => {
        this.log('error', 'Message too large: execution stopped');
        this.abort(child, new ApiError(500, 'Controller stopped'));
      },
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.abort(child, new ApiError(500, `Controller stopped: ${error.message}`)));
    child.on('close', (code) => {
      if (child === this.child && stderr.trim()) this.log('error', stderr.trim());
      else if (child === this.child && code) this.log('error', `Execution ended with code ${code}`);
      this.abort(child, new ApiError(500, 'Controller stopped'));
    });
  }

  invoke(handler: string, request: unknown) {
    if (this.calls.size >= this.limits.controllerConcurrency) {
      return Promise.reject(new ApiError(429, 'Too many simultaneous calls for this app'));
    }
    const cold = !this.child;
    if (cold) this.start();
    clearTimeout(this.idleTimer);
    const id = ++this.nextId;
    const child = this.child!;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.log('error', `Timeout exceeded (${this.limits.controllerTimeoutMs} ms): ${handler}`);
          this.abort(child, new ApiError(504, `Timeout exceeded for ${handler}`));
        },
        this.limits.controllerTimeoutMs + (cold ? this.limits.sandboxStartMs : 0),
      );
      this.calls.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type: 'invoke', id, handler, request })}\n`);
    }).finally(() => this.armIdle());
  }

  private allowed(kind: 'hostCalls' | 'logs', limit: number) {
    if (Date.now() - this.window.start > WINDOW_MS) this.window = { start: Date.now(), hostCalls: 0, logs: 0 };
    this.window[kind] += 1;
    return this.window[kind] <= limit;
  }

  private onFrame(child: SandboxChild, line: string) {
    let message: Frame | null;
    try {
      message = JSON.parse(line) as Frame | null;
    } catch {
      this.log('warn', 'Unreadable output ignored');
      return;
    }
    if (message?.type === 'log') this.onLog(message);
    else if (message?.type === 'host') this.onHostCall(child, message);
    else if (message?.type === 'result') this.onResult(message);
  }

  private onLog({ level, message }: Frame) {
    if (this.allowed('logs', this.limits.logsPerMinute)) {
      this.log(level && ['info', 'warn', 'error'].includes(level) ? level : 'info', String(message));
    } else if (this.window.logs === this.limits.logsPerMinute + 1) {
      this.log('warn', `Logs limited to ${this.limits.logsPerMinute} per minute: the next ones are ignored`);
    }
  }

  private async onHostCall(child: SandboxChild, { id, method, args }: Frame) {
    if (!this.allowed('hostCalls', this.limits.hostCallsPerMinute)) {
      this.log('error', `More than ${this.limits.hostCallsPerMinute} platform calls per minute: execution stopped`);
      this.abort(child, new ApiError(429, 'Too many platform calls'));
      return;
    }
    let reply: object;
    try {
      reply = { type: 'host-result', id, value: (await this.hostCall(method!, Array.isArray(args) ? args : [])) ?? null };
    } catch (failure) {
      const error = failure as Error & { status?: number };
      reply = { type: 'host-result', id, error: { status: error.status, message: error.message } };
    }
    if (child === this.child) child.stdin.write(`${JSON.stringify(reply)}\n`);
  }

  private onResult({ id, value, error }: Frame) {
    const call = this.calls.get(id!);
    if (!call) return;
    this.calls.delete(id!);
    clearTimeout(call.timer);
    if (error) {
      if (error.stack) this.log('error', String(error.stack));
      const { status: given } = error;
      const status = Number.isInteger(given) && given! >= 400 && given! < 600 ? given! : 500;
      call.reject(new ApiError(status, String(error.message)));
    } else {
      call.resolve(value);
    }
  }

  private abort(child: SandboxChild, error: Error) {
    if (child !== this.child) return;
    this.child = null;
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
    this.launcher.kill(child);
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.calls.size) return;
    this.idleTimer = setTimeout(() => this.stop(), this.limits.sandboxIdleMs);
    this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    if (child) this.launcher.kill(child);
  }
}
