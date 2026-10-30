import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger, shortToken } from '../logger.js';
import { audit, secCount } from '../services/audit.js';
import {
  isMember, loadCollectionFiles, publicFileState, recordCollectionAccess, resolveCollectionShare,
} from '../services/collections.js';
import { recordDownload } from '../services/files.js';
import { limiters } from '../services/rateLimit.js';
import { openFileStream } from '../services/telegram.js';
import { isValidToken } from '../services/tokens.js';
import { makeNameAllocator, zipStream } from '../services/zip.js';
import { CATEGORY_LABELS, extensionOf } from '../utils/category.js';
import { contentDisposition, escapeHtml, formatBytes } from '../utils/format.js';
import { collectionDeepLink } from '../utils/links.js';
import { formatDay } from '../utils/time.js';

const APP = escapeHtml(config.appName);
const TITLE = escapeHtml(config.dashboardTitle);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Only these types are ever served inline (preview). Everything else is always a download, and the
// Content-Type we send comes from this allowlist — never from user-controlled metadata.
const INLINE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf',
};
const previewKind = (type) => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'pdf');

function inlineType(file) {
  const ext = extensionOf(file.name);
  let type = INLINE[ext];
  if (!type && file.type === 'photo') type = 'image/jpeg';
  if (!type && file.type === 'voice') type = 'audio/ogg';
  if (!type && (file.type === 'video_note' || file.type === 'animation')) type = 'video/mp4';
  return type ?? null;
}

const tooBigForWeb = (file) => file.size > config.webDownloadLimitBytes;

// ---------------------------------------------------------------- page

const CSS = `:root{color-scheme:light dark;--bg:#f3f5fb;--card:#fff;--text:#12151d;--muted:#667085;--accent:#2a7fff;--accent2:#6a5cff;--border:#e3e7ef;--ok:#16a34a;--bad:#dc2626;--chip:#eef3ff}
@media(prefers-color-scheme:dark){:root{--bg:#0b0e15;--card:#151a24;--text:#eef1f7;--muted:#98a2b6;--accent:#4b94ff;--accent2:#8579ff;--border:#252c3a;--chip:#1b2335}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
.wrap{max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:.08em;font-size:.82rem;color:var(--muted);margin:6px 2px 14px}
.hero{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-radius:20px;padding:22px 20px;box-shadow:0 12px 34px rgba(42,127,255,.28);animation:rise .5s ease both}
.hero h1{margin:0 0 4px;font-size:1.35rem;line-height:1.25;word-break:break-word}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.stat{background:rgba(255,255,255,.18);border-radius:999px;padding:4px 12px;font-size:.85rem;white-space:nowrap}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.btn{appearance:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:46px;padding:0 18px;border-radius:12px;font:600 .95rem system-ui,sans-serif;text-decoration:none;background:var(--accent);color:#fff;transition:transform .12s,opacity .12s;flex:1 1 140px}
.btn:active{transform:scale(.97)}.btn.alt{background:var(--card);color:var(--accent);border:1px solid var(--border)}
.btn.sm{min-height:38px;padding:0 12px;font-size:.85rem;flex:0 0 auto}
.list{display:flex;flex-direction:column;gap:10px}
.file{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:12px;animation:rise .45s ease both}
.ico{flex:0 0 46px;height:46px;border-radius:12px;background:var(--chip);display:flex;align-items:center;justify-content:center;font-size:1.5rem}
.meta{flex:1 1 auto;min-width:0}.name{font-weight:600;word-break:break-word;overflow-wrap:anywhere}
.sub{color:var(--muted);font-size:.82rem}.tag{color:var(--bad)}
.row{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap;justify-content:flex-end}
.empty,.note{background:var(--card);border:1px dashed var(--border);border-radius:16px;padding:22px;text-align:center;color:var(--muted)}
.note{margin-top:14px;font-size:.85rem;text-align:left}
footer{margin:22px 0 4px;text-align:center;color:var(--muted);font-size:.8rem}
footer a{color:var(--muted)}
.toast{position:fixed;left:50%;bottom:max(22px,env(safe-area-inset-bottom));transform:translate(-50%,30px);background:#111827;color:#fff;padding:10px 18px;border-radius:999px;opacity:0;pointer-events:none;transition:.25s;font-size:.9rem;z-index:30}
.toast.on{opacity:1;transform:translate(-50%,0)}
.modal{position:fixed;inset:0;background:rgba(5,8,14,.86);display:none;align-items:center;justify-content:center;padding:14px;z-index:20}
.modal.on{display:flex}.box{width:100%;max-width:900px;max-height:92vh;display:flex;flex-direction:column;gap:10px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;color:#fff;font-weight:600}
.bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage{background:#000;border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:120px}
.stage img,.stage video{max-width:100%;max-height:78vh;display:block}.stage audio{width:100%;margin:26px 0}.stage iframe{width:100%;height:78vh;border:0;background:#fff}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(max-width:520px){.file{flex-wrap:wrap}.row{width:100%;justify-content:stretch}.row .btn{flex:1 1 0}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

const JS = `(()=>{
const $=(s,r=document)=>r.querySelector(s);
const toast=(m)=>{const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('on'),1800)};
const link=location.origin+location.pathname;
const copy=async(text)=>{try{await navigator.clipboard.writeText(text);toast('Link copied')}catch(e){const i=document.createElement('input');i.value=text;document.body.appendChild(i);i.select();try{document.execCommand('copy');toast('Link copied')}catch(_){toast('Press and hold to copy')}i.remove()}};
$('#copy').addEventListener('click',()=>copy(link));
const sh=$('#share');
sh.addEventListener('click',async()=>{if(navigator.share){try{await navigator.share({title:document.title,url:link})}catch(e){}}else copy(link)});
const modal=$('#modal'),stage=$('#stage'),pname=$('#pname'),pdl=$('#pdl');
const close=()=>{modal.classList.remove('on');stage.textContent=''};
$('#pclose').addEventListener('click',close);
modal.addEventListener('click',e=>{if(e.target===modal)close()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
document.querySelectorAll('[data-preview]').forEach(b=>b.addEventListener('click',()=>{
 const kind=b.dataset.preview,src=b.dataset.src;let el;
 if(kind==='image'){el=new Image();el.alt=b.dataset.name;el.src=src}
 else if(kind==='video'||kind==='audio'){el=document.createElement(kind);el.controls=true;el.autoplay=true;el.preload='metadata';el.src=src}
 else{el=document.createElement('iframe');el.src=src;el.title=b.dataset.name}
 stage.textContent='';stage.appendChild(el);pname.textContent=b.dataset.name;pdl.href=b.dataset.dl;modal.classList.add('on')}));
})();`;

function layout(title, body, nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ${APP}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div><div id="toast" class="toast" role="status"></div>
${nonce ? `<script nonce="${nonce}">${JS}</script>` : ''}</body></html>`;
}

