import { env } from '../config/env.js';

type Level = 'error' | 'warn' | 'info' | 'debug';

const levelRank: Record<string, number> = {
  silent: 0,
  fatal: 1,
  error: 2,
  warn: 3,
  info: 4,
  debug: 5,
  trace: 6,
};

const threshold = levelRank[env.LOG_LEVEL] ?? 4;

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if ((levelRank[level] ?? 4) > threshold) return;
  const line = {
    level,
    time: new Date().toISOString(),
    msg: message,
    ...(context ?? {}),
  };
  const serialized = JSON.stringify(line, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
  if (level === 'error' || level === 'warn') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function make(base: Record<string, unknown>): Logger {
  return {
    error: (message, context) => emit('error', message, { ...base, ...context }),
    warn: (message, context) => emit('warn', message, { ...base, ...context }),
    info: (message, context) => emit('info', message, { ...base, ...context }),
    debug: (message, context) => emit('debug', message, { ...base, ...context }),
    child: (context) => make({ ...base, ...context }),
  };
}

export const logger = make({});
