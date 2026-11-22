import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../scripts/news/bridge/server.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const secret = 'fixture-'.repeat(8);

function harness(completed) {
  let handler;
  const calls = [];
  class Store {
    constructor(_file, { lane }) { this.lane = lane; this.locked = true; this.current = { owner: '123456:1' }; }
    observation() { return this.current; }
    release(value) { calls.push(['release', value]); this.locked = false; }
    acquire(...args) { calls.push(['acquire', ...args]); this.locked = true; }
    observe(key, value) { calls.push(['observe', key, value]); this.current = value; }
    close() {}
  }
  vm.runInNewContext(source, {
    http: { createServer(fn) { handler = fn; return { listen() {}, close() {} }; } },
    fs: { readFileSync() { return secret; } }, path: { isAbsolute: () => true, join: (...a) => a.join('/') },
    timingSafeEqual: (a, b) => a.equals(b), BridgeStore: Store, DropboxTransport: class {}, loadDropboxCredentials: () => ({}),
    JOB_ID: /^wt_/, outputStatus: () => {}, monitorStatus: () => {}, Buffer, AbortSignal,
    process: { env: { WOEK_NEWS_BRIDGE_DIRECTORY: '/private/fixture' }, cwd: () => '/fixture', on() {} },
    ownerCompleted: async owner => { calls.push(['ownerCompleted', owner]); return completed; },
  });
  return { calls, async acquire() {
    const req = { method: 'POST', url: '/api/news-bridge', headers: { authorization: `Bearer ${secret}`, 'x-bridge-lane': 'import', 'x-bridge-owner': '999:1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ op: 'store.acquire', args: ['fixture-time', 'import'] })); } };
    let status, result;
    await handler(req, { writeHead(value) { status = value; }, end(body) { result = JSON.parse(body); } });
    return { status, result };
  } };
}

test('an unverified owner cannot release or replace the existing lock', async () => {
  const h = harness(false), result = await h.acquire();
  assert.equal(result.status, 409);
  assert.equal(result.result.error, 'BRIDGE_RUN_LOCKED');
  assert.deepEqual(h.calls, [['ownerCompleted', '123456:1']]);
});

test('a verified completed owner is released before the new owner is acquired', async () => {
  const h = harness(true), result = await h.acquire();
  assert.equal(result.status, 200);
  assert.equal(result.result.ok, true);
  assert.deepEqual(h.calls.map(x => x[0]), ['ownerCompleted', 'release', 'observe', 'acquire', 'observe']);
  assert.equal(h.calls[1][1], false);
});
