const REDACTED = '[REDACTED]';
const DEFAULT_TEXT_LIMIT_BYTES = 262_144;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const SENSITIVE_ENV_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|COOKIE|AUTHORIZATION|DATABASE_URL|REDIS_URL|GITHUB_APP|ANTHROPIC_API_KEY|OPENAI_API_KEY)/i;
const SENSITIVE_FIELD_NAME = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential|cookie|authorization)/i;
// Settings whose names match SENSITIVE_ENV_NAME but whose values are public,
// and boolean flags: redacting COOKIE_SECURE=false would rewrite every `false`
// in scanner JSON and make a clean scan unparseable.
const NON_SECRET_ENV_NAMES = new Set(['COOKIE_SECURE', 'COOKIE_NAME', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID']);
const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configuredSensitiveValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && !NON_SECRET_ENV_NAMES.has(name.toUpperCase())
      && typeof value === 'string' && value.length >= 4 && !BOOLEAN_VALUE.test(value.trim()))
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
}

function redactText(value: string, outputTruncated: boolean): string {
  let output = value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+)(?:"[^"]*"|'[^']*'|[^\s"'`,;}]+)/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?key|credential|cookie|authorization)\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'`,;}]+)/gi, (_match, prefix: string, rawValue: string) => {
      const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
      return `${prefix}${quote}${REDACTED}${quote}`;
    })
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2');

  for (const secret of configuredSensitiveValues()) {
    output = output.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
    if (!outputTruncated) continue;

    // The byte cap can split a configured value at the end of captured output.
    // Hide a matching suffix prefix rather than persisting the fragment.
    const maximumPrefix = Math.min(secret.length - 1, output.length);
    for (let length = maximumPrefix; length >= 8; length -= 1) {
      const prefix = secret.slice(0, length);
      if (output.endsWith(prefix)) {
        output = `${output.slice(0, -length)}${REDACTED}`;
        break;
      }
    }
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
  return result;
}

/** Redacts known credential formats and configured secret values without logging the values. */
export function redactSensitiveText(value: string, options: { outputTruncated?: boolean; maxBytes?: number } = {}): string {
  const maximum = Math.max(0, Math.min(options.maxBytes ?? DEFAULT_TEXT_LIMIT_BYTES, MAX_OUTPUT_BYTES));
  const initial = redactText(value, options.outputTruncated ?? false);
  const bounded = Buffer.byteLength(initial, 'utf8') > maximum ? redactText(initial, true) : initial;
  return truncateUtf8(bounded, maximum);
}

/** Keeps combined stdout and stderr within the provider's byte budget after redaction expands markers. */
export function redactOutputPair(
  stdout: string,
  stderr: string,
  maxBytes: number,
  outputTruncated: boolean,
): { stdout: string; stderr: string; outputTruncated: boolean } {
  const maximum = Math.max(1024, Math.min(Math.floor(maxBytes), MAX_OUTPUT_BYTES));
  let safeStdout = redactText(stdout, outputTruncated);
  let safeStderr = redactText(stderr, outputTruncated);
  let wasTruncated = outputTruncated;
  const stdoutBytes = Buffer.byteLength(safeStdout, 'utf8');
  const stderrBytes = Buffer.byteLength(safeStderr, 'utf8');
  const totalBytes = stdoutBytes + stderrBytes;

  if (totalBytes > maximum) {
    wasTruncated = true;
    const stdoutBudget = totalBytes === 0 ? 0 : Math.floor(maximum * (stdoutBytes / totalBytes));
    safeStdout = truncateUtf8(safeStdout, stdoutBudget);
    safeStderr = truncateUtf8(safeStderr, maximum - Buffer.byteLength(safeStdout, 'utf8'));
    // Recheck truncation boundaries so a credential prefix cannot be exposed by the final cut.
    safeStdout = truncateUtf8(redactText(safeStdout, true), stdoutBudget);
    safeStderr = truncateUtf8(redactText(safeStderr, true), maximum - Buffer.byteLength(safeStdout, 'utf8'));
  }

  return { stdout: safeStdout, stderr: safeStderr, outputTruncated: wasTruncated };
}

/** Redacts nested execution evidence before database writes and API serialization. */
export function redactSensitiveData<T>(value: T): T {
  if (typeof value === 'string') return redactText(value, false) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item)) as T;
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = typeof item === 'string' && SENSITIVE_FIELD_NAME.test(key)
      ? REDACTED
      : redactSensitiveData(item);
  }
  return output as T;
}
