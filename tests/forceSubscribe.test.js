// End-to-end tests of the dynamic Force Subscribe module against a REAL Redis and the real bot handlers
// (Telegram API calls are intercepted by a fake that can simulate joins, leaves, restricted users, missing admin rights, API failures).
//   VAULT_TEST_REDIS_URL=redis://127.0.0.1:6379/15 node --test tests/forceSubscribe.test.js
// The database is FLUSHED at the start of every run: only point this at a throw-away database.
import test, { describe } from 'node:test';
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
  MAX_STARTS_PER_MINUTE: '0', MAX_ADMIN_COMMANDS_PER_MINUTE: '0', MAX_TEXT_INPUTS_PER_MINUTE: '0', BACKUP_INTERVAL_HOURS: '0',
  BASE_URL: 'https://vault.example.com',
  FORCE_SUB_CACHE_SECONDS: '0', // strictest mode: every protected interaction asks Telegram
  FORCE_SUB_SEED: '@TheRoyalZone|The Royal Zone|📢 Join The Royal Zone|https://t.me/TheRoyalZone;@NoAdminChan|No Admin Chan',
});

const { redis, connectRedis } = await import('../src/services/redis.js');
await connectRedis();
await redis.flushdb();
const { bot } = await import('../src/services/telegram.js');
const { registerBot } = await import('../src/bot/index.js');
const fsub = await import('../src/services/forceSubscribe.js');
const backup = await import('../src/services/backup.js');
const { setAwait } = await import('../src/services/inputState.js');
const { HttpError } = await import('grammy');

// ---------------------------------------------------------------- fake Telegram
const BOT_ID = 123456;
const CH = {
  royal: { id: -1001000000001, type: 'channel', title: 'The Royal Zone', username: 'TheRoyalZone' },
  smai: { id: -1001000000002, type: 'channel', title: 'SM AI Updates', username: 'SMAIUpdates' },
  vault: { id: -1001000000003, type: 'channel', title: 'Private Vault' }, // private: no username
  news: { id: -1001000000004, type: 'channel', title: 'Official Announcements', username: 'OfficialAnn' },
  noadmin: { id: -1001000000005, type: 'channel', title: 'No Admin Chan', username: 'NoAdminChan' },
};
const chatByRef = (ref) => {
  const r = String(ref).toLowerCase();
  return Object.values(CH).find((c) => String(c.id) === r || (c.username && `@${c.username.toLowerCase()}` === r));
};
const botStatus = { [CH.royal.id]: 'administrator', [CH.smai.id]: 'administrator', [CH.vault.id]: 'administrator', [CH.news.id]: 'creator', [CH.noadmin.id]: 'member' };
const members = new Map(); // `${chatId}:${userId}` -> { status, is_member }
const failures = new Map(); // chatId -> 'NETWORK' | 'Bad Request: ...' (thrown for USER lookups only)
const setMember = (ch, uid, status = 'member', is_member) => members.set(`${ch.id}:${uid}`, { status, is_member });
const leave = (ch, uid) => members.set(`${ch.id}:${uid}`, { status: 'left' });

const calls = [];
let seq = 1000;
bot.botInfo = { id: BOT_ID, is_bot: true, first_name: 'Vault', username: 'Test_Vault_Bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: { ...payload } });
  if (method === 'getChat') {
    const c = chatByRef(payload.chat_id);
    return c ? { ok: true, result: c } : { ok: false, error_code: 400, description: 'Bad Request: chat not found' };
  }
  if (method === 'getChatMember') {
    const chatId = String(payload.chat_id);
    if (Number(payload.user_id) === BOT_ID) return { ok: true, result: { status: botStatus[chatId] ?? 'left', user: { id: BOT_ID, is_bot: true, first_name: 'Vault' } } };
    if (failures.has(chatId)) {
      if (failures.get(chatId) === 'NETWORK') throw new HttpError('network down', new Error('ECONNRESET'));
      return { ok: false, error_code: 400, description: failures.get(chatId) };
    }
    const m = members.get(`${chatId}:${payload.user_id}`);
    return { ok: true, result: { status: m?.status ?? 'left', is_member: m?.is_member, user: { id: payload.user_id, is_bot: false, first_name: 'U' } } };
  }
  const msg = { message_id: ++seq, date: 0, chat: { id: payload.chat_id ?? 0, type: 'private' }, text: payload.text };
  return { ok: true, result: ['answerCallbackQuery', 'deleteMessage', 'sendChatAction'].includes(method) ? true : msg };
});
registerBot(bot);