const MESSAGES = {
  invalid: ['❌', 'Invalid link', 'This link is not valid. Please check it and try again.', 404],
  not_found: ['🔍', 'Collection not found', 'This collection does not exist or has been deleted.', 404],
  disabled: ['🚫', 'Link disabled', 'The owner has turned this link off.', 403],
  expired: ['⌛', 'Link expired', 'This collection is no longer available.', 410],
};

function sendPageError(res, reason) {
  const [icon, title, text, status] = MESSAGES[reason] ?? MESSAGES.not_found;
  res.status(status).type('html').send(layout(title, `<div class="brand">🔐 ${TITLE}</div><div class="empty"><div style="font-size:2.4rem">${icon}</div><h2 style="margin:.3rem 0;color:var(--text)">${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div><footer>${APP}</footer>`, ''));
}

const iconOf = (cat) => CATEGORY_LABELS[cat]?.icon ?? '📎';

function fileRow(token, f) {
  const base = `/share/${token}/f/${f.ref}`;
  const state = publicFileState(f);
  const sub = [escapeHtml(f.size > 0 ? formatBytes(f.size) : 'Unknown size'), escapeHtml(CATEGORY_LABELS[f.cat]?.label.replace(/s$/, '') ?? 'File')];
  const buttons = [];
  if (state === 'expired') sub.push('<span class="tag">Expired</span>');
  else if (state === 'protected') sub.push('<span class="tag">🔐 Protected</span>');
  else if (tooBigForWeb(f)) {
    sub.push('Large file');
    buttons.push(`<a class="btn sm" href="${escapeHtml(collectionDeepLink(token, f.ref))}" rel="noopener">Open in Telegram</a>`);
  } else {
    const type = inlineType(f);
    if (type) {
      const verb = type.startsWith('audio') || type.startsWith('video') ? '▶ Play' : '👁 Preview';
      buttons.push(`<button class="btn sm alt" type="button" data-preview="${previewKind(type)}" data-src="${base}?inline=1" data-dl="${base}" data-name="${escapeHtml(f.name)}">${verb}</button>`);
      buttons.push(`<a class="btn sm alt" href="${base}?inline=1" target="_blank" rel="noopener">Open</a>`);
    }
    buttons.push(`<a class="btn sm" href="${base}" download>⬇ Download</a>`);
  }
  return `<div class="file"><div class="ico" aria-hidden="true">${iconOf(f.cat)}</div><div class="meta"><div class="name">${escapeHtml(f.name)}</div><div class="sub">${sub.join(' · ')}</div></div><div class="row">${buttons.join('')}</div></div>`;
}

