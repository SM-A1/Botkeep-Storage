const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 03 Oct 2026 (UTC) */
export function formatDay(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const pad = (n) => String(n).padStart(2, '0');
/** 03 Oct 2026 14:05 UTC */
export const formatDayTime = (ms) => {
  const d = new Date(ms);
  return `${formatDay(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

/** "6d 23h", "3h 10m", "12m", "soon" */
export function timeLeft(ms, now = Date.now()) {
  const s = Math.floor((ms - now) / 1000);
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** Human text for an absolute expiry timestamp (0 = never). */
export function describeExpiry(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'Never';
  if (expiresAt <= now) return `Expired ${formatDay(expiresAt)}`;
  return `${formatDay(expiresAt)} (in ${timeLeft(expiresAt, now)})`;
}

export const EXPIRY_PRESETS = {
  n: { seconds: 0, label: 'Never' },
  '1h': { seconds: 3600, label: '1 Hour' },
  '1d': { seconds: 86_400, label: '1 Day' },
  '7d': { seconds: 7 * 86_400, label: '7 Days' },
  '30d': { seconds: 30 * 86_400, label: '30 Days' },
};

const MIN_SECONDS = 5 * 60;
const MAX_SECONDS = 365 * 86_400;
const UNIT = { m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86_400, day: 86_400, days: 86_400, w: 604_800, week: 604_800, weeks: 604_800 };

/** "45m", "3h", "2 days", "1w" -> seconds, or null when invalid / out of range (5 minutes - 365 days). */
export function parseDuration(input) {
  const m = /^(\d{1,4})\s*([a-z]{1,7})$/i.exec(String(input ?? '').trim());
  if (!m) return null;
  const unit = UNIT[m[2].toLowerCase()];
  if (!unit) return null;
  const seconds = Number(m[1]) * unit;
  return seconds >= MIN_SECONDS && seconds <= MAX_SECONDS ? seconds : null;
}

export function formatSeconds(seconds) {
  if (!seconds) return 'Never';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  return `${Math.round(seconds / 60)} minutes`;
}