import { BotError } from 'grammy';
let uid = 0; let mid = 5000;
async function feed(update) {
  try { await bot.handleUpdate(update); } catch (e) { if (e instanceof BotError) await bot.errorHandler(e); else throw e; }
}
const user = (id) => ({ id, is_bot: false, first_name: `U${id}`, username: `user_${id}` });
async function say(from, text) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined;
  await feed({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id: from, type: 'private' }, from: user(from), text, entities } });
}
async function upload(from, name) {
  await feed({ update_id: ++uid, message: { message_id: ++mid, date: 0, chat: { id: from, type: 'private' }, from: user(from), document: { file_id: `tg_${name}_${mid}`, file_unique_id: 'u', file_name: name, mime_type: 'application/pdf', file_size: 1000 } } });
}
async function tap(from, data) {
  await feed({ update_id: ++uid, callback_query: { id: String(++uid), from: user(from), chat_instance: 'c', data, message: { message_id: 777, date: 0, chat: { id: from, type: 'private' }, text: 'x' } } });
}
const mark = () => calls.length;
const since = (n) => calls.slice(n);
const msgsTo = (n, chat) => since(n).filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && Number(c.payload.chat_id) === chat);
const lastText = (n, chat) => msgsTo(n, chat).at(-1)?.payload.text ?? '';
const buttons = (n, chat) => msgsTo(n, chat).at(-1)?.payload.reply_markup?.inline_keyboard.flat() ?? [];
const labels = (n, chat) => buttons(n, chat).map((b) => b.text);
const alerts = (n) => since(n).filter((c) => c.method === 'answerCallbackQuery' && c.payload.text).map((c) => c.payload.text);
const copied = (n) => since(n).filter((c) => c.method === 'copyMessage');
const JOIN = 'Join required';

const ADMIN = 1001; const NOADMIN = 2001; const U1 = 3001; const U2 = 3002; const U3 = 3003;
const byName = async (name) => (await fsub.listChannels()).find((c) => c.name === name);

// ---------------------------------------------------------------- tests
describe('input validation', () => {
  test('join URLs: only real Telegram links; unsafe schemes and look-alike hosts are rejected', () => {
    for (const bad of ['javascript:alert(1)', 'http://t.me/TheRoyalZone', 'tg://resolve?domain=x', 'data:text/html,hi', 'https://evil.com/TheRoyalZone',
      'https://t.me.evil.com/TheRoyalZone', 'https://user:pw@t.me/TheRoyalZone', 'https://t.me:8080/TheRoyalZone', 'https://t.me/', 'https://t.me/ab', 'https://t.me/+short',
      'https://t.me/TheRoyalZone/123/456', '', 'ftp://t.me/TheRoyalZone', '//t.me/TheRoyalZone']) {
      assert.equal(fsub.validateJoinUrl(bad).ok, false, `must reject ${bad}`);
    }
    assert.deepEqual(fsub.validateJoinUrl('https://t.me/TheRoyalZone'), { ok: true, value: 'https://t.me/TheRoyalZone', kind: 'public' });
    assert.equal(fsub.validateJoinUrl('t.me/TheRoyalZone?x=1#y').value, 'https://t.me/TheRoyalZone'); // query + fragment dropped
    assert.deepEqual(fsub.validateJoinUrl('https://t.me/+AbCdEf12345'), { ok: true, value: 'https://t.me/+AbCdEf12345', kind: 'private' });
    assert.equal(fsub.validateJoinUrl('https://t.me/joinchat/AbCdEf12345').value, 'https://t.me/+AbCdEf12345');
  });

  test('channel references: @username, bare username, -100 ids; nothing else', () => {
    assert.equal(fsub.parseChannelRef('@TheRoyalZone').value, '@TheRoyalZone');
    assert.equal(fsub.parseChannelRef('TheRoyalZone').value, '@TheRoyalZone');
    assert.equal(fsub.parseChannelRef('-1001234567890').kind, 'id');
    for (const bad of ['', '@ab', '12345', '-123', 'https://t.me/x', '@bad name', '<script>']) assert.equal(fsub.parseChannelRef(bad).ok, false, bad);
  });

  test('text is cleaned: control / bidi characters removed, length capped', () => {
    assert.equal(fsub.parseName('  The\u202e  Royal\u0000   Zone ').value, 'The Royal Zone');
    assert.equal(fsub.parseName('x'.repeat(65)).ok, false);
    assert.equal(fsub.parseButtonLabel('   ').ok, false);
    assert.equal(fsub.parseDescription('-').value, '');
    assert.equal(fsub.parseDescription('y'.repeat(301)).ok, false);
  });
});

