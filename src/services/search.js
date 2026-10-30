import { config } from '../config.js';
import { redis } from './redis.js';
import { K } from './keys.js';
import { getFiles, parseMeta } from './files.js';
import { resolveUserId } from './users.js';
import { searchWords, queryPrefix } from './indexing.js';
import { categoryFromAlias, extensionOf } from '../utils/category.js';
import { isRef } from '../utils/ids.js';

const MAX_CANDIDATES = 3000;
const DATE_RE = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

export const SEARCH_HELP =
  'Type part of a file name, optionally with filters:\n' +
  '• <code>type:pdf</code> (photo, video, audio, pdf, doc, archive, or an extension like docx)\n' +
  '• <code>date:2026-10</code> · <code>after:2026-09-01</code> · <code>before:2026-10-31</code>\n' +
  '• <code>#ABC123</code> to find a file by its ID';

function dayRange(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : null;
  const d = m[3] ? Number(m[3]) : null;
  if (y < 2015 || y > 2100 || (mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > 31))) return null;
  const from = Date.UTC(y, mo ? mo - 1 : 0, d ?? 1);
  const to = d ? Date.UTC(y, mo - 1, d + 1) - 1 : mo ? Date.UTC(y, mo, 1) - 1 : Date.UTC(y + 1, 0, 1) - 1;
  return Number.isNaN(from) ? null : { from, to };
}

/** Parses "invoice type:pdf date:2026-10 owner:@name" into a structured query. */
export function parseQuery(raw) {
  const q = { words: [], cat: null, ext: null, from: null, to: null, owner: null, ref: null, errors: [], text: String(raw ?? '').trim().slice(0, 120) };
  for (const part of q.text.split(/\s+/).filter(Boolean)) {
    const [, key, value] = /^(type|date|after|before|owner):(.*)$/i.exec(part) ?? [];
    if (key) {
      const k = key.toLowerCase();
      if (!value) { q.errors.push(`Missing value for ${k}:`); continue; }
      if (k === 'type') {
        const cat = categoryFromAlias(value);
        if (cat) q.cat = cat;
        else if (/^[a-z0-9]{1,10}$/i.test(value)) q.ext = value.toLowerCase();
        else q.errors.push('Unknown file type.');
      } else if (k === 'owner') q.owner = value;
      else {
        const r = dayRange(value);
        if (!r) q.errors.push('Dates look like 2026-10-03, 2026-10 or 2026.');
        else if (k === 'date') { q.from = Math.max(q.from ?? 0, r.from); q.to = Math.min(q.to ?? Infinity, r.to); }
        else if (k === 'after') q.from = Math.max(q.from ?? 0, r.from);
        else q.to = Math.min(q.to ?? Infinity, r.to);
      }
    } else if (/^#/.test(part)) {
      const ref = part.slice(1).toUpperCase();
      if (isRef(ref)) q.ref = ref; else q.errors.push('File IDs look like #ABC123.');
    } else {
      q.words.push(...searchWords(part));
    }
  }
  if (q.words.some((w) => Array.from(w).length < 2)) q.errors.push('Use at least 2 letters per word.');
  q.words = [...new Set(q.words)].slice(0, 5);
  if (!q.words.length && !q.cat && !q.ext && q.from === null && q.to === null && !q.ref && !q.owner && !q.errors.length) q.errors.push('Type something to search for.');
  return q;
}

/**
 * Runs a search over one user's files. Everything is indexed:
 *  - no words: ZREVRANGEBYSCORE on the (category) timeline with LIMIT — O(log N + page)
 *  - with words: SINTER of filename-prefix sets, then timeline membership + exact word check.
 * Normal users can only search themselves; admins may add owner:<id|@username>.
 */
export async function runSearch(query, { viewerId, isAdmin = false, page = 1, pageSize = config.filesPerPage }) {
  if (query.errors.length) return { error: 'invalid', message: query.errors[0] };

  let target = viewerId;
  if (query.owner) {
    const id = await resolveUserId(query.owner);
    if (!id) return { error: 'owner_not_found', message: 'No such owner.' };
    if (id !== viewerId && !isAdmin) return { error: 'forbidden', message: 'You can only search your own files.' };
    target = id;
  }

  if (query.ref) {
    const id = await redis.get(K.ref(query.ref));
    const meta = id ? parseMeta(id, await redis.hgetall(K.file(id))) : null;
    const visible = meta && (meta.uploaderId === viewerId || isAdmin) ? [meta] : [];
    return { items: visible, page: 1, totalPages: 1, total: visible.length, target };
  }

  const zkey = query.cat ? K.userCat(target, query.cat) : K.userFiles(target);
  const min = query.from ?? '-inf';
  const max = query.to !== null && Number.isFinite(query.to) ? query.to : '+inf';

  const needWords = query.words.length > 0 || query.ext;
  if (!needWords) {
    const total = await redis.zcount(zkey, min, max);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(1, page), totalPages);
    const ids = total ? await redis.zrevrangebyscore(zkey, max, min, 'LIMIT', (current - 1) * pageSize, pageSize) : [];
    return { items: (await getFiles(ids)).filter(Boolean), page: current, totalPages, total, target };
  }

  const keys = query.words.map((w) => K.search(target, queryPrefix(w)));
  if (query.ext) keys.push(K.search(target, queryPrefix(query.ext)));
  let ids = keys.length === 1 ? await redis.smembers(keys[0]) : await redis.sinter(...keys);
  const truncated = ids.length > MAX_CANDIDATES;
  if (truncated) ids = ids.slice(0, MAX_CANDIDATES);

  let metas = [];
  if (ids.length) {
    const scoring = redis.pipeline();
    for (const id of ids) scoring.zscore(zkey, id);
    const scores = await scoring.exec();
    const inScope = ids.filter((id, i) => {
      const s = scores[i]?.[1];
      return s !== null && s !== undefined && Number(s) >= (query.from ?? -Infinity) && Number(s) <= (Number.isFinite(query.to) ? query.to : Infinity);
    });
    metas = (await getFiles(inScope)).filter(Boolean);
  }
  metas = metas.filter((m) => {
    const nameWords = searchWords(m.name);
    return query.words.every((qw) => nameWords.some((nw) => nw.startsWith(qw))) && (!query.ext || extensionOf(m.name) === query.ext);
  });
  metas.sort((a, b) => b.uploadedAt - a.uploadedAt);

  const total = metas.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return { items: metas.slice((current - 1) * pageSize, current * pageSize), page: current, totalPages, total, truncated, target };
}

// "Last search" per user so result pages can be turned with a short callback (callback_data is 64 bytes max).
export const saveLastSearch = (uid, text) => redis.set(`sq:${uid}`, text, 'EX', 3600);
export const loadLastSearch = (uid) => redis.get(`sq:${uid}`);
