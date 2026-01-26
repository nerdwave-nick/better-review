// Centralized logging utility with consistent formatting

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Set to 'debug' during development, 'warn' for production
// In a real build setup, this would come from environment variables
const LOG_LEVEL: LogLevel = 'warn';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

function formatMessage(tag: string, ...args: unknown[]): [string, ...unknown[]] {
  return [`[${tag}]`, ...args];
}

export const logger = {
  debug(tag: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.log(...formatMessage(tag, ...args));
    }
  },

  info(tag: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(...formatMessage(tag, ...args));
    }
  },

  warn(tag: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(...formatMessage(tag, ...args));
    }
  },

  error(tag: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(...formatMessage(tag, ...args));
    }
  },
};

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return fallback;
}
