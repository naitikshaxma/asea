type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Mask sensitive keys
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'secret',
  'cookie',
  'key',
  'apikey',
  'api_key',
]);

function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Mask potential credentials in URLs like postgresql://user:pass@host
    return obj.replace(/(:\/\/[^:]+:)[^@]+(@)/g, '$1***$2');
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '***REDACTED***';
    } else {
      sanitized[key] = sanitize(value);
    }
  }
  return sanitized;
}

export class Logger {
  private minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_SEVERITY[level] >= LEVEL_SEVERITY[this.minLevel];
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (!this.shouldLog(level)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...(context ? (sanitize(context) as Record<string, unknown>) : {}),
    };

    const output = JSON.stringify(entry);
    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.write('error', message, context);
  }
}

export const logger = new Logger(
  (process.env['LOG_LEVEL'] as LogLevel) || 'info'
);