describe('migration of the existing @TheRoyalZone channel (FORCE_SUB_SEED)', () => {
  test('imports once: usable channel ACTIVE, one the bot cannot verify DISABLED (no lock-out on rollout)', async () => {
    const r = await fsub.seedFromConfig();
    assert.equal(r.seeded, 2);
    const royal = await byName('The Royal Zone');
    assert.equal(royal.enabled, true);
    assert.equal(royal.chatId, String(CH.royal.id));
    assert.equal(royal.btn, '📢 Join The Royal Zone');
    assert.equal(royal.url, 'https://t.me/TheRoyalZone');
    const na = await byName('No Admin Chan');
    assert.equal(na.enabled, false);
    assert.equal(na.lastError, 'bot_not_admin');
    assert.equal(na.btn, '📢 Join No Admin Chan'); // defaults filled in
  });

  test('second start does nothing; a channel the admin deletes is never re-created', async () => {
    assert.equal((await fsub.seedFromConfig()).seeded, 0);
    const na = await byName('No Admin Chan');
    assert.equal((await fsub.deleteChannel(na.id)).ok, true);
    assert.equal((await fsub.seedFromConfig()).seeded, 0);
    assert.equal(await byName('No Admin Chan'), undefined);
    assert.equal((await fsub.listChannels()).length, 1);
  });
});

describe('admin access control', () => {
  test('Admin Panel shows the Force Subscribe section with every required button', async () => {
    let n = mark(); await say(ADMIN, '/admin');
    assert.ok(labels(n, ADMIN).includes('📢 Force Subscribe'));
    n = mark(); await tap(ADMIN, 'adm:fs');
    const l = labels(n, ADMIN);
    for (const t of ['➕ Add New Channel', '📋 Manage Channels', '✏️ Edit Channel', '🗑️ Remove Channel', '🔄 Refresh Channel List', '🔙 Back to Admin Panel']) assert.ok(l.includes(t), t);
  });

  test('non-admins are refused on every callback and typed answers change nothing', async () => {
    const before = JSON.stringify(await fsub.listChannels());
    const royal = await byName('The Royal Zone');
    setMember(CH.royal, NOADMIN); // a normal user who HAS joined: only the admin check stands between them and the settings
    for (const data of ['adm:fs', 'adm:fs:add', 'adm:fs:list:1', 'adm:fs:refresh', 'adm:fs:pick:e', 'adm:fs:pick:d', `adm:fs:v:${royal.id}`, `adm:fs:e:${royal.id}`,
      `adm:fs:t:${royal.id}`, `adm:fs:tv:${royal.id}`, `adm:fs:d:${royal.id}`, `adm:fs:dd:${royal.id}`, `adm:fs:ef:${royal.id}:b`, 'adm:fs:ok', 'adm:fs:ed', 'adm:fs:skip', 'adm:fs:back']) {
      const n = mark(); await tap(NOADMIN, data);
      assert.deepEqual(alerts(n), ['Not available.'], data);
      assert.equal(msgsTo(n, NOADMIN).length, 0, `${data} must not show anything`);
    }
    // forged wizard state for a non-admin is ignored
    await setAwait(NOADMIN, { kind: 'fs', mode: 'edit', id: royal.id, step: 'name' });
    const n = mark(); await say(NOADMIN, 'HACKED');
    assert.equal((await byName('The Royal Zone')).name, 'The Royal Zone');
    assert.match(lastText(n, NOADMIN), /Send me a file/);
    assert.equal(JSON.stringify(await fsub.listChannels()), before);
  });
});