function sharePage({ token, collection, files }, nonce) {
  const downloadable = files.filter((f) => publicFileState(f) === 'ok' && !tooBigForWeb(f));
  const hasZip = downloadable.length > 0;
  const hero = `<div class="hero"><h1>${escapeHtml(collection.title)}</h1><div style="opacity:.85;font-size:.9rem">File collection</div>
<div class="stats"><span class="stat">📁 ${collection.fileCount} file${collection.fileCount === 1 ? '' : 's'}</span><span class="stat">💾 ${escapeHtml(formatBytes(collection.totalSize))}</span><span class="stat">📅 ${escapeHtml(formatDay(collection.createdAt))}</span></div></div>`;
  const actions = `<div class="actions">${hasZip ? `<a class="btn" href="/share/${token}/zip">⬇ Download All</a>` : ''}<button id="copy" class="btn alt" type="button">🔗 Copy Link</button><button id="share" class="btn alt" type="button">📤 Share</button></div>`;
  const list = files.length
    ? `<div class="list">${files.map((f) => fileRow(token, f)).join('')}</div>`
    : '<div class="empty">This collection has no files.</div>';
  const bigCount = files.filter((f) => publicFileState(f) === 'ok' && tooBigForWeb(f)).length;
  const note = bigCount
    ? `<div class="note">ℹ️ ${bigCount} large file${bigCount === 1 ? ' is' : 's are'} over ${formatBytes(config.webDownloadLimitBytes)} and can only be opened in Telegram. They are not part of “Download All”.</div>`
    : '';
  const modal = '<div id="modal" class="modal" role="dialog" aria-modal="true"><div class="box"><div class="bar"><span id="pname"></span><span><a id="pdl" class="btn sm" href="#" download>⬇</a> <button id="pclose" class="btn sm alt" type="button" aria-label="Close">✕</button></span></div><div id="stage" class="stage"></div></div></div>';
  const body = `<div class="brand">🔐 ${TITLE}</div>${hero}${actions}${list}${note}${modal}<footer>Shared securely with ${APP} · <a href="https://t.me/${escapeHtml(config.botUsername)}" rel="noopener">Open the bot</a></footer>`;
  return layout(collection.title, body, nonce);
}

// ---------------------------------------------------------------- helpers

function clientIp(req) { return req.ip || req.socket?.remoteAddress || 'unknown'; }

async function pageGuard(req, res, token) {
  if (!isValidToken(token)) { sendPageError(res, 'invalid'); return null; }
  const resolved = await resolveCollectionShare(token);
  if (!resolved.ok) {
    await secCount('link_denied');
    logger.info('collection page denied', { tokenId: shortToken(token), reason: resolved.reason });
    sendPageError(res, resolved.reason === 'disabled' || resolved.reason === 'expired' ? resolved.reason : resolved.reason === 'invalid' ? 'invalid' : 'not_found');
    return null;
  }
  return resolved;
}

const tooMany = (res, retryAfter) => {
  res.set('Retry-After', String(retryAfter));
  res.status(429).type('text/plain').send(`Too many requests. Try again in ${retryAfter}s.`);
};

// ---------------------------------------------------------------- routes

