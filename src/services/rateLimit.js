import { config } from '../config.js';
import { logger } from '../logger.js';
import { redis } from './redis.js';

const DEFAULT_WINDOW_SECONDS = 60;
const ALLOW = { allowed: true, remaining: Infinity, retryAfter: 0 };

/**
 * Fixed-window counter, incremented atomically in Redis (Lua).
 * A limit of 0 disables the check. Fails open if Redis is unreachable so a
 * Redis blip does not lock everyone out.
 */
export async function hit(scope, id, limit, windowSeconds = DEFAULT_WINDOW_SECONDS) {
  if (limit <= 0) return ALLOW;
  const safeId = String(id).replace(/[^A-Za-z0-9:._-]/g, '_').slice(0, 64);
  try {
    const [count, ttlMs] = await redis.rateHit(`rl:${scope}:${safeId}`, windowSeconds * 1000);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfter: Math.max(1, Math.ceil(Math.max(ttlMs, 0) / 1000)),
    };
  } catch (err) {
    logger.warn('rate limit check failed; allowing request', { scope, err });
    return ALLOW;
  }
}

const L = config.limits;

export const limiters = {
  uploads: (userId) => hit('upload', userId, L.uploadsPerMinute),
  uploadFiles: (userId) => hit('upload-file', userId, L.uploadFilesPerMinute),
  sharePage: (ip) => hit('share-page', ip, L.pagesPerMinute),
  zipIp: (ip) => hit('zip-ip', ip, L.zipsPerHour, 3600),
  starts: (userId) => hit('start', userId, L.startsPerMinute),
  admin: (userId) => hit('admin', userId, L.adminCommandsPerMinute),
  callbacks: (userId) => hit('callback', userId, L.callbacksPerMinute),
  qr: (userId) => hit('qr', userId, L.qrPerMinute),
  downloadUser: (userId) => hit('dl-user', userId, L.downloadsPerMinute),
  downloadIp: (ip) => hit('dl-ip', ip, L.downloadsPerMinute),
  pageIp: (ip) => hit('page-ip', ip, L.downloadsPerMinute),
  search: (userId) => hit('search', userId, L.searchPerMinute),
  shares: (userId) => hit('share-create', userId, L.sharesPerMinute),
  texts: (userId) => hit('text', userId, L.textsPerMinute),
  fsubVerify: (userId) => hit('fsub-verify', userId, 12), // "Verify All Memberships" taps (each one calls Telegram)
  fsubNotice: (userId) => hit('fsub-notice', userId, 1, 8), // at most one "join required" message per 8 s for non-button updates
  reports: (userId) => hit('report', userId, L.reportsPerHour, 3600),
  // Password guessing: every attempt counts (right or wrong). Per viewer+file, and per viewer overall.
  passwordAttempt: async (viewerId, fileId) => {
    const window = L.passwordWindowMinutes * 60;
    const perFile = await hit('pw-file', `${viewerId}:${String(fileId).slice(0, 16)}`, L.passwordAttempts, window);
    if (!perFile.allowed) return perFile;
    return hit('pw-user', viewerId, L.passwordAttempts * 4, window);
  },
};