describe('add channel (conversation)', () => {
  test('public channel: step by step, preview, confirm -> saved and active', async () => {
    let n = mark(); await tap(ADMIN, 'adm:fs:add');
    assert.match(lastText(n, ADMIN), /step 1\/5/);
    assert.ok(labels(n, ADMIN).includes('⬅️ Back') && labels(n, ADMIN).includes('✖️ Cancel'));
    n = mark(); await say(ADMIN, 'SM AI Updates');
    assert.match(lastText(n, ADMIN), /step 2\/5/);
    n = mark(); await say(ADMIN, '@SMAIUpdates');
    assert.match(lastText(n, ADMIN), /step 3\/5/);
    n = mark(); await say(ADMIN, '📢 Join SM AI Updates');
    assert.match(lastText(n, ADMIN), /step 4\/5/);
    n = mark(); await say(ADMIN, 'javascript:alert(1)'); // unsafe scheme is refused and the step repeats
    assert.match(lastText(n, ADMIN), /Only https/);
    assert.match(lastText(n, ADMIN), /step 4\/5/);
    n = mark(); await say(ADMIN, 'https://t.me/SMAIUpdates');
    assert.match(lastText(n, ADMIN), /step 5\/5/);
    assert.ok(labels(n, ADMIN).includes('⏭ Skip'));
    n = mark(); await tap(ADMIN, 'adm:fs:skip');
    const t = lastText(n, ADMIN);
    assert.match(t, /NEW FORCE SUBSCRIBE CHANNEL/); assert.match(t, /Channel: SM AI Updates/); assert.match(t, /Join Button: 📢 Join SM AI Updates/);
    assert.match(t, /Join URL: https:\/\/t\.me\/SMAIUpdates/); assert.match(t, /Status: Pending Verification/);
    for (const b of ['✅ Confirm & Save', '✏️ Edit Details', '❌ Cancel']) assert.ok(labels(n, ADMIN).includes(b), b);
    assert.equal(await byName('SM AI Updates'), undefined, 'nothing is stored before confirmation');
    n = mark(); await tap(ADMIN, 'adm:fs:ok');
    assert.match(lastText(n, ADMIN), /Channel saved/);
    const ch = await byName('SM AI Updates');
    assert.equal(ch.enabled, true); assert.equal(ch.chatId, String(CH.smai.id)); assert.equal(ch.ref, '@SMAIUpdates');
  });

  test('private channel: chat id + invite link + description', async () => {
    await tap(ADMIN, 'adm:fs:add');
    await say(ADMIN, 'Private Vault'); await say(ADMIN, String(CH.vault.id)); await say(ADMIN, '🔒 Join Vault'); await say(ADMIN, 'https://t.me/+AbCdEf12345');
    let n = mark(); await say(ADMIN, 'Members only <b>area</b>');
    assert.match(lastText(n, ADMIN), /Members only &lt;b&gt;area&lt;\/b&gt;/, 'user text is HTML-escaped');
    await tap(ADMIN, 'adm:fs:ok');
    const ch = await byName('Private Vault');
    assert.equal(ch.chatId, String(CH.vault.id)); assert.equal(ch.url, 'https://t.me/+AbCdEf12345'); assert.equal(ch.desc, 'Members only <b>area</b>'); assert.equal(ch.username, '');
  });

  test('duplicates are detected by the normalised chat id (username vs numeric id vs case)', async () => {
    await tap(ADMIN, 'adm:fs:add');
    await say(ADMIN, 'Dup'); await say(ADMIN, String(CH.royal.id)); await say(ADMIN, 'Join Dup'); await say(ADMIN, 'https://t.me/TheRoyalZone'); await tap(ADMIN, 'adm:fs:skip');
    let n = mark(); await tap(ADMIN, 'adm:fs:ok');
    assert.match(lastText(n, ADMIN), /Not saved/); assert.match(lastText(n, ADMIN), /already configured as “The Royal Zone”/);
    assert.equal((await fsub.listChannels()).filter((c) => c.chatId === String(CH.royal.id)).length, 1);
    // Edit Details -> change to the lower-case username of the same chat: still a duplicate
    await tap(ADMIN, 'adm:fs:ed'); await tap(ADMIN, 'adm:fs:edf:r'); await say(ADMIN, '@theroyalzone');
    n = mark(); await tap(ADMIN, 'adm:fs:ok');
    assert.match(lastText(n, ADMIN), /already configured/);
    await tap(ADMIN, 'adm:fs:cancel');
    assert.equal(await byName('Dup'), undefined);
  });

  test('validation against Telegram: bot not admin / unknown chat -> nothing saved', async () => {
    for (const [ref, expected] of [['@NoAdminChan', /must be an administrator/], ['@DoesNotExist1', /cannot find that chat/]]) {
      await tap(ADMIN, 'adm:fs:add');
      await say(ADMIN, 'Bad'); await say(ADMIN, ref); await say(ADMIN, 'Join Bad'); await say(ADMIN, 'https://t.me/BadChannel1'); await tap(ADMIN, 'adm:fs:skip');
      const n = mark(); await tap(ADMIN, 'adm:fs:ok');
      assert.match(lastText(n, ADMIN), expected);
      assert.ok(labels(n, ADMIN).includes('🔁 Try again'));
      await tap(ADMIN, 'adm:fs:cancel');
    }
    assert.equal(await byName('Bad'), undefined);
  });

  test('Back goes to the previous step; Cancel discards the draft', async () => {
    await tap(ADMIN, 'adm:fs:add'); await say(ADMIN, 'Temp');
    let n = mark(); await tap(ADMIN, 'adm:fs:back');
    assert.match(lastText(n, ADMIN), /step 1\/5/);
    n = mark(); await tap(ADMIN, 'adm:fs:cancel');
    assert.match(lastText(n, ADMIN), /Setup cancelled/);
    assert.equal(await fsub.getDraft(ADMIN), null);
    n = mark(); await say(ADMIN, 'some stray text'); // no longer in a prompt
    assert.match(lastText(n, ADMIN), /Send me a file/);
  });

  test('each admin has a separate conversation', async () => {
    await redis.set('x:probe', '1'); // sanity: Redis alive
    await fsub.saveDraft(ADMIN, { name: 'A-draft' });
    await fsub.saveDraft(1002, { name: 'B-draft' });
    assert.equal((await fsub.getDraft(ADMIN)).name, 'A-draft');
    assert.equal((await fsub.getDraft(1002)).name, 'B-draft');
    await fsub.clearDraft(ADMIN); await fsub.clearDraft(1002);
  });

  test('a fourth channel is added for the user tests', async () => {
    await tap(ADMIN, 'adm:fs:add');
    await say(ADMIN, 'Official Announcements'); await say(ADMIN, '@OfficialAnn'); await say(ADMIN, '📢 Join Official Announcements'); await say(ADMIN, 'https://t.me/OfficialAnn'); await tap(ADMIN, 'adm:fs:skip');
    await tap(ADMIN, 'adm:fs:ok');
    assert.equal((await byName('Official Announcements')).enabled, true);
    assert.equal((await fsub.listChannels()).length, 4);
  });
});

