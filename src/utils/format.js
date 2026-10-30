export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export const formatSize = (bytes) => (bytes > 0 ? formatBytes(bytes) : 'Unknown');

export function formatDate(timestampMs) {
  return `${new Date(timestampMs).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function formatDuration(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  if (!d && !h) parts.push(`${s % 60}s`);
  return parts.join(' ');
}

export function truncate(value, max) {
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Strip control/bidi characters and path separators; cap the length while keeping the extension. */
export function sanitizeFilename(input, fallback = 'file') {
  let s = typeof input === 'string' ? input.normalize('NFC') : '';
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.replace(/[\\/:*?"<>|]+/g, '_');
  s = s.replace(/^\.+/, '').trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || fallback;
}

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function describeFileType({ type, mime = '', name = '' }) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 10) : '';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return `${ext.toUpperCase()} archive`;
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF document';
  switch (type) {
    case 'photo': return 'Image';
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    case 'voice': return 'Voice message';
    case 'video_note': return 'Video message';
    case 'animation': return 'Animation';
    default: break;
  }
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  return ext ? `${ext.toUpperCase()} file` : 'File';
}
