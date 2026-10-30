// Dependency-free structured (JSON) logger with secret redaction.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const TOKEN_RE = /\d{6,15}:[A-Za-z0-9_-]{30,}/g; // Telegram bot tokens
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"]*@/gi; // scheme://user:pass@host

function redact(text) {
  return text.replace(TOKEN_RE, '[REDACTED_TOKEN]').replace(URL_CREDENTIALS_RE, '$1[REDACTED]@');
}

function serializeError(err) {
  if (!(err instanceof Error)) return { message: String(err) };
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    telegramCode: err.error_code,
    stack: err.stack,
  };
}

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { time: new Date().toISOString(), level, msg, service: 'telegram-file-share-bot' };
  for (const [key, value] of Object.entries(fields ?? {})) {
    entry[key] = value instanceof Error ? serializeError(value) : value;
  }
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ time: entry.time, level, msg, note: 'fields were not serialisable' });
  }
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${redact(line)}\n`);
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

/** Short, non-reversible-enough identifier for log lines (never log full share tokens). */
export const shortToken = (token) => String(token).slice(0, 6);