describe('manage channels', () => {
  test('list shows every channel with status and the four actions each', async () => {
    const n = mark(); await tap(ADMIN, 'adm:fs:list:1');
    const t = lastText(n, ADMIN);
    for (const name of ['The Royal Zone', 'SM AI Updates', 'Private Vault', 'Official Announcements']) assert.ok(t.includes(name), name);
    assert.match(t, /✅ Active/);
    for (const i of [1, 2, 3, 4]) for (const icon of ['👁', '✏️', '🔛', '🗑']) assert.ok(labels(n, ADMIN).includes(`${icon} ${i}`), `${icon} ${i}`);
  });

  test('view details runs a live bot-access check', async () => {
    const ch = await byName('SM AI Updates');
    let n = mark(); await tap(ADMIN, `adm:fs:v:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Bot access: ✅/);
    assert.match(lastText(n, ADMIN), /Chat ID: <code>-1001000000002<\/code>/);
    botStatus[CH.smai.id] = 'member'; // bot loses admin rights
    n = mark(); await tap(ADMIN, `adm:fs:v:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Bot access: ❌/);
    assert.match(lastText(n, ADMIN), /Needs attention/);
    botStatus[CH.smai.id] = 'administrator';
    n = mark(); await tap(ADMIN, 'adm:fs:refresh'); // refresh re-checks every channel and clears the warning
    assert.match(lastText(n, ADMIN), /Channel list refreshed/);
    assert.equal((await byName('SM AI Updates')).lastError, '');
  });

  test('edit button label, name and URL without redeploying; invalid values are rejected', async () => {
    const ch = await byName('SM AI Updates');
    await tap(ADMIN, `adm:fs:e:${ch.id}`);
    let n = mark(); await tap(ADMIN, `adm:fs:ef:${ch.id}:b`);
    assert.match(lastText(n, ADMIN), /Edit · Join button text/);
    n = mark(); await say(ADMIN, '🚀 Join SM AI now');
    assert.match(lastText(n, ADMIN), /Saved/);
    assert.equal((await fsub.getChannel(ch.id)).btn, '🚀 Join SM AI now');
    await tap(ADMIN, `adm:fs:ef:${ch.id}:u`);
    n = mark(); await say(ADMIN, 'https://evil.example/x');
    assert.match(lastText(n, ADMIN), /Only Telegram links/);
    assert.equal((await fsub.getChannel(ch.id)).url, 'https://t.me/SMAIUpdates', 'unchanged after a rejected value');
    n = mark(); await say(ADMIN, 'https://t.me/+NewInvite12345');
    assert.equal((await fsub.getChannel(ch.id)).url, 'https://t.me/+NewInvite12345');
    await tap(ADMIN, `adm:fs:ef:${ch.id}:n`); await say(ADMIN, 'SM AI Updates');
    assert.equal((await fsub.getChannel(ch.id)).name, 'SM AI Updates');
  });

  test('changing the channel ID is re-validated and cannot create a duplicate', async () => {
    const ch = await byName('SM AI Updates');
    await tap(ADMIN, `adm:fs:ef:${ch.id}:r`);
    let n = mark(); await say(ADMIN, '@NoAdminChan');
    assert.match(lastText(n, ADMIN), /must be an administrator/);
    n = mark(); await say(ADMIN, String(CH.royal.id));
    assert.match(lastText(n, ADMIN), /already configured as “The Royal Zone”/);
    assert.equal((await fsub.getChannel(ch.id)).chatId, String(CH.smai.id));
    await tap(ADMIN, `adm:fs:e:${ch.id}`); // leave the prompt
  });

  test('disable is immediate; re-enable requires working bot access', async () => {
    const ch = await byName('Private Vault');
    let n = mark(); await tap(ADMIN, `adm:fs:t:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Disabled/);
    assert.equal((await fsub.getChannel(ch.id)).enabled, false);
    assert.equal((await fsub.listChannels({ onlyActive: true })).some((c) => c.id === ch.id), false);
    botStatus[CH.vault.id] = 'member';
    n = mark(); await tap(ADMIN, `adm:fs:t:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Not changed/);
    assert.equal((await fsub.getChannel(ch.id)).enabled, false, 'refuses to enable a channel the bot cannot verify');
    botStatus[CH.vault.id] = 'administrator';
    n = mark(); await tap(ADMIN, `adm:fs:tv:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Enabled/);
    assert.equal((await fsub.getChannel(ch.id)).enabled, true);
  });

  test('delete asks for confirmation, removes only that channel', async () => {
    const ch = await byName('Private Vault');
    const others = (await fsub.listChannels()).filter((c) => c.id !== ch.id).map((c) => JSON.stringify(c));
    let n = mark(); await tap(ADMIN, `adm:fs:d:${ch.id}`);
    assert.match(lastText(n, ADMIN), /Delete “Private Vault”\?/);
    assert.ok(await fsub.getChannel(ch.id), 'still there until confirmed');
    n = mark(); await tap(ADMIN, `adm:fs:v:${ch.id}`); // Cancel returns to details
    assert.ok(await fsub.getChannel(ch.id));
    await tap(ADMIN, `adm:fs:dd:${ch.id}`);
    assert.equal(await fsub.getChannel(ch.id), null);
    assert.equal(await redis.exists(`fsub:ch:${ch.id}`), 0);
    assert.equal((await redis.zrange('fsub:ids', 0, -1)).includes(ch.id), false);
    assert.deepEqual((await fsub.listChannels()).map((c) => JSON.stringify(c)), others);
    n = mark(); await tap(ADMIN, `adm:fs:dd:${ch.id}`); // double tap is harmless
    assert.match(lastText(n, ADMIN), /no longer exists/);
  });
});

describe('users: membership enforcement', () => {
  // active now: The Royal Zone, SM AI Updates, Official Announcements
  test('a user who joined nothing gets a join button per channel + Verify, and cannot use anything', async () => {
    let n = mark(); await say(U1, '/start');
    assert.match(lastText(n, U1), new RegExp(JOIN));
    const urls = buttons(n, U1).filter((b) => b.url);
    assert.deepEqual(urls.map((b) => b.text), ['📢 Join The Royal Zone', '🚀 Join SM AI now', '📢 Join Official Announcements']);
    assert.ok(urls.every((b) => b.url.startsWith('https://t.me/')));
    assert.ok(labels(n, U1).includes('✅ Verify All Memberships'));

    n = mark(); await say(U1, '/help'); assert.match(lastText(n, U1), new RegExp(JOIN));
    n = mark(); await say(U1, '/files'); assert.match(lastText(n, U1), new RegExp(JOIN));
    n = mark(); await tap(U1, 'menu:home'); assert.match(lastText(n, U1), new RegExp(JOIN)); assert.deepEqual(alerts(n), ['🔒 Join the required channels first']);
    n = mark(); await upload(U1, 'secret.pdf');
    assert.match(lastText(n, U1), new RegExp(JOIN));
    assert.equal(copied(n).length, 0, 'the upload was NOT stored');
    n = mark(); await say(U1, '/privacy'); assert.doesNotMatch(lastText(n, U1), new RegExp(JOIN), 'privacy info stays reachable');
  });

  test('a burst of uploads from a blocked user gets one notice, nothing is stored', async () => {
    const n = mark();
    for (let i = 0; i < 5; i += 1) await upload(U3, `burst${i}.pdf`);
    assert.equal(msgsTo(n, U3).length, 1);
    assert.equal(copied(n).length, 0);
  });

  test('joining only some channels keeps the user restricted and names what is missing', async () => {
    setMember(CH.royal, U1);
    let n = mark(); await tap(U1, 'fs:verify');
    assert.match(alerts(n)[0], /Still missing: SM AI Updates, Official Announcements/);
    const t = lastText(n, U1);
    assert.match(t, /✅ <b>The Royal Zone<\/b> — joined/);
    assert.match(t, /❌ <b>SM AI Updates<\/b> — not joined yet/);
    assert.deepEqual(buttons(n, U1).filter((b) => b.url).map((b) => b.text), ['🚀 Join SM AI now', '📢 Join Official Announcements']);
    n = mark(); await say(U1, '/help'); assert.match(lastText(n, U1), new RegExp(JOIN));
  });

  test('joining every channel + Verify grants access; the pending deep link is offered', async () => {
    const payload = `f_${'A'.repeat(32)}`;
    await say(U2, `/start ${payload}`); // arrives before joining
    setMember(CH.royal, U2); setMember(CH.smai, U2, 'creator'); setMember(CH.news, U2, 'administrator');
    let n = mark(); await tap(U2, 'fs:verify');
    assert.match(lastText(n, U2), /Verified/);
    assert.equal(buttons(n, U2).find((b) => b.url)?.url, `https://t.me/Test_Vault_Bot?start=${payload}`);
    n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN));
    assert.ok(lastText(n, U2).length > 0);
    n = mark(); await tap(U2, 'menu:home'); assert.deepEqual(alerts(n), []);

    setMember(CH.smai, U1); setMember(CH.news, U1);
    n = mark(); await tap(U1, 'fs:verify'); assert.match(lastText(n, U1), /Verified/);
  });

  test('a user who leaves ANY required channel is blocked on the very next interaction; rejoining + Verify restores access', async () => {
    let n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN));
    leave(CH.smai, U2);
    n = mark(); await say(U2, '/help');
    assert.match(lastText(n, U2), new RegExp(JOIN));
    assert.match(lastText(n, U2), /❌ <b>SM AI Updates<\/b>/);
    assert.deepEqual(buttons(n, U2).filter((b) => b.url).map((b) => b.text), ['🚀 Join SM AI now']);
    n = mark(); await tap(U2, 'menu:home'); assert.match(lastText(n, U2), new RegExp(JOIN));
    setMember(CH.smai, U2);
    n = mark(); await tap(U2, 'fs:verify'); assert.match(lastText(n, U2), /Verified/);
    n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN));
  });

  test('status rules: left/kicked/restricted(is_member=false) denied; restricted(is_member=true) allowed', async () => {
    const ch = await byName('The Royal Zone');
    const probe = async (status, is_member) => { setMember(CH.royal, U3, status, is_member); return (await fsub.checkMembership(U3, ch)).state; };
    assert.equal(await probe('member'), 'member');
    assert.equal(await probe('administrator'), 'member');
    assert.equal(await probe('creator'), 'member');
    assert.equal(await probe('restricted', true), 'member');
    assert.equal(await probe('restricted', false), 'not_member');
    assert.equal(await probe('restricted', undefined), 'not_member');
    assert.equal(await probe('left'), 'not_member');
    assert.equal(await probe('kicked'), 'not_member');
    assert.equal(await probe('something_new'), 'not_member');
  });

  test('API / network / permission failures NEVER grant access and are reported as needing attention', async () => {
    const ch = await byName('SM AI Updates');
    for (const [failure, code] of [['NETWORK', 'network'], ['Bad Request: chat not found', 'not_found'], ['Forbidden: bot was kicked from the channel chat', 'no_access'], ['Bad Request: not enough rights', 'no_access']]) {
      failures.set(String(CH.smai.id), failure);
      const n = mark(); await say(U2, '/help');
      assert.match(lastText(n, U2), new RegExp(JOIN), failure);
      assert.match(lastText(n, U2), /⚠️ <b>SM AI Updates<\/b> — could not be verified/);
      assert.doesNotMatch(lastText(n, U2), /not enough rights|chat not found|Forbidden/, 'internal error details are not shown to users');
      assert.equal((await fsub.getChannel(ch.id)).lastError, code);
    }
    const view = mark(); await tap(ADMIN, `adm:fs:v:${ch.id}`); // admin screens still work while the channel is broken
    assert.match(lastText(view, ADMIN), /Needs attention|Bot access/);
    failures.delete(String(CH.smai.id));
    const n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN), 'recovers automatically');
    assert.equal((await fsub.getChannel(ch.id)).lastError, '');
  });

  test('admins and the owner are never blocked', async () => {
    const n = mark(); await say(ADMIN, '/start');
    assert.doesNotMatch(lastText(n, ADMIN), new RegExp(JOIN));
    assert.ok(labels(n, ADMIN).includes('🛡 Admin Panel'));
  });

  test('disabling a channel immediately removes it from verification; deleting it too', async () => {
    const smai = await byName('SM AI Updates');
    leave(CH.smai, U2);
    let n = mark(); await say(U2, '/help'); assert.match(lastText(n, U2), new RegExp(JOIN));
    await tap(ADMIN, `adm:fs:tv:${smai.id}`); // disable
    n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN), 'no longer mandatory');
    await tap(ADMIN, `adm:fs:tv:${smai.id}`); // re-enable
    n = mark(); await say(U2, '/help'); assert.match(lastText(n, U2), new RegExp(JOIN), 'mandatory again');
    await tap(ADMIN, `adm:fs:dd:${smai.id}`); // delete
    n = mark(); await say(U2, '/help'); assert.doesNotMatch(lastText(n, U2), new RegExp(JOIN));
    assert.equal((await fsub.listChannels()).length, 2);
  });

  test('with no active channel the bot works as before for everyone', async () => {
    for (const c of await fsub.listChannels()) await tap(ADMIN, `adm:fs:tv:${c.id}`);
    assert.equal((await fsub.listChannels({ onlyActive: true })).length, 0);
    const n = mark(); await say(9999, '/help'); assert.doesNotMatch(lastText(n, 9999), new RegExp(JOIN));
    assert.equal(since(n).filter((c) => c.method === 'getChatMember').length, 0, 'no Telegram call when nothing is mandatory');
  });
});

describe('persistence', () => {
  test('configuration lives in Redis: a freshly loaded module (simulated restart) sees every channel and its settings', async () => {
    const before = await fsub.listChannels();
    const reloaded = await import('../src/services/forceSubscribe.js?restart=1');
    assert.notEqual(reloaded, fsub);
    assert.deepEqual(await reloaded.listChannels(), before);
    assert.ok(before.length >= 2 && before.every((c) => c.chatId && c.url && c.btn));
  });

  test('channels are part of backups (authoritative keys)', async () => {
    const { buffer, counts } = await backup.createBackup({ reason: 'test' });
    assert.ok(counts.fsub >= 3, JSON.stringify(counts)); // channel hashes + index
    const { entries } = backup.parseBackup(buffer);
    assert.ok(entries.some((e) => e.k === 'fsub:ids'));
    assert.ok(entries.some((e) => e.k.startsWith('fsub:ch:')));
    assert.ok(!entries.some((e) => /^fsub:(ok|draft|pending):/.test(e.k)), 'transient keys are not backed up');
  });
});

test.after(async () => { await redis.quit().catch(() => {}); });
