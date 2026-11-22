import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdminRepository, runAdminAction } from '../../scripts/news/bridge/admin-actions.mjs';

const oldRepo = 'sustynats/wirkungsoekonomie.de';
const newRepo = 'sustynats/wirkungsoekonomie-produktiv';

test('repository selection is bounded and cannot silently target another runtime', () => {
  assert.equal(resolveAdminRepository({}), oldRepo);
  assert.equal(resolveAdminRepository({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: newRepo }), newRepo);
  assert.equal(resolveAdminRepository({ WOEK_NEWS_REPOSITORY: newRepo }), newRepo);
  assert.throws(() => resolveAdminRepository({ GITHUB_ACTIONS: 'true' }), /BRIDGE_RUNTIME_REPOSITORY_REQUIRED/);
  assert.throws(() => resolveAdminRepository({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: oldRepo, WOEK_NEWS_REPOSITORY: newRepo }), /BRIDGE_RUNTIME_REPOSITORY_MISMATCH/);
  assert.throws(() => resolveAdminRepository({ WOEK_NEWS_REPOSITORY: 'other/repo' }), /BRIDGE_REPOSITORY_INVALID/);
});

test('an active old-repository worker prevents any new dispatch', async () => {
  const calls = [];
  const result = await runAdminAction('IMPORT_NOW', { repo: newRepo, log: () => {}, watch: () => assert.fail('must not watch'), gh: async args => {
    calls.push(args); return JSON.stringify([{ status: args.at(-1), url: 'https://example.org/run' }]);
  } });
  assert.equal(result.status, 'RUN_ALREADY_ACTIVE');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(oldRepo));
  assert.equal(calls[0][0], 'run');
});

test('an active new-repository worker also prevents a duplicate dispatch', async () => {
  const calls = [];
  const result = await runAdminAction('IMPORT_NOW', { repo: newRepo, log: () => {}, watch: () => assert.fail('must not watch'), gh: async args => {
    calls.push(args);
    return args.includes(oldRepo) ? '[]' : JSON.stringify([{ status: args.at(-1), url: 'https://example.org/run' }]);
  } });
  assert.equal(result.status, 'RUN_ALREADY_ACTIVE');
  assert.equal(calls.length, 11);
  assert.ok(calls[10].includes(newRepo));
  assert.ok(calls.every(args => args[0] === 'run'));
});

test('inaccessible new repository or uncertain state prevents dispatch', async () => {
  let writes = 0;
  const deps = { repo: newRepo, log: () => {}, watch: () => assert.fail('must not watch'), gh: async args => {
    if (args[0] === 'workflow') writes++;
    if (args.includes(newRepo)) throw Error('access unavailable');
    return '[]';
  } };
  await assert.rejects(runAdminAction('IMPORT_NOW', deps), /access unavailable/);
  assert.equal(writes, 0);
  await assert.rejects(runAdminAction('IMPORT_NOW', { ...deps, gh: async () => JSON.stringify([{ status: 'unknown' }]) }), /BRIDGE_RUN_STATUS_UNCERTAIN/);
  await assert.rejects(runAdminAction('IMPORT_NOW', { ...deps, gh: async () => JSON.stringify(Array.from({length:100}, () => ({status:'queued'}))) }), /BRIDGE_RUN_LIST_UNCERTAIN/);
});

test('new dispatch reads both repositories and remains serial', async () => {
  const events = []; let request;
  const result = await runAdminAction('IMPORT_NOW', { repo: newRepo, log: () => {}, watch: async (id, repo) => events.push(`watch:${id}:${repo}`), gh: async args => {
    if (args[0] === 'workflow') { request = args.at(-1).slice('request_id='.length); events.push('dispatch'); return ''; }
    if (args.includes('--status')) { events.push(`read:${args[args.indexOf('--repo')+1]}`); return '[]'; }
    return JSON.stringify([{databaseId: 42, displayTitle: request, url: 'https://example.org/run'}]);
  } });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(events, [...Array(10).fill(`read:${oldRepo}`), ...Array(10).fill(`read:${newRepo}`), 'dispatch', `watch:42:${newRepo}`]);
});
