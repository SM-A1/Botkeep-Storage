// Latency benchmark: simulated slow Redis (point VAULT_TEST_REDIS_URL at a delaying proxy) and slow Telegram API.
//   VAULT_TEST_REDIS_URL=redis://host:port/15 TG_DELAY_MS=120 UPLOAD_MS=4000 node tests/latency.bench.js
// Uses the real polling path (@grammyjs/runner when installed). FLUSHES the target database!
import { performance } from 'node:perf_hooks';
if (!process.env.VAULT_TEST_REDIS_URL) { console.error('Set VAULT_TEST_REDIS_URL (throw-away database, it is flushed).'); process.exit(1); }
Object.assign(process.env, {
  BOT_TOKEN: '123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1', REDIS_URL: process.env.VAULT_TEST_REDIS_URL,
  STORAGE_CHANNEL_ID: '-1001234567890', ADMIN_IDS: '1001', BOT_USERNAME: 'Test_Vault_Bot', LOG_LEVEL: 'error',
  MAX_CALLBACKS_PER_MINUTE: '0', MAX_UPLOADS_PER_MINUTE: '0', MAX_DOWNLOADS_PER_MINUTE: '0', MAX_STARTS_PER_MINUTE: '0', BACKUP_INTERVAL_HOURS: '0',
});
const TG = Number(process.env.TG_DELAY_MS ?? 120);
const UPLOAD = Number(process.env.UPLOAD_MS ?? 4000);
const { redis, connectRedis } = await import('../src/services/redis.js');
await connectRedis();
await redis.flushdb();
await redis.set('meta:schema', '2');
await redis.set('meta:dbid', 'benchbenchbench00');
const { bot } = await import('../src/services/telegram.js');
const { registerBot } = await import('../src/bot/index.js');
const { createFile } = await import('../src/services/files.js');

const queue = [];
let wake = () => {};
let seq = 1000;
const sentAt = new Map();
const answeredAt = new Map();
const chatToUpdate = new Map();
bot.botInfo = { id: 1, is_bot: true, first_name: 'V', username: 'Test_Vault_Bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
bot.api.config.use(async (_p, method, payload) => {
  if (method === 'getUpdates') {
    // like real long polling: returns as soon as an update exists (or after a short idle timeout)
    if (queue.length === 0) await Promise.race([new Promise((r) => { wake = r; }), new Promise((r) => setTimeout(r, 300))]);
    return { ok: true, result: queue.splice(0, 100) };
  }
  const slow = method === 'copyMessage' && Number(payload.chat_id) === -1001234567890;
  await new Promise((r) => setTimeout(r, slow ? UPLOAD : TG));
  const uid = chatToUpdate.get(Number(payload.chat_id));
  if (uid && !answeredAt.has(uid) && ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(method)) answeredAt.set(uid, performance.now());
  return { ok: true, result: ['answerCallbackQuery', 'deleteMessage', 'sendChatAction'].includes(method) ? true : { message_id: ++seq, date: 0, chat: { id: payload.chat_id, type: 'private' } } };
});
registerBot(bot);

let uid = 0; let mid = 100;
const user = (id) => ({ id, is_bot: false, first_name: `U${id}` });
function push(update, userId) { update.update_id = ++uid; sentAt.set(uid, performance.now()); chatToUpdate.set(userId, uid); queue.push(update); wake(); return uid; }
const cmd = (id, text) => push({ message: { message_id: ++mid, date: 0, chat: { id, type: 'private' }, from: user(id), text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } }, id);
const tap = (id, data) => push({ callback_query: { id: String(++mid), from: user(id), chat_instance: 'c', data, message: { message_id: 9, date: 0, chat: { id, type: 'private' }, text: 'x' } } }, id);
const doc = (id, name) => push({ message: { message_id: ++mid, date: 0, chat: { id, type: 'private' }, from: user(id), document: { file_id: `tgfile${mid}`, file_unique_id: 'u', file_name: name, mime_type: 'application/pdf', file_size: 1e6 } } }, id);
const wait = async (id) => { for (let i = 0; i < 2000 && !answeredAt.has(id); i += 1) await new Promise((r) => setTimeout(r, 5)); return answeredAt.has(id) ? Math.round(answeredAt.get(id) - sentAt.get(id)) : null; };

let stop = async () => {};
try {
  const { run } = await import('@grammyjs/runner');
  const handle = run(bot, { runner: { fetch: { allowed_updates: ['message', 'callback_query'] } } });
  stop = async () => { if (handle.isRunning()) await handle.stop(); };
  console.log('polling: @grammyjs/runner (concurrent)');
} catch {
  bot.start({ allowed_updates: ['message', 'callback_query'] });
  stop = async () => bot.stop();
  console.log('polling: bot.start() (SEQUENTIAL: one update at a time)');
}
await new Promise((r) => setTimeout(r, 300));

const f = await createFile({ fileId: 'tgfile1', messageId: 11, name: 'report.pdf', type: 'document', size: 1000, mime: 'application/pdf', uploaderId: 3001 });
const t = {};
for (const [name, send] of [
  ['/start (new user)', () => cmd(3001, '/start')],
  ['tap My Files', () => tap(3001, 'files:1')],
  ['tap open file card', () => tap(3001, `open:${f.id}`)],
  ['tap Share menu', () => tap(3001, `sh:${f.id}`)],
  ['tap Storage', () => tap(3001, 'menu:storage')],
]) { answeredAt.clear(); t[name] = `${await wait(send())} ms`; await new Promise((r) => setTimeout(r, 200)); }
console.log(`(floor = one Telegram call = ${TG} ms)`);
console.table(t);

doc(3002, 'big.pdf');
await new Promise((r) => setTimeout(r, 150));
const other = cmd(3003, '/start');
const other2 = tap(3001, 'files:1');
const [a, b] = await Promise.all([wait(other), wait(other2)]);
console.log(`while another user's ${UPLOAD} ms upload runs -> other users wait: /start ${a} ms, button ${b} ms`);
await stop();
await redis.quit();
process.exit(0);
