// Regression tests for the "bot is slow / deaf after being idle" bug. No Redis or real Telegram needed.
//   npm run test:polling           (fast)
//   SLOW_TESTS=1 npm run test:polling   (also waits ~31 s to prove a hung sendMessage is still cut off at 30 s)
//
// The REAL `bot` from src/services/telegram.js is pointed at a local fake Telegram API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

Object.assign(process.env, {
  BOT_TOKEN: '123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN1', REDIS_URL: 'redis://127.0.0.1:6399',
  STORAGE_CHANNEL_ID: '-1001234567890', ADMIN_IDS: '1001', BOT_USERNAME: 'Test_Vault_Bot', LOG_LEVEL: 'error',
});

// Redirect grammY's HTTP client (node-fetch) from api.telegram.org to the fake server.
const require = createRequire(import.meta.url);
const nodeFetch = require('node-fetch');
const realFetch = nodeFetch.default;
let fakeRoot = '';
nodeFetch.default = (url, { agent, ...opts } = {}) => realFetch(String(url).replace('https://api.telegram.org', fakeRoot), opts); // drop grammY's https agent

let holdMs = 0; // how long the fake API holds each request before answering
const calls = [];
const server = http.createServer((req, res) => {
  const method = req.url.split('/').pop();
  calls.push(method);
  req.resume();
  req.on('end', () => {
    const timer = setTimeout(() => {
      if (res.writableEnded) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } }));
    }, holdMs);
    res.on('close', () => clearTimeout(timer));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
fakeRoot = `http://127.0.0.1:${server.address().port}`;
const { bot } = await import('../src/services/telegram.js');

test.after(() => { server.closeAllConnections(); server.close(); });

test('an idle long poll that is answered right AFTER the poll timeout is not aborted client-side', async () => {
  holdMs = 3_050; // Telegram answers just after the 3 s long-poll timeout, exactly like an idle real poll
  const t0 = Date.now();
  const updates = await bot.api.getUpdates({ timeout: 3, offset: 0, limit: 100 });
  assert.deepEqual(updates, []);
  assert.ok(Date.now() - t0 >= 3_000);
});

test('the real long-poll timeout (30 s) is below the client timeout, so polls cannot race it', async () => {
  // grammY keeps the value in the client options; assert via behaviour: a 31 s hold must still succeed for getUpdates.
  if (!process.env.SLOW_TESTS) return;
  holdMs = 31_000;
  const updates = await bot.api.getUpdates({ timeout: 30, offset: 0, limit: 100 });
  assert.deepEqual(updates, []);
});

test('normal API calls still work through the per-call timeout wrapper', async () => {
  holdMs = 0;
  const res = await bot.api.sendMessage(1, 'hello');
  assert.equal(res.message_id, 1);
});

test('a caller-supplied abort signal still cancels a normal API call', async () => {
  holdMs = 5_000;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(bot.api.sendMessage(1, 'x', undefined, ctrl.signal));
  assert.ok(Date.now() - t0 < 2_000);
});

test('each attempt of a hung normal API call is cut off after 30 s (unchanged behaviour)', { skip: !process.env.SLOW_TESTS }, async () => {
  holdMs = 120_000;
  const stamps = [];
  server.on('request', (req) => { if (req.url.endsWith('/sendMessage')) stamps.push(Date.now()); });
  const ctrl = new AbortController();
  const call = bot.api.sendMessage(1, 'x', undefined, ctrl.signal).catch(() => {});
  while (stamps.length < 2) await new Promise((r) => setTimeout(r, 200)); // autoRetry re-sends after the abort
  ctrl.abort();
  await call;
  const gap = stamps[1] - stamps[0];
  assert.ok(gap >= 29_000 && gap < 36_000, `first attempt was aborted after ${gap} ms`);
});
