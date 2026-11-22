import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerCompleted } from '../../scripts/news/bridge/owner-completion.mjs';

const oldRepo = 'sustynats/wirkungsoekonomie.de';
const newRepo = 'sustynats/wirkungsoekonomie-produktiv';
const owner = '123456:2';
const token = 'synthetic-unit-test-only';
const ok = (name, status = 'completed', id = 123456) => ({ ok: true, async json() { return { id, status, repository: { full_name: name } }; } });
const absent = { ok: false, status: 404 };

test('legacy completed owner remains verifiable without any token', async () => {
  let calls = 0;
  assert.equal(await ownerCompleted(owner, { privateReadToken: null, fetchImpl: async (url, options) => {
    calls++; assert.ok(url.includes(`/${oldRepo}/`)); assert.equal(options.headers.Authorization, undefined); return ok(oldRepo);
  }}), true);
  assert.equal(calls, 1);
});

test('active legacy owner never yields its lock', async () => {
  let calls = 0;
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => { calls++; return ok(oldRepo, 'in_progress'); } }), false);
  assert.equal(calls, 1);
});

test('new private completed run requires an authorized and exact repository response', async () => {
  const calls = [];
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return calls.length === 1 ? absent : ok(newRepo);
  }}), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, undefined);
  assert.ok(calls[1].url.includes(`/${newRepo}/`));
  assert.equal(calls[1].authorization, `Bearer ${token}`);
});

test('a new private owner that is still active retains the lock', async () => {
  let calls = 0;
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => {
    calls++; return calls === 1 ? absent : ok(newRepo, 'in_progress');
  }}), false);
  assert.equal(calls, 2);
});

test('inaccessible private runs, HTTP errors and network errors retain the lock', async () => {
  assert.equal(await ownerCompleted(owner, { privateReadToken: null, fetchImpl: async () => absent }), false);
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => ({ ok: false, status: 403 }) }), false);
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => { throw Error('network'); } }), false);
});

test('wrong run, wrong repository, malformed JSON and unsafe IDs cannot release a lock', async () => {
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => ok(oldRepo, 'completed', 7) }), false);
  assert.equal(await ownerCompleted(owner, { privateReadToken: token, fetchImpl: async () => ok(newRepo) }), false);
  assert.equal(await ownerCompleted(owner, { privateReadToken: null, fetchImpl: async () => ({ ok: true, async json() { throw Error('invalid'); } }) }), false);
  let calls = 0;
  assert.equal(await ownerCompleted('../42:1', { privateReadToken: token, fetchImpl: async () => { calls++; return ok(oldRepo); } }), false);
  assert.equal(calls, 0);
  assert.equal(await ownerCompleted('9007199254740992:1', { privateReadToken: null, fetchImpl: async () => ok(oldRepo, 'completed', 9007199254740992) }), false);
});
