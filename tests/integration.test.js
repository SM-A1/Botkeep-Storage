// End-to-end tests against a REAL Redis and the real bot handlers (Telegram API calls are intercepted).
//   VAULT_TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test
// The database is FLUSHED at the start of every run: only point this at a throw-away database.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

const TEST_URL = process.env.VAULT_TEST_REDIS_URL;
if (!TEST_URL) {
  console.error('Set VAULT_TEST_REDIS_URL to a throw-away Redis database (it will be flushed).');
  process.exit(1);
}
Object.assign(process.env, {
  BOT_TOKEN: '123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1',
  REDIS_URL: TEST_URL, STORAGE_CHANNEL_ID: '-1001234567890', ADMIN_IDS: '1001', BOT_USERNAME: 'Test_Vault_Bot',
  LOG_LEVEL: 'error', MAX_CALLBACKS_PER_MINUTE: '0', MAX_UPLOADS_PER_MINUTE: '0', MAX_DOWNLOADS_PER_MINUTE: '0',
  MAX_STARTS_PER_MINUTE: '0', MAX_SEARCH_PER_MINUTE: '5', BACKUP_INTERVAL_HOURS: '0', MAX_PASSWORD_ATTEMPTS: '5', UPLOAD_BATCH_QUIET_MS: '600', BASE_URL: 'https://vault.example.com',
});

const { redis, connectRedis } = await import('../src/services/redis.js');
await connectRedis();
await redis.flushdb();
const { bot } = await import('../src/services/telegram.js');
const { registerBot } = await import('../src/bot/index.js');
const schema = await import('../src/services/schema.js');
const files = await import('../src/services/files.js');
const shares = await import('../src/services/shares.js');
const backup = await import('../src/services/backup.js');
const { runSearch, parseQuery } = await import('../src/services/search.js');
const collections = await import('../src/services/collections.js');
const uploadBatch = await import('../src/services/uploadBatch.js');
const zip = await import('../src/services/zip.js');
const autodelete = await import('../src/services/autodelete.js');
const { parseDuration } = await import('../src/utils/time.js');
const { verifyPassword } = await import('../src/services/password.js');

// ---------------------------------------------------------------- fake Telegram
const STORAGE = -1001234567890;
const isStorage = (v) => Number(v) === STORAGE;
const calls = [];
let seq = 1000;
bot.botInfo = { id: 123456, is_bot: true, first_name: 'Vault', username: 'Test_Vault_Bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: { ...payload } });
  const msg = { message_id: ++seq, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' }, text: payload.text };
  if (method === 'copyMessages') return { ok: true, result: payload.message_ids.map(() => ({ message_id: ++seq })) };
  return { ok: true, result: ['answerCallbackQuery', 'deleteMessage', 'deleteMessages', 'sendChatAction'].includes(method) ? true : msg };
});
registerBot(bot);

import { BotError } from 'grammy';
let uid = 0;
let mid = 5000;
async function feed(update) {
  try { await bot.handleUpdate(update); } catch (e) { if (e instanceof BotError) await bot.errorHandler(e); else throw e; }
}
const user = (id) => ({ id, is_bot: false, first_name: `U${id}`, username: `user_${id}` });
async function say(from, text) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await feed({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id: from, type: 'private' }, from: user(from), text, entities } });
}
async function upload(from, name, mime = 'application/pdf', size = 1000) {
  await feed({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id: from, type: 'private' }, from: user(from), document: { file_id: `tgfile_${name}_${mid}`, file_unique_id: `uq_${name}_${mid}`, file_name: name, mime_type: mime, file_size: size } } });
}
async function tap(from, data) {
  await feed({ update_id: ++uid, callback_query: { id: String(++uid), from: user(from), chat_instance: 'c', data, message: { message_id: 777, date: 0, chat: { id: from, type: 'private' }, text: 'x' } } });
}
const mark = () => calls.length;
const since = (n) => calls.slice(n);
const textsTo = (n, chat) => since(n).filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && Number(c.payload.chat_id) === chat).map((c) => c.payload.text);
const lastText = (n, chat) => textsTo(n, chat).at(-1) ?? '';
const buttons = (n, chat) => since(n).filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && Number(c.payload.chat_id) === chat).at(-1)?.payload.reply_markup?.inline_keyboard.flat() ?? [];
const alerts = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery' && c.payload.text).map((c) => c.payload.text);
const delivered = (n, chat) => since(n).filter((c) => c.method === 'copyMessage' && Number(c.payload.chat_id) === chat);
const UNAVAILABLE = '❌ <b>File unavailable</b>\n\nThe link may be expired, revoked, deleted, or invalid.';

const A = 2001; const B = 2002; const ADMIN = 1001; const C = 2003;
let fileA; let linkToken;
const idFromCard = async () => (await files.listFiles(A, { page: 1 })).items[0];

// ---------------------------------------------------------------- tests
describe('database guard & migration', () => {
  test('refuses to create a new database implicitly', async () => {
    await assert.rejects(() => schema.initDatabase(), (e) => e.name === 'DatabaseGuardError' && /EMPTY/.test(e.message));
    assert.equal(await redis.dbsize(), 0, 'nothing may be written by a refused init');
  });

  test('upgrades legacy v1 data in place; old links keep working; second run is a no-op', async () => {
    const old = 'L'.repeat(32);
    await redis.hset(`file:${old}`, { messageId: '11', fileId: 'tgfile_old', name: 'Old Invoice.pdf', type: 'document', size: '2048', mime: 'application/pdf', uploaderId: String(A), uploadedAt: String(Date.now() - 864e5), downloads: '3', expiresAt: '0' });
    await redis.expire(`file:${old}`, 99999); // v1 could put a TTL on metadata
    await redis.zadd(`user:${A}:files`, Date.now() - 864e5, old);
    await redis.sadd('users', String(A));
    const info = await schema.initDatabase();
    assert.equal(info.schema, 3);
    assert.equal(await redis.pttl(`file:${old}`), -1, 'metadata TTL must be removed');
    assert.equal(await redis.hget(`share:${old}`, 'fileId'), old, 'legacy token becomes a share link');
    const again = await schema.initDatabase();
    assert.equal(again.dbId, info.dbId);

    const n = mark();
    await say(B, `/start f_${old}`);
    assert.equal(delivered(n, B).length, 1, 'recipient can still use the old link');
    assert.ok(isStorage(delivered(n, B)[0].payload.from_chat_id));
    assert.equal(delivered(n, B)[0].payload.message_id, 11);

    const m = mark();
    await say(A, '/files');
    assert.match(lastText(m, A), /Old Invoice\.pdf/);
    const q = mark();
    await tap(A, `qr:${old}`); // buttons from messages sent by the old version still work
    assert.ok(since(q).some((c) => c.method === 'sendDocument'));
    const o = mark();
    await tap(A, `open:${old}`);
    assert.match(lastText(o, A), /Old Invoice\.pdf/);
  });

  test('refuses a database written by a newer version', async () => {
    await redis.set('meta:schema', '99');
    await assert.rejects(() => schema.initDatabase(), /newer/);
    await redis.set('meta:schema', '3');
  });
});

