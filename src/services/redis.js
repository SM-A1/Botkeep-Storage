import Redis from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

// Only touch a hash if it still exists, so an expired key is never resurrected without a TTL.
const INCR_DOWNLOADS_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], 'downloads', 1)
end
return -1
`;

const HSET_IF_EXISTS_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return 1
end
return 0
`;

// Atomically claims one download of a share link. Returns the new download count, or a negative code:
// -1 missing, -2 revoked/inactive, -3 expired, -4 download limit reached.
const CONSUME_SHARE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if redis.call('HGET', KEYS[1], 'status') ~= 'active' then return -2 end
local exp = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0') or 0
if exp > 0 and tonumber(ARGV[1]) >= exp then return -3 end
local limit = tonumber(redis.call('HGET', KEYS[1], 'limit') or '0') or 0
local used = tonumber(redis.call('HGET', KEYS[1], 'downloads') or '0') or 0
if limit > 0 and used >= limit then return -4 end
return redis.call('HINCRBY', KEYS[1], 'downloads', 1)
`;

// Gives a claimed download back when delivery to Telegram failed.
const REFUND_SHARE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 and tonumber(redis.call('HGET', KEYS[1], 'downloads') or '0') > 0 then
  return redis.call('HINCRBY', KEYS[1], 'downloads', -1)
end
return -1
`;

// Adjusts a collection's file count / byte total / updatedAt, but only while the collection still exists
// (a deleted collection must never be resurrected as a stray hash). Returns the new file count, or -1.
const COLL_ADJUST_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = redis.call('HINCRBY', KEYS[1], 'fileCount', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'totalSize', ARGV[2])
redis.call('HSET', KEYS[1], 'updatedAt', ARGV[3])
return n
`;

let lastErrorLog = 0;

export const redis = new Redis(config.redisUrl, {
  family: 0, // dual-stack lookup: required for Railway's private network
  lazyConnect: true,
  connectTimeout: 10_000,
  commandTimeout: 5_000,
  maxRetriesPerRequest: 2,
  keepAlive: 10_000,
  enableAutoPipelining: true, // concurrent commands from different users share one network round trip
  retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  reconnectOnError: (err) => (err.message.includes('READONLY') ? 2 : false),
});

redis.defineCommand('rateHit', { numberOfKeys: 1, lua: RATE_LIMIT_LUA });
redis.defineCommand('incrDownloadsIfExists', { numberOfKeys: 1, lua: INCR_DOWNLOADS_LUA });
redis.defineCommand('hsetIfExists', { numberOfKeys: 1, lua: HSET_IF_EXISTS_LUA });
redis.defineCommand('consumeShare', { numberOfKeys: 1, lua: CONSUME_SHARE_LUA });
redis.defineCommand('refundShare', { numberOfKeys: 1, lua: REFUND_SHARE_LUA });
redis.defineCommand('collAdjust', { numberOfKeys: 1, lua: COLL_ADJUST_LUA });

redis.on('ready', () => logger.info('redis ready'));
redis.on('reconnecting', (delayMs) => logger.warn('redis reconnecting', { delayMs }));
redis.on('close', () => logger.warn('redis connection closed'));
redis.on('error', (err) => {
  const now = Date.now();
  if (now - lastErrorLog < 10_000) return; // avoid log floods while Redis is down
  lastErrorLog = now;
  logger.error('redis error', { err });
});

export async function connectRedis(timeoutMs = 15_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out connecting to Redis')), timeoutMs);
  });
  try {
    await Promise.race([redis.connect(), timeout]);
    await redis.ping();
  } finally {
    clearTimeout(timer);
  }
}

export async function closeRedis() {
  try {
    await Promise.race([
      redis.quit(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 3_000).unref()),
    ]);
  } catch {
    redis.disconnect();
  }
}

export async function redisHealth() {
  const started = Date.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  }
}
