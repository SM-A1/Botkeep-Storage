import { redis } from './redis.js';

const USERS_KEY = 'users';
const MAINTENANCE_KEY = 'state:maintenance';
const DOWNLOADS_KEY = 'stats:downloads';

export const trackUser = (userId) => redis.sadd(USERS_KEY, String(userId));
export const removeUser = (userId) => redis.srem(USERS_KEY, String(userId));
export const countUsers = () => redis.scard(USERS_KEY);

/** Iterates users in small batches via SSCAN; never loads the full set into memory. */
export async function* iterateUsers() {
  let cursor = '0';
  do {
    const [next, members] = await redis.sscan(USERS_KEY, cursor, 'COUNT', 500);
    cursor = next;
    for (const member of members) yield Number(member);
  } while (cursor !== '0');
}

// Cached for a few seconds: checked on every update, changes rarely.
let maintenanceCache = { value: false, at: 0 };

let maintenanceRefreshing = false;

export async function isMaintenance() {
  const age = Date.now() - maintenanceCache.at;
  if (age < 5_000) return maintenanceCache.value;
  const refresh = async () => {
    const value = (await redis.get(MAINTENANCE_KEY)) === '1';
    maintenanceCache = { value, at: Date.now() };
    return value;
  };
  if (maintenanceCache.at > 0) {
    // Serve the last known value immediately and refresh in the background (stale-while-revalidate).
    if (!maintenanceRefreshing) {
      maintenanceRefreshing = true;
      refresh().catch(() => {}).finally(() => { maintenanceRefreshing = false; });
    }
    return maintenanceCache.value;
  }
  return refresh();
}

export async function setMaintenance(enabled) {
  if (enabled) await redis.set(MAINTENANCE_KEY, '1');
  else await redis.del(MAINTENANCE_KEY);
  maintenanceCache = { value: enabled, at: Date.now() };
}

export const incrementDownloads = () => redis.incr(DOWNLOADS_KEY);

export async function totalDownloads() {
  return Number((await redis.get(DOWNLOADS_KEY)) ?? 0);
}