describe('dashboard & upload', () => {
  test('/start shows the dashboard with all 10 buttons, admin button only for admins', async () => {
    let n = mark();
    await say(A, '/start');
    assert.match(lastText(n, A), /FILE VAULT/);
    assert.match(lastText(n, A), /Private • Secure • Fast/);
    const labels = buttons(n, A).map((b) => b.text);
    for (const l of ['📤 Upload File', '📁 My Files', '🔗 Shared Links', '🕘 Recent Files', '🔍 Search Files', '📊 Storage', '⚙️ Settings', '🔐 Privacy', '❓ Help', '👨‍💻 Developer']) assert.ok(labels.includes(l), l);
    assert.ok(!labels.some((l) => /Admin/.test(l)));
    n = mark();
    await say(ADMIN, '/start');
    assert.ok(buttons(n, ADMIN).some((b) => /Admin/.test(b.text)));
  });

  test('developer card', async () => {
    const n = mark();
    await tap(A, 'menu:dev');
    assert.match(lastText(n, A), /Developer: <b>Sahin<\/b>/);
    assert.match(lastText(n, A), /@Sahin_09022/);
  });

  test('upload creates a private file card (no link, no internal identifiers)', async () => {
    const n = mark();
    await upload(A, 'Quarterly Report.pdf', 'application/pdf', 12_400_000);
    const text = lastText(n, A);
    assert.match(text, /Quarterly Report\.pdf/);
    assert.match(text, /Private/);
    assert.match(text, /🆔 #[A-Z2-9]{6}/);
    assert.doesNotMatch(text, /start=f_|tgfile|1001234567890/);
    const labels = buttons(n, A).map((b) => b.text);
    for (const l of ['🔗 Share', '📥 Download', '✏️ Rename', '📂 Move', '🔐 Password', '⏳ Expiry', '🗑 Delete']) assert.ok(labels.includes(l), l);
    fileA = (await files.listFiles(A, { cat: 'pdf', page: 1 })).items.find((f) => f.name === 'Quarterly Report.pdf');
    assert.equal(fileA.cat, 'pdf');
    assert.equal((await redis.hget(`u:${A}`, 'fileCount')), '2');
    assert.ok(since(n).some((c) => c.method === 'copyMessage' && isStorage(c.payload.chat_id)));
  });
});

describe('share links', () => {
  test('wizard: expiry -> limit -> secure link with expiry and download limit', async () => {
    let n = mark();
    await tap(A, `shn:${fileA.id}`);
    assert.ok(buttons(n, A).some((b) => b.text === '⏳ 7 Days'));
    n = mark(); await tap(A, `shx:${fileA.id}:7d`);
    assert.ok(buttons(n, A).some((b) => b.text === '🔢 5'));
    n = mark(); await tap(A, `shl:${fileA.id}:7d:5`);
    const text = lastText(n, A);
    assert.match(text, /Share Link Created/);
    assert.match(text, /Downloads: 5/);
    const link = /start=f_([A-Za-z0-9_-]{32})/.exec(text);
    assert.ok(link, 'link present');
    linkToken = link[1];
    assert.notEqual(linkToken, fileA.id, 'public token differs from the internal file id');
    const share = await shares.getShare(linkToken);
    assert.equal(share.limit, 5);
    assert.ok(Math.abs(share.expiresAt - (Date.now() + 7 * 864e5)) < 60_000);
    const labels = buttons(n, A).map((b) => b.text);
    assert.ok(labels.includes('🔗 Open Link') && labels.includes('🚫 Revoke Link'));
  });

  test('recipient downloads through the link; limit is enforced; denial message is generic', async () => {
    for (let i = 0; i < 5; i += 1) {
      const n = mark();
      await say(B, `/start f_${linkToken}`);
      assert.equal(delivered(n, B).length, 1, `download ${i + 1}`);
      assert.ok(delivered(n, B)[0].payload.reply_markup.inline_keyboard[0][0].text.includes('Report'));
    }
    const n = mark();
    await say(B, `/start f_${linkToken}`);
    assert.equal(delivered(n, B).length, 0);
    assert.equal(lastText(n, B), UNAVAILABLE);
    assert.equal((await shares.getShare(linkToken)).downloads, 5);
  });

  test('concurrent downloads never exceed the limit', async () => {
    const res = await shares.createShare({ fileId: fileA.id, ownerId: A, expiresAt: 0, limit: 3 });
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => shares.consumeShare(res.share.token)));
    assert.equal(outcomes.filter((o) => o.ok).length, 3);
  });

  test('invalid, revoked, expired and deleted-file links all look identical', async () => {
    const msgs = new Set();
    let n = mark();
    await say(B, `/start f_${'z'.repeat(32)}`); msgs.add(lastText(n, B));
    await say(B, '/start f_short'); msgs.add(lastText(mark() - 0, B) || UNAVAILABLE);

    const mk = async () => (await shares.createShare({ fileId: fileA.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    const revoked = await mk();
    n = mark(); await tap(A, `srv:${revoked.token}`); await tap(A, `srvok:${revoked.token}`);
    n = mark(); await say(B, `/start f_${revoked.token}`); msgs.add(lastText(n, B));

    const expired = await mk();
    await redis.hset(`share:${expired.token}`, 'expiresAt', String(Date.now() - 1000));
    n = mark(); await say(B, `/start f_${expired.token}`); msgs.add(lastText(n, B));

    await say(A, '/start'); // keep profile fresh
    assert.deepEqual([...msgs].filter((m) => m !== UNAVAILABLE), [], 'every denial must show the generic message');
  });

  test('owner can list, open, edit and delete links; only owners may manage them', async () => {
    let n = mark();
    await tap(A, 'links:1');
    assert.match(lastText(n, A), /Shared Links/);
    assert.match(lastText(n, A), /Quarterly Report\.pdf/);
    assert.match(lastText(n, A), /Revoked|Active|Limit reached|Expired/);
    const s = (await shares.createShare({ fileId: fileA.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    n = mark(); await tap(B, `sd:${s.token}`); // another user
    assert.deepEqual(alerts(n), ['Link not found or no longer available.']);
    n = mark(); await tap(A, `sey:${s.token}:30d`);
    assert.ok((await shares.getShare(s.token)).expiresAt > Date.now() + 29 * 864e5);
    n = mark(); await tap(A, `sem:${s.token}:10`);
    assert.equal((await shares.getShare(s.token)).limit, 10);
    await tap(A, `sdelok:${s.token}`);
    assert.equal(await shares.getShare(s.token), null);
  });

  test('QR code is generated for an active link', async () => {
    const s = (await shares.createShare({ fileId: fileA.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    const n = mark();
    await tap(A, `qr:${s.token}`);
    assert.ok(since(n).some((c) => c.method === 'sendDocument'), 'QR PNG sent as a document');
  });
});

describe('password protection', () => {
  let pwShare;
  test('set password: message deleted, only a scrypt hash stored', async () => {
    await tap(A, `pws:${fileA.id}`);
    const n = mark();
    await say(A, 'S3cret-Pass!');
    assert.ok(since(n).some((c) => c.method === 'deleteMessage'), 'password message removed from chat');
    assert.match(lastText(n, A), /Password saved/);
    const stored = await redis.hget(`file:${fileA.id}`, 'pwHash');
    assert.match(stored, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!stored.includes('S3cret-Pass!'));
    assert.ok(await verifyPassword('S3cret-Pass!', stored));
    assert.ok(!(await verifyPassword('wrong', stored)));
    pwShare = (await shares.createShare({ fileId: fileA.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
  });

  test('no plain-text password anywhere in Redis', async () => {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const k of keys) {
        const type = await redis.type(k);
        const dump = type === 'hash' ? JSON.stringify(await redis.hgetall(k)) : type === 'string' ? await redis.get(k) : type === 'stream' ? JSON.stringify(await redis.xrange(k, '-', '+')) : '';
        assert.ok(!dump.includes('S3cret-Pass!'), `leak in ${k}`);
      }
    } while (cursor !== '0');
  });

  test('recipient must enter the correct password; wrong ones are rate limited', async () => {
    let n = mark();
    await say(C, `/start f_${pwShare.token}`);
    assert.match(lastText(n, C), /Password required/);
    assert.equal(delivered(n, C).length, 0);
    n = mark(); await say(C, 'nope-1');
    assert.match(lastText(n, C), /Incorrect password/);
    assert.equal(delivered(n, C).length, 0);
    n = mark(); await say(C, 'S3cret-Pass!');
    assert.equal(delivered(n, C).length, 1, 'correct password delivers');
    assert.equal((await shares.getShare(pwShare.token)).downloads, 1);
  });

  test('brute force is locked out after the attempt limit', async () => {
    const D = 2004;
    await say(D, `/start f_${pwShare.token}`);
    let last = '';
    for (let i = 0; i < 6; i += 1) {
      const n = mark();
      await say(D, `guess-${i}!!`);
      last = lastText(n, D);
      assert.equal(delivered(n, D).length, 0);
      if (i < 5) assert.match(last, /Incorrect password/);
    }
    assert.match(last, /Too many attempts/, 'the 6th attempt inside the window is refused');
    // even the right password is refused while locked
    await say(D, `/start f_${pwShare.token}`);
    const n = mark();
    await say(D, 'S3cret-Pass!');
    assert.equal(delivered(n, D).length, 0);
  });

  test('owner bypasses the password; remove password works', async () => {
    let n = mark();
    await say(A, `/start f_${pwShare.token}`);
    assert.equal(delivered(n, A).length, 1);
    n = mark(); await tap(A, `pwrok:${fileA.id}`);
    assert.equal(await redis.hget(`file:${fileA.id}`, 'pwHash'), null);
  });
});

describe('expiry', () => {
  test('expired file disables links, owner keeps access, sweeper records it; renew restores', async () => {
    const f = (await files.listFiles(A, { page: 1 })).items.find((x) => x.name === 'Quarterly Report.pdf');
    const open = (await shares.createShare({ fileId: f.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    await files.setFileExpiry(f.id, Date.now() - 5000);
    let n = mark();
    await say(B, `/start f_${open.token}`);
    assert.equal(lastText(n, B), UNAVAILABLE);
    assert.equal(delivered(n, B).length, 0);
    n = mark(); await tap(A, `dl:${f.id}`);
    assert.equal(delivered(n, A).length, 1, 'owner can still download (EXPIRED_OWNER_ACCESS default)');
    assert.equal(await files.sweepExpiredFiles(), 1);
    assert.ok(await redis.hget(`file:${f.id}`, 'expiredAt'));
    assert.ok(await redis.exists(`file:${f.id}`), 'metadata is never deleted by expiry');
    n = mark(); await tap(A, `exs:${f.id}:1d`);
    n = mark(); await say(B, `/start f_${open.token}`);
    assert.equal(delivered(n, B).length, 1, 'renewed file is shareable again');
    assert.equal(parseDuration('90m'), 5400);
    assert.equal(parseDuration('2'), null);
    assert.equal(parseDuration('1m'), null);
  });

  test('custom expiry through text input', async () => {
    const f = await idFromCard();
    await tap(A, `exs:${f.id}:c`);
    const n = mark();
    await say(A, '3d');
    assert.match(lastText(n, A), /Expiry updated/);
    assert.ok(Math.abs((await files.getFileRecord(f.id)).meta.expiresAt - (Date.now() + 3 * 864e5)) < 60_000);
  });
});

describe('my files, recent, search, storage, folders', () => {
  before(async () => {
    for (const [name, mime, size] of [['holiday.mp4', 'video/mp4', 5e7], ['photo_beach.jpg', 'image/jpeg', 2e6], ['Invoice March.pdf', 'application/pdf', 4e5], ['archive.zip', 'application/zip', 3e6], ['song.mp3', 'audio/mpeg', 4e6], ['notes.txt', 'text/plain', 100]]) await upload(A, name, mime, size);
    for (let i = 0; i < 12; i += 1) await upload(A, `bulk-${i}.txt`, 'text/plain', 10);
    await new Promise((r) => setTimeout(r, 1500)); // uploads sent together form one batch; wait until the batch is finalized
  });

  test('pagination: never loads everything', async () => {
    const p1 = await files.listFiles(A, { page: 1 });
    const p3 = await files.listFiles(A, { page: 3 });
    assert.equal(p1.items.length, 5);
    assert.equal(p3.page, 3);
    assert.equal(p1.total, 20);
    assert.equal(p1.totalPages, 4);
  });

  test('categories', async () => {
    assert.equal((await files.listFiles(A, { cat: 'video' })).total, 1);
    assert.equal((await files.listFiles(A, { cat: 'photo' })).total, 1);
    assert.equal((await files.listFiles(A, { cat: 'audio' })).total, 1);
    assert.equal((await files.listFiles(A, { cat: 'archive' })).total, 1);
    assert.equal((await files.listFiles(A, { cat: 'pdf' })).total, 3);
    assert.equal((await files.listFiles(A, { cat: 'doc' })).total, 13);
    const n = mark();
    await tap(A, 'fc:video:1');
    assert.match(lastText(n, A), /holiday\.mp4/);
  });

  test('recent files shows the latest five with quick actions', async () => {
    const n = mark();
    await tap(A, 'menu:recent');
    assert.match(lastText(n, A), /bulk-11\.txt/);
    assert.ok(buttons(n, A).some((b) => b.text === '📥'));
  });

  test('search by name prefix, type, date, id; owner filter is admin-only', async () => {
    const run = (q, v = A, admin = false) => runSearch(parseQuery(q), { viewerId: v, isAdmin: admin });
    assert.equal((await run('inv')).total, 2, 'prefix of a filename word (Old Invoice + Invoice March)');
    assert.equal((await run('invoice march')).items[0].name, 'Invoice March.pdf');
    assert.equal((await run('type:video')).total, 1);
    assert.equal((await run('type:txt')).total, 13);
    assert.equal((await run('bulk type:txt')).total, 12);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const all = (await files.listFiles(A, {})).total;
    assert.equal((await run(`date:${today}`)).total, all - 1, 'everything except the legacy file uploaded yesterday');
    assert.equal((await run(`date:${yesterday}`)).total, 1);
    assert.equal((await run(`after:${yesterday}`)).total, all);
    assert.equal((await run(`before:${yesterday} invoice`)).total, 1, 'combined filters');
    assert.equal((await run('date:2016-01-01')).total, 0);
    assert.equal((await run('after:2099-01-01')).total, 0);
    const ref = (await files.listFiles(A, { cat: 'video' })).items[0].ref;
    assert.equal((await run(`#${ref}`)).total, 1);
    assert.equal((await run(`#${ref}`, B)).total, 0, 'refs do not leak across users');
    assert.equal((await run(`holiday owner:${A}`, B)).error, 'forbidden');
    assert.equal((await run(`holiday owner:${A}`, ADMIN, true)).total, 1);
    assert.equal((await run(`holiday owner:@user_${A}`, ADMIN, true)).total, 1);
    assert.ok((await run('a')).error, 'one-letter words rejected');
    assert.ok((await run('type:??')).error);
  });

  test('search through the bot UI + rate limit', async () => {
    await tap(C, 'menu:search');
    let n = mark();
    await say(C, 'holiday');
    assert.match(lastText(n, C), /No results/);
    for (let i = 0; i < 4; i += 1) { await tap(C, 'menu:search'); await say(C, 'x1'); }
    await tap(C, 'menu:search');
    n = mark();
    await say(C, 'holiday');
    assert.match(lastText(n, C), /Too many requests/);
    await redis.del(...(await redis.keys('rl:search:*')));
    await tap(A, 'menu:search');
    n = mark(); await say(A, 'holiday type:video');
    assert.match(lastText(n, A), /holiday\.mp4/);
  });

  test('storage dashboard', async () => {
    const n = mark();
    await tap(A, 'menu:storage');
    const t = lastText(n, A);
    assert.match(t, /Storage Overview/);
    assert.match(t, /Files: <b>20<\/b>/);
    assert.match(t, /🎥 Videos: 47\.7 MB \(1\)/);
    assert.match(t, /🖼 Photos/);
    assert.doesNotMatch(t, /\/home|\/app|redis:\/\//);
  });

  test('folders: create via move, list, filter', async () => {
    const f = (await files.listFiles(A, { cat: 'video' })).items[0];
    await tap(A, `mvn:${f.id}`);
    let n = mark();
    await say(A, 'Holidays');
    assert.match(lastText(n, A), /Moved to/);
    const folders = await files.listFolders(A);
    assert.equal(folders[0].name, 'Holidays');
    assert.equal(folders[0].count, 1);
    n = mark(); await tap(A, `fo:${folders[0].id}:1`);
    assert.match(lastText(n, A), /holiday\.mp4/);
  });

  test('rename updates the search index', async () => {
    const f = (await files.listFiles(A, { cat: 'audio' })).items[0];
    await tap(A, `rn:${f.id}`);
    await say(A, 'lullaby.mp3');
    const run = (q) => runSearch(parseQuery(q), { viewerId: A });
    assert.equal((await run('song')).total, 0);
    assert.equal((await run('lull')).total, 1);
  });
});

describe('delete', () => {
  test('removes it for the user (links, stats, index) and never touches the storage channel', async () => {
    const f = (await files.listFiles(A, { cat: 'archive' })).items[0];
    const s = (await shares.createShare({ fileId: f.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    const before = Number(await redis.hget(`ustats:${A}`, 'files'));
    const n = mark();
    await tap(A, `delok:${f.id}`);
    assert.match(lastText(n, A), /deleted permanently/);
    assert.equal(await redis.exists(`file:${f.id}`), 0);
    assert.equal(await shares.getShare(s.token), null);
    assert.equal(Number(await redis.hget(`ustats:${A}`, 'files')), before - 1);
    assert.equal((await runSearch(parseQuery('archive'), { viewerId: A })).total, 0);
    assert.equal((await files.listFiles(A, { cat: 'archive' })).total, 0);
    assert.ok(!since(n).some((c) => ['deleteMessage'].includes(c.method) && isStorage(c.payload.chat_id)), 'storage channel untouched');
    const m = mark();
    await say(B, `/start f_${s.token}`);
    assert.equal(lastText(m, B), UNAVAILABLE);
  });

  test("cannot delete or open someone else's file", async () => {
    const f = (await files.listFiles(A, { cat: 'video' })).items[0];
    let n = mark(); await tap(B, `delok:${f.id}`);
    assert.ok(await redis.exists(`file:${f.id}`));
    n = mark(); await tap(B, `open:${f.id}`);
    assert.deepEqual(alerts(n), ['File not found or no longer available.']);
    n = mark(); await tap(B, `shn:${f.id}`);
    assert.deepEqual(alerts(n), ['File not found or no longer available.']);
  });
});

describe('admin', () => {
  test('non-admins cannot reach any admin function', async () => {
    let n = mark(); await say(B, '/admin');
    assert.match(lastText(n, B), /Unknown command/);
    n = mark(); await tap(B, 'adm:users');
    assert.deepEqual(alerts(n), ['Not available.']);
    n = mark(); await tap(B, 'adm:maint:on');
    assert.deepEqual(alerts(n), ['Not available.']);
    assert.ok(!(await redis.get('state:maintenance')));
    n = mark(); await say(B, '/stats'); assert.match(lastText(n, B), /Unknown command/);
  });

  test('admin panel sections work', async () => {
    let n = mark(); await say(ADMIN, '/admin');
    const labels = buttons(n, ADMIN).map((b) => b.text);
    for (const l of ['👥 Users', '📁 Files', '🔗 Share Links', '📊 Storage', '🚨 Reports', '📋 Logs', '⚙️ Settings', '🛡 Security']) assert.ok(labels.includes(l), l);
    for (const s of ['users', 'files', 'links', 'storage', 'logs', 'settings', 'security']) {
      n = mark(); await tap(ADMIN, `adm:${s}`);
      assert.ok(lastText(n, ADMIN).length > 20, s);
    }
    n = mark(); await tap(ADMIN, 'adm:logs');
    assert.match(lastText(n, ADMIN), /upload/);
    assert.doesNotMatch(lastText(n, ADMIN), /S3cret/);
    n = mark(); await tap(ADMIN, 'adm:security');
    assert.match(lastText(n, ADMIN), /Wrong passwords: [1-9]/);
  });

  test('report -> admin revokes all links of the file', async () => {
    const f = (await files.listFiles(A, { cat: 'video' })).items[0];
    const s = (await shares.createShare({ fileId: f.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    await say(B, `/start f_${s.token}`);
    await tap(B, `rp:${s.token}`);
    const n = mark();
    await tap(ADMIN, 'adm:reports:1');
    assert.match(lastText(n, ADMIN), /1 open/);
    const rv = buttons(n, ADMIN).find((b) => b.callback_data?.startsWith('adm:rv:'));
    await tap(ADMIN, rv.callback_data);
    assert.equal((await shares.getShare(s.token)).status, 'revoked');
    assert.ok(await redis.exists(`file:${f.id}`), 'file itself is kept');
  });

  test('/user lookup resolves by username (stable id is the key)', async () => {
    const n = mark();
    await say(ADMIN, `/user @user_${A}`);
    assert.match(lastText(n, ADMIN), new RegExp(String(A)));
  });
});

describe('profile, errors, secrets', () => {
  test('profile persisted by Telegram user id; username is only an alias', async () => {
    const p = await (await import('../src/services/users.js')).getProfile(A);
    assert.equal(p.id, A);
    assert.equal(p.username, `user_${A}`);
    assert.ok(p.createdAt > 0 && p.lastActive > 0);
    assert.ok(p.fileCount > 0 && p.storageUsed > 0);
    // username change keeps the same account
    await feed({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id: A, type: 'private' }, from: { ...user(A), username: 'renamed_a' }, text: 'hi' } });
    await new Promise((r) => setTimeout(r, 50));
    const users = await import('../src/services/users.js');
    assert.equal(await users.resolveUserId('@renamed_a'), A, 'new username points to the same id');
    assert.equal((await users.getProfile(A)).username, 'renamed_a');
    assert.equal((await users.getProfile(A)).fileCount, p.fileCount, 'files stay with the user id');
  });

  test('internal errors show only a reference id, never internals', async () => {
    const f = (await files.listFiles(A, { page: 1 })).items[0];
    const original = redis.scard;
    redis.scard = async () => { throw new Error('ECONNREFUSED redis://default:hunter2@10.0.0.5:6379 /app/src/secret.js'); };
    const n = mark();
    try { await tap(A, `shn:${f.id}`); await tap(A, `shl:${f.id}:7d:5`); } finally { redis.scard = original; }
    const shown = [...alerts(n), ...textsTo(n, A)].join('\n');
    assert.match(shown, /#[A-Z2-9]{6}/);
    assert.doesNotMatch(shown, /hunter2|ECONNREFUSED|\/app\/|secret\.js|Error:/);
  });

  test('no secrets in anything the bot ever said', async () => {
    const all = JSON.stringify(calls.filter((c) => c.method !== 'sendDocument').map((c) => c.payload));
    assert.ok(!all.includes(process.env.BOT_TOKEN));
    assert.ok(!all.includes(TEST_URL));
    assert.ok(!all.includes('scrypt$'));
    assert.ok(!/tgfile_/.test(JSON.stringify(calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.payload.text))), 'Telegram file ids never shown');
    assert.ok(!JSON.stringify(calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).map((c) => c.payload.text)).includes('-1001234567890'), 'storage channel id never shown');
  });
});


describe('file collections (multi-file upload + one link)', () => {
  const COLL_USER = 3001; const COLL_VIEWER = 3002;
  let token; let collId;

  async function sendMany(from, items) {
    for (const [name, mime, size] of items) await upload(from, name, mime, size);
  }

  test('files sent together become ONE collection with ONE link and ONE summary message', async () => {
    await say(COLL_USER, '/start');
    const n = mark();
    await sendMany(COLL_USER, [['photo1.jpg', 'image/jpeg', 2e6], ['photo2.png', 'image/png', 3e6], ['clip.mp4', 'video/mp4', 9e6], ['doc.pdf', 'application/pdf', 4e5], ['song.mp3', 'audio/mpeg', 4e6]]);
    await new Promise((r) => setTimeout(r, config_quiet() + 400));
    const list = await collections.listUserCollections(COLL_USER);
    assert.equal(list.total, 1, 'exactly one collection');
    const c = list.items[0].collection;
    token = c.shareToken; collId = c.id;
    assert.equal(c.fileCount, 5);
    const summary = textsTo(n, COLL_USER).filter((t) => /Upload Complete/.test(t));
    assert.equal(summary.length, 1, 'one summary, no per-file spam');
    assert.match(summary[0], new RegExp(`/share/${token}|start=c_${token}`));
    assert.ok(buttons(n, COLL_USER).some((b) => /Copy Link/.test(b.text)));
  });

  test('a single file keeps the old behaviour (file card, no collection)', async () => {
    const n = mark();
    await upload(COLL_VIEWER, 'only.pdf', 'application/pdf', 1000);
    await new Promise((r) => setTimeout(r, config_quiet() + 400));
    assert.equal((await collections.listUserCollections(COLL_VIEWER)).total, 0);
    assert.match(textsTo(n, COLL_VIEWER).join('\n'), /Uploaded/);
  });

  test('duplicate and re-delivered uploads are ignored', async () => {
    assert.equal(await uploadBatch.claimMessage(COLL_USER, 424242), true);
    assert.equal(await uploadBatch.claimMessage(COLL_USER, 424242), false);
  });

  test('opening the link in Telegram delivers all files; a stranger cannot manage the collection', async () => {
    const n = mark();
    await say(COLL_VIEWER, `/start c_${token}`);
    const copies = since(n).filter((c) => ['copyMessage', 'copyMessages'].includes(c.method) && Number(c.payload.chat_id) === COLL_VIEWER);
    assert.ok(copies.length >= 1);
    const m = mark();
    await tap(COLL_VIEWER, `cdl:${collId}`);
    assert.match(alerts(m).join(' '), /not found/i);
    await tap(COLL_VIEWER, `cdel:${collId}`);
    assert.ok((await collections.getCollection(collId)), 'still exists');
  });

  test('disabled / unknown links give the generic message', async () => {
    const coll = await collections.getCollection(collId);
    await collections.setLinkStatus(coll, 'disabled', 'admin');
    let n = mark();
    await say(COLL_VIEWER, `/start c_${token}`);
    assert.match(lastText(n, COLL_VIEWER), /File unavailable/);
    await collections.setLinkStatus(coll, 'active', 'admin');
    n = mark();
    await say(COLL_VIEWER, `/start c_${'A'.repeat(32)}`);
    assert.match(lastText(n, COLL_VIEWER), /File unavailable/);
  });

  test('owner manages collections: list, detail, rename, delete', async () => {
    let n = mark();
    await tap(COLL_USER, 'colls:1');
    assert.match(lastText(n, COLL_USER), /My Collections/);
    n = mark();
    await tap(COLL_USER, `co:${collId}`);
    assert.match(lastText(n, COLL_USER), /5 files/);
    await tap(COLL_USER, `crn:${collId}`);
    await say(COLL_USER, 'Summer trip');
    assert.equal((await collections.getCollection(collId)).title, 'Summer trip');
  });

  test('admin sees and controls collections', async () => {
    let n = mark();
    await tap(ADMIN, 'adm:colls:1');
    assert.match(lastText(n, ADMIN), /Collections/);
    n = mark();
    await tap(ADMIN, `adm:cd:${collId}`);
    assert.match(lastText(n, ADMIN), new RegExp(String(COLL_USER)));
    await tap(ADMIN, `adm:ctok:${collId}:d`);
    assert.equal((await collections.resolveCollectionShare(token)).reason, 'disabled');
    await tap(COLL_USER, `ctg:${collId}`);
    assert.equal((await collections.resolveCollectionShare(token)).reason, 'disabled', 'owner cannot undo an admin disable');
    await tap(ADMIN, `adm:ctok:${collId}:e`);
    assert.equal((await collections.resolveCollectionShare(token)).ok, true);
    const nonAdmin = mark();
    await tap(COLL_VIEWER, 'adm:colls:1');
    assert.match(alerts(nonAdmin).join(' '), /Not available/);
  });

  test('ZIP writer produces a valid archive with safe unique names', async () => {
    const alloc = zip.makeNameAllocator();
    assert.equal(alloc('a.txt'), 'a.txt'); assert.equal(alloc('A.txt'), 'A (2).txt'); assert.equal(alloc('../x/y.txt'), '_x_y.txt');
    const parts = [];
    for await (const c of zip.zipStream([{ name: 'a.txt', open: async () => [Buffer.from('hello')] }])) parts.push(c);
    const buf = Buffer.concat(parts);
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
  });

  test('deleting the collection with its files removes link and files', async () => {
    await tap(COLL_USER, `cdok:${collId}:f`);
    assert.equal(await collections.getCollection(collId), null);
    assert.equal((await collections.resolveCollectionShare(token)).ok, false);
    assert.equal((await files.listFiles(COLL_USER, { page: 1 })).total, 0);
  });
});

function config_quiet() { return Number(process.env.UPLOAD_BATCH_QUIET_MS || 2500); }

describe('backup & restore (Railway independence)', () => {
  test('backup -> empty database -> restore reproduces users, files, links, passwords, audit', async () => {
    const f = (await files.listFiles(A, { cat: 'video' })).items[0];
    const keyCount = async () => ({ files: (await redis.keys('file:*')).length, shares: (await redis.keys('share:*')).length, profiles: (await redis.keys('u:*')).length, audit: await redis.xlen('audit') });
    const before = await keyCount();
    const dbId = await redis.get('meta:dbid');
    const pw = (await files.listFiles(A, { page: 1 })).items[0];
    await files.setFilePassword(pw.id, await (await import('../src/services/password.js')).hashPassword('another-pass'));
    const pwHash = await redis.hget(`file:${pw.id}`, 'pwHash');
    const { buffer, filename } = await backup.createBackup({ reason: 'test' });
    assert.match(filename, /\.ndjson\.gz$/);

    await assert.rejects(() => backup.restoreBackup(buffer), /not empty/, 'never restores over existing data');
    await redis.flushdb();
    const result = await backup.restoreBackup(buffer);
    assert.equal(result.header.dbId, dbId);
    assert.deepEqual(await keyCount(), before);
    assert.equal(await redis.get('meta:dbid'), dbId, 'same database fingerprint');
    assert.equal(await redis.hget(`file:${pw.id}`, 'pwHash'), pwHash);

    // derived indexes were rebuilt: lists, search, stats, profile counters
    assert.equal((await runSearch(parseQuery('holiday'), { viewerId: A })).total, 1);
    assert.equal(Number(await redis.hget(`ustats:${A}`, 'files')), (await files.listFiles(A, { page: 1 })).total);
    assert.equal((await files.listFolders(A))[0].name, 'Holidays');

    // and the bot works on the restored data
    const open = (await shares.createShare({ fileId: f.id, ownerId: A, expiresAt: 0, limit: 0 })).share;
    const n = mark();
    await say(B, `/start f_${open.token}`);
    assert.equal(delivered(n, B).length, 1);
    // init on the restored database is a plain no-op
    assert.equal((await schema.initDatabase()).dbId, dbId);
  });

  test('encrypted backups round-trip and reject a wrong key', async () => {
    const { buffer } = await backup.createBackup({ reason: 'enc' });
    const enc = backup.encrypt(buffer, 'a-long-passphrase-123');
    assert.ok(!enc.includes(Buffer.from('Quarterly')));
    assert.deepEqual(backup.decryptIfNeeded(enc, 'a-long-passphrase-123'), buffer);
    assert.throws(() => backup.decryptIfNeeded(enc, 'wrong-passphrase-123'), /Could not decrypt/);
    assert.throws(() => backup.decryptIfNeeded(enc, ''), /encrypted/);
    assert.equal(backup.parseBackup(enc, 'a-long-passphrase-123').header.format, 'vault-backup');
  });

  test('Railway-hosted Redis is detected', () => {
    for (const host of ['redis.railway.internal', 'monorail.proxy.rlwy.net', 'x.up.railway.app']) assert.ok(schema.railwayHostWarning(`redis://default:pw@${host}:6379`), host);
    assert.equal(schema.railwayHostWarning('rediss://default:pw@eu1-example.upstash.io:6379'), null);
  });
});

describe('delivery policy: forward lock + auto-delete', () => {
  const P_USER = 3101; const P_VIEWER = 3102;
  const dueNow = async () => { for (const id of await redis.zrange('dj:due', 0, -1)) await redis.zadd('dj:due', Date.now() - 1000, id); };
  const deletes = (n, chat) => since(n).filter((c) => c.method === 'deleteMessages' && Number(c.payload.chat_id) === chat);
  let linkTok;

  test('single file: protected copy + notice + job; owner is exempt', async () => {
    await autodelete.setPolicy({ autoDelete: 600, forwardLock: 120 });
    await upload(P_USER, 'policy.pdf', 'application/pdf', 1000);
    await new Promise((r) => setTimeout(r, config_quiet() + 400));
    const f = (await files.listFiles(P_USER, { page: 1 })).items[0];
    linkTok = (await shares.createShare({ fileId: f.id, ownerId: P_USER, expiresAt: 0, limit: 0 })).share.token;
    await redis.del('dj:due', ...(await redis.keys('dj:d:*'))); // drop jobs created by earlier tests (default policy is on)
    let n = mark();
    await say(P_VIEWER, `/start f_${linkTok}`);
    const d = delivered(n, P_VIEWER);
    assert.equal(d.length, 1);
    assert.equal(d[0].payload.protect_content, true, 'forwarding locked');
    assert.match(lastText(n, P_VIEWER), /locked for <b>2 min<\/b>/);
    assert.match(lastText(n, P_VIEWER), /deleted automatically in <b>10 min<\/b>/);
    assert.equal(await redis.zcard('dj:due'), 1);
    n = mark();
    await say(P_USER, `/start f_${linkTok}`);
    assert.equal(delivered(n, P_USER)[0].payload.protect_content, undefined, 'owner gets a normal copy');
    assert.equal(await redis.zcard('dj:due'), 1, 'owner delivery schedules nothing');
  });

  test('after the lock: locked copy deleted, forwardable copy re-sent, then auto-deleted', async () => {
    await dueNow();
    let n = mark();
    await autodelete.sweepOnce();
    assert.equal(deletes(n, P_VIEWER).length, 1, 'locked copy + notice removed');
    const again = delivered(n, P_VIEWER);
    assert.equal(again.length, 1);
    assert.ok(!again[0].payload.protect_content, 'forwarding allowed now');
    assert.ok(again[0].payload.reply_markup.inline_keyboard[0][0].text.includes('Report'), 'report button kept');
    assert.match(lastText(n, P_VIEWER), /Forwarding is now allowed/);
    assert.equal(await redis.zcard('dj:due'), 1, 'delete job scheduled');
    await dueNow();
    n = mark();
    await autodelete.sweepOnce();
    assert.equal(deletes(n, P_VIEWER).length, 1, 'final delete');
    assert.equal(await redis.zcard('dj:due'), 0);
    assert.equal((await redis.keys('dj:d:*')).length, 0, 'job data cleaned up');
  });

  test('lock shorter than nothing / auto-delete only: plain copy and a single delete job', async () => {
    await autodelete.setPolicy({ autoDelete: 300, forwardLock: 0 });
    const n = mark();
    await say(P_VIEWER, `/start f_${linkTok}`);
    assert.equal(delivered(n, P_VIEWER)[0].payload.protect_content, undefined);
    assert.doesNotMatch(lastText(n, P_VIEWER), /locked/);
    assert.equal(await redis.zcard('dj:due'), 1);
    await dueNow();
    const m = mark();
    await autodelete.sweepOnce();
    assert.equal(deletes(m, P_VIEWER).length, 1);
    assert.equal(delivered(m, P_VIEWER).length, 0, 'no re-send when there was no lock');
  });

  test('lock longer than auto-delete: just deleted, never unlocked', async () => {
    await autodelete.setPolicy({ autoDelete: 60, forwardLock: 300 });
    const n = mark();
    await say(P_VIEWER, `/start f_${linkTok}`);
    assert.equal(delivered(n, P_VIEWER)[0].payload.protect_content, true);
    await dueNow();
    const m = mark();
    await autodelete.sweepOnce();
    assert.equal(deletes(m, P_VIEWER).length, 1);
    assert.equal(delivered(m, P_VIEWER).length, 0);
    assert.equal(await redis.zcard('dj:due'), 0);
  });

  test('both off: nothing scheduled, no notice', async () => {
    await autodelete.setPolicy({ autoDelete: 0, forwardLock: 0 });
    const n = mark();
    await say(P_VIEWER, `/start f_${linkTok}`);
    assert.equal(delivered(n, P_VIEWER)[0].payload.protect_content, undefined);
    assert.equal(textsTo(n, P_VIEWER).length, 0);
    assert.equal(await redis.zcard('dj:due'), 0);
  });

  test('collection link: all files protected, unlocked later as one group', async () => {
    await autodelete.setPolicy({ autoDelete: 600, forwardLock: 120 });
    const C_OWN = 3103; const C_VIEW = 3104;
    for (let i = 0; i < 3; i += 1) await upload(C_OWN, `batch-${i}.pdf`, 'application/pdf', 1000);
    await new Promise((r) => setTimeout(r, config_quiet() + 400));
    const coll = (await collections.listUserCollections(C_OWN)).items[0].collection;
    let n = mark();
    await say(C_VIEW, `/start c_${coll.shareToken}`);
    const copies = since(n).filter((c) => c.method === 'copyMessages' && Number(c.payload.chat_id) === C_VIEW);
    assert.ok(copies.length >= 1 && copies.every((c) => c.payload.protect_content === true));
    assert.match(textsTo(n, C_VIEW).join('\n'), /locked for <b>2 min<\/b>/);
    assert.equal(await redis.zcard('dj:due'), 1);
    await dueNow();
    n = mark();
    await autodelete.sweepOnce();
    assert.equal(deletes(n, C_VIEW).length, 1);
    const re = since(n).filter((c) => c.method === 'copyMessages' && Number(c.payload.chat_id) === C_VIEW);
    assert.equal(re.length, 1);
    assert.equal(re[0].payload.message_ids.length, 3);
    assert.ok(!re[0].payload.protect_content);
    assert.ok(buttons(n, C_VIEW).some((b) => /Report/.test(b.text)), 'report button re-attached');
    await dueNow();
    await autodelete.sweepOnce();
    assert.equal(await redis.zcard('dj:due'), 0);
    // owner opening own collection: normal permanent copy
    n = mark();
    await say(C_OWN, `/start c_${coll.shareToken}`);
    assert.equal(await redis.zcard('dj:due'), 0);
  });

  test('admin commands /autodelete and /forwardlock; invalid input is rejected', async () => {
    let n = mark();
    await say(ADMIN, '/autodelete 5m');
    assert.match(lastText(n, ADMIN), /Auto-delete: <b>5 min<\/b>/);
    assert.equal((await autodelete.getPolicy()).autoDelete, 300);
    n = mark();
    await say(ADMIN, '/forwardlock off');
    assert.equal((await autodelete.getPolicy()).forwardLock, 0);
    n = mark();
    await say(ADMIN, '/autodelete banana');
    assert.match(lastText(n, ADMIN), /Usage/);
    assert.equal((await autodelete.getPolicy()).autoDelete, 300, 'unchanged');
    n = mark();
    await say(B, '/autodelete 1m');
    assert.match(lastText(n, B), /Unknown command/);
    assert.equal(autodelete.parseSeconds('90'), 90);
    assert.equal(autodelete.parseSeconds('2 min'), 120);
    assert.equal(autodelete.parseSeconds('1h'), 3600);
    assert.equal(autodelete.parseSeconds('off'), 0);
    assert.equal(autodelete.parseSeconds('x'), null);
  });

  test('admin settings panel cycles the policy', async () => {
    await autodelete.setPolicy({ autoDelete: 600, forwardLock: 120 });
    let n = mark();
    await tap(ADMIN, 'adm:dl:ad');
    assert.equal((await autodelete.getPolicy()).autoDelete, 1800);
    await tap(ADMIN, 'adm:dl:fl');
    assert.equal((await autodelete.getPolicy()).forwardLock, 300);
    assert.ok(buttons(n, ADMIN).some((b) => /Auto-delete: 30 min/.test(b.text)));
  });
});

process.on('exit', () => {});
test.after(async () => { await redis.quit().catch(() => {}); });