export function registerShareRoutes(app) {
  app.get('/share/:token', wrap(async (req, res) => {
    const rl = await limiters.sharePage(clientIp(req));
    if (!rl.allowed) return tooMany(res, rl.retryAfter);
    const resolved = await pageGuard(req, res, req.params.token);
    if (!resolved) return;
    const files = await loadCollectionFiles(resolved.collection);
    const nonce = randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.type('html').send(sharePage({ token: req.params.token, collection: resolved.collection, files }, nonce));
  }));

  // One file of a collection. ?inline=1 serves a preview for allowlisted types; everything else is a download.
  app.get('/share/:token/f/:ref', wrap(async (req, res) => {
    const { token, ref } = req.params;
    const rl = await limiters.downloadIp(clientIp(req));
    if (!rl.allowed) return tooMany(res, rl.retryAfter);
    const resolved = await pageGuard(req, res, token);
    if (!resolved) return;
    if (!/^[A-HJKMNP-Z2-9]{6}$/.test(ref)) return sendPageError(res, 'not_found');
    const files = await loadCollectionFiles(resolved.collection);
    const file = files.find((f) => f.ref === ref);
    // The file must belong to THIS collection (checked again against the membership index).
    if (!file || !(await isMember(resolved.collection.id, file.id))) return sendPageError(res, 'not_found');
    if (publicFileState(file) !== 'ok') return sendPageError(res, 'not_found');
    if (tooBigForWeb(file)) return res.redirect(302, collectionDeepLink(token, file.ref));

    let upstream;
    try {
      upstream = await openFileStream(file.fileId, { range: typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : '' });
    } catch (err) {
      logger.error('collection file stream failed', { tokenId: shortToken(token), err });
      return res.status(502).type('text/plain').send('This file is temporarily unavailable.');
    }
    const wantsInline = req.query.inline === '1';
    const type = wantsInline ? inlineType(file) : null;
    res.set({
      'Content-Type': type ?? 'application/octet-stream',
      'Content-Disposition': type ? `inline; filename="preview"; filename*=UTF-8''${encodeURIComponent(file.name)}` : contentDisposition(file.name),
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self'; sandbox; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    });
    if (upstream.status === 206) {
      res.status(206);
      if (upstream.contentRange) res.set('Content-Range', upstream.contentRange);
    }
    if (upstream.length) res.set('Content-Length', String(upstream.length));
    res.on('close', () => { if (!res.writableEnded) upstream.cancel(); });
    upstream.body.on('error', (err) => { logger.warn('collection file stream aborted', { err }); res.destroy(); });
    upstream.body.pipe(res);
    if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) {
      void recordCollectionAccess(token);
      void recordDownload(file.id);
      void audit('collection_download', { actorId: 0, detail: `#${resolved.collection.ref} web ${wantsInline ? 'preview' : 'file'}` });
    }
  }));

  // Download All: the whole collection as one ZIP, streamed (nothing is buffered or written to disk).
  app.get('/share/:token/zip', wrap(async (req, res) => {
    const { token } = req.params;
    const ip = clientIp(req);
    const rl = await limiters.zipIp(ip);
    if (!rl.allowed) return tooMany(res, rl.retryAfter);
    const resolved = await pageGuard(req, res, token);
    if (!resolved) return;
    const files = await loadCollectionFiles(resolved.collection);

    const notes = [];
    const included = [];
    let total = 0;
    for (const f of files) {
      if (publicFileState(f) !== 'ok') { notes.push(`Not included (expired or protected): ${f.name}`); continue; }
      if (tooBigForWeb(f)) { notes.push(`Not included (over ${formatBytes(config.webDownloadLimitBytes)}, open it in Telegram): ${f.name}`); continue; }
      if (total + f.size > config.collections.zipMaxBytes) { notes.push(`Not included (archive size limit reached): ${f.name}`); continue; }
      total += f.size;
      included.push(f);
    }
    if (included.length === 0) return sendPageError(res, 'not_found');

    const alloc = makeNameAllocator();
    const items = included.map((f) => ({
      name: alloc(f.name),
      modified: f.uploadedAt,
      open: async () => {
        const up = await openFileStream(f.fileId);
        const cancels = (res._cancels ??= []);
        cancels.push(up.cancel);
        return up.body;
      },
    }));
    const safeTitle = resolved.collection.title.replace(/[^\p{L}\p{N} _.-]+/gu, '_').trim().slice(0, 60) || 'collection';
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(`${safeTitle}.zip`),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) { aborted = true; for (const c of res._cancels ?? []) c(); } });

    void recordCollectionAccess(token);
    for (const f of included) void recordDownload(f.id);
    void audit('collection_download', { actorId: 0, detail: `#${resolved.collection.ref} web zip ${included.length} files` });

    try {
      for await (const chunk of zipStream(items, { notes })) {
        if (aborted) break;
        if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      }
      if (!aborted) res.end();
    } catch (err) {
      logger.error('zip stream failed', { tokenId: shortToken(token), err });
      res.destroy(); // a truncated archive must look like a failed download, not a finished one
    }
  }));
}

