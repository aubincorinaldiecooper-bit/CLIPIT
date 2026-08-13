import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Cap on retained output per stream, so a chatty tool cannot exhaust memory. */
  maxBufferBytes?: number;
  onStderr?: (chunk: string) => void;
}

export class ProcessError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, signal: NodeJS.Signals | null, stderr: string) {
    const detail = stderr.trim().split('\n').slice(-8).join('\n');
    super(`${command} failed (exit ${exitCode ?? 'null'}${signal ? `, signal ${signal}` : ''})${detail ? `: ${detail}` : ''}`);
    this.name = 'ProcessError';
    this.command = command;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/**
 * Spawns a binary without a shell (no interpolation risk from user-supplied
 * URLs or filenames) and resolves with its output.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = options.maxBufferBytes ?? 4 * 1024 * 1024;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new ProcessError(command, null, 'SIGKILL', `timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs);
      timer.unref?.();
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxBuffer) stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on('error', (error) => {
      finish(() =>
        reject(
          new ProcessError(
            command,
            null,
            null,
            `${(error as NodeJS.ErrnoException).code === 'ENOENT' ? `${command} is not installed or not on PATH` : error.message}`,
          ),
        ),
      );
    });

    child.on('close', (code, signal) => {
      if (code === 0) finish(() => resolve({ stdout, stderr }));
      else finish(() => reject(new ProcessError(command, code, signal, stderr)));
    });
  });
}
