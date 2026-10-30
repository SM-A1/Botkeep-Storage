// Centralised, validated configuration. Exits with a clear message (never
// printing secret values) if anything required is missing or malformed.

const problems = [];
const read = (name) => (process.env[name] ?? '').trim();

// Maintenance scripts (backup / restore) set VAULT_SCRIPT=redis so that only REDIS_URL is required.
const scriptMode = read('VAULT_SCRIPT'); // '' | 'redis' | 'full'
const skippedInScript = new Set(['BOT_TOKEN', 'STORAGE_CHANNEL_ID', 'BOT_USERNAME']);

function required(name, validate, hint) {
  const value = read(name);
  if (scriptMode === 'redis' && skippedInScript.has(name) && !value) return name === 'BOT_USERNAME' ? 'script' : '';
  if (!value) {
    problems.push(`${name} is required`);
    return '';
  }
  if (validate && !validate(value)) {
    problems.push(`${name} is invalid (${hint})`);
    return '';
  }
  return value;
}

function integer(name, fallback, { min = 0, max = 2_147_483_647 } = {}) {
  const raw = read(name);
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

function flag(name, fallback) {
  const raw = read(name).toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  problems.push(`${name} must be true or false`);
  return fallback;
}

const nodeEnv = read('NODE_ENV') || 'production';
const isProduction = nodeEnv === 'production';

const botToken = required('BOT_TOKEN', (v) => /^\d{6,15}:[A-Za-z0-9_-]{30,}$/.test(v), 'expected the format 123456:ABC-DEF...');

const redisUrl = required(
  'REDIS_URL',
  (v) => {
    try {
      return ['redis:', 'rediss:'].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  },
  'must start with redis:// or rediss://',
);

const storageChannelId = required(
  'STORAGE_CHANNEL_ID',
  (v) => /^-100\d{5,}$/.test(v),
  'private channel IDs look like -1001234567890',
);

const botUsername = required('BOT_USERNAME', (v) => /^@?[A-Za-z0-9_]{5,32}$/.test(v), 'letters, digits and underscores only').replace(/^@/, '');

const adminIds = new Set();
for (const part of read('ADMIN_IDS').split(',').map((s) => s.trim()).filter(Boolean)) {
  if (!/^\d{1,15}$/.test(part) || Number(part) <= 0) {
    problems.push('ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs');
    break;
  }
  adminIds.add(Number(part));
}
if (adminIds.size === 0 && scriptMode !== 'redis' && !problems.some((p) => p.startsWith('ADMIN_IDS'))) {
  problems.push('ADMIN_IDS must contain at least one numeric Telegram user ID');
}

// BASE_URL is optional now: share links are Telegram deep links. Only validated if provided.
let baseUrl = '';
// Railway injects RAILWAY_PUBLIC_DOMAIN once a domain is generated; use it when BASE_URL is not set.
const rawBase = read('BASE_URL') || (read('RAILWAY_PUBLIC_DOMAIN') ? `https://${read('RAILWAY_PUBLIC_DOMAIN')}` : '');
if (rawBase) {
  try {
    const u = new URL(rawBase);
    if (!['http:', 'https:'].includes(u.protocol)) problems.push('BASE_URL must be an http(s) URL');
    else baseUrl = u.origin;
  } catch {
    problems.push('BASE_URL must be a valid URL');
  }
}

const maxFileSizeMb = integer('MAX_FILE_SIZE_MB', 2000, { min: 0, max: 4000 });

const backupChatRaw = read('BACKUP_CHAT_ID');
if (backupChatRaw && !/^-?\d{5,}$/.test(backupChatRaw)) problems.push('BACKUP_CHAT_ID must be a numeric chat/channel ID');
const backupKey = read('BACKUP_ENCRYPTION_KEY');
if (backupKey && backupKey.length < 16) problems.push('BACKUP_ENCRYPTION_KEY must be at least 16 characters');
const dbFingerprint = read('DB_FINGERPRINT');
if (dbFingerprint && !/^[A-Za-z0-9_-]{8,64}$/.test(dbFingerprint)) problems.push('DB_FINGERPRINT looks invalid (copy it from /stats)');

// ---- Force Subscribe (channels are managed from the Admin Panel and stored in Redis) ----
// FORCE_SUB_SEED: optional one-time import, entries separated by ';', fields by '|':
//   @TheRoyalZone|The Royal Zone|📢 Join The Royal Zone|https://t.me/TheRoyalZone
// Only the first field is required. It is applied once (a channel you delete later is never re-created).
const forceSubSeed = [];
for (const entry of read('FORCE_SUB_SEED').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [ref, name, btn, url] = entry.split('|').map((s) => (s ?? '').trim());
  if (!/^(@?[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{5,15})$/.test(ref)) {
    problems.push('FORCE_SUB_SEED entries must start with @username or a -100... chat id');
    break;
  }
  forceSubSeed.push({ ref, name, btn, url });
}

const settings = {
  appName: read('APP_NAME').slice(0, 40) || 'Storage Drop',
  env: nodeEnv,
  isProduction,
  host: '0.0.0.0',
  port: integer('PORT', 3000, { min: 1, max: 65535 }),
  trustProxyHops: integer('TRUST_PROXY_HOPS', 1, { min: 0, max: 5 }),
  botToken,
  botUsername,
  redisUrl,
  storageChannelId,
  adminIds,
  baseUrl,
  // Default lifetime for NEW uploads (users can override it in Settings). 0 = never expires.
  fileTtlSeconds: integer('FILE_TTL_SECONDS', 0, { min: 0, max: 315_360_000 }),
  // Expired files are never deleted from the storage channel or the database. true = the owner can
  // still download / renew / delete them; false = they are locked until the owner renews the expiry.
  expiredOwnerAccess: flag('EXPIRED_OWNER_ACCESS', true),
  dashboardTitle: (read('DASHBOARD_TITLE') || 'FILE VAULT').slice(0, 30),
  developer: {
    name: (read('DEVELOPER_NAME') || 'Sahin').slice(0, 40),
    handle: (read('DEVELOPER_HANDLE') || 'Sahin_09022').replace(/^@/, '').slice(0, 32),
  },
  // ---- data safety (Railway must stay replaceable) ----
  allowEmptyDbInit: flag('ALLOW_EMPTY_DB_INIT', false), // required once, to initialise a brand-new database
  requireExternalDb: flag('REQUIRE_EXTERNAL_DB', false), // refuse to start when REDIS_URL is Railway-hosted
  dbFingerprint, // optional: refuse to start unless the database carries this ID
  backup: {
    intervalHours: integer('BACKUP_INTERVAL_HOURS', 24, { min: 0, max: 720 }), // 0 = disabled
    chatId: backupChatRaw || storageChannelId, // private chat/channel that receives backup files
    encryptionKey: backupKey,
  },
  auditMaxEvents: integer('AUDIT_MAX_EVENTS', 200_000, { min: 1000, max: 5_000_000 }),
  maxLinksPerFile: 50,
  // ---- delivery policy for public links (admins can change it live in Admin Panel -> Settings) ----
  delivery: {
    autoDeleteSeconds: integer('AUTO_DELETE_SECONDS', 600, { min: 0, max: 604_800 }), // delete delivered messages after N s (0 = never)
    forwardLockSeconds: integer('FORWARD_LOCK_SECONDS', 120, { min: 0, max: 86_400 }), // protect_content for N s, then forwarding is allowed (0 = never locked)
  },
  forceSub: {
    // How long a POSITIVE membership result is reused. 0 = ask Telegram on every protected interaction (strictest).
    // A user who leaves a channel is blocked again at the latest after this many seconds.
    cacheSeconds: integer('FORCE_SUB_CACHE_SECONDS', 10, { min: 0, max: 300 }),
    seed: forceSubSeed,
  },
  // ---- file collections (multi-file upload + one share link) ----
  collections: {
    maxFiles: integer('COLLECTION_MAX_FILES', 100, { min: 2, max: 500 }), // files per collection
    batchQuietMs: integer('UPLOAD_BATCH_QUIET_MS', 2500, { min: 500, max: 30_000 }), // pause that ends an upload batch
    batchStaleSeconds: 90, // an unfinished batch older than this is finalized by the sweeper
    titleMax: 60,
    zipMaxBytes: integer('COLLECTION_ZIP_MAX_MB', 1024, { min: 1, max: 3500 }) * 1024 * 1024, // "Download All" cap
  },
  maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
  maxFileSizeMb,
  webDownloadLimitBytes: 20 * 1024 * 1024, // Bot API getFile limit
  filesPerPage: 5,
  limits: {
    uploadsPerMinute: integer('MAX_UPLOADS_PER_MINUTE', 10, { min: 0, max: 10_000 }), // upload batches (a single file is a batch of one)
    uploadFilesPerMinute: integer('MAX_UPLOAD_FILES_PER_MINUTE', 120, { min: 0, max: 10_000 }), // files joining a running batch
    pagesPerMinute: integer('MAX_SHARE_PAGE_VIEWS_PER_MINUTE', 60, { min: 0, max: 10_000 }), // per IP
    zipsPerHour: integer('MAX_ZIP_DOWNLOADS_PER_HOUR', 10, { min: 0, max: 10_000 }), // per IP
    downloadsPerMinute: integer('MAX_DOWNLOADS_PER_MINUTE', 30, { min: 0, max: 10_000 }),
    startsPerMinute: integer('MAX_STARTS_PER_MINUTE', 10, { min: 0, max: 10_000 }),
    adminCommandsPerMinute: integer('MAX_ADMIN_COMMANDS_PER_MINUTE', 20, { min: 0, max: 10_000 }),
    callbacksPerMinute: integer('MAX_CALLBACKS_PER_MINUTE', 60, { min: 0, max: 10_000 }),
    qrPerMinute: integer('MAX_QR_PER_MINUTE', 5, { min: 0, max: 10_000 }),
    searchPerMinute: integer('MAX_SEARCH_PER_MINUTE', 15, { min: 0, max: 10_000 }),
    sharesPerMinute: integer('MAX_SHARE_CREATES_PER_MINUTE', 10, { min: 0, max: 10_000 }),
    textsPerMinute: integer('MAX_TEXT_INPUTS_PER_MINUTE', 40, { min: 0, max: 10_000 }),
    reportsPerHour: integer('MAX_REPORTS_PER_HOUR', 5, { min: 0, max: 10_000 }),
    passwordAttempts: integer('MAX_PASSWORD_ATTEMPTS', 5, { min: 1, max: 100 }), // per user+file per window
    passwordWindowMinutes: integer('PASSWORD_ATTEMPT_WINDOW_MINUTES', 15, { min: 1, max: 1440 }),
  },
};

if (problems.length > 0) {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      msg: 'invalid configuration',
      service: 'telegram-file-share-bot',
      problems,
    })}\n`,
  );
  process.exit(1);
}

export const config = Object.freeze(settings);
export const isAdmin = (userId) => config.adminIds.has(userId);
