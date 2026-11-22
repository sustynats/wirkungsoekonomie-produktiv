import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fetchPublicArtifact} from '../../scripts/wirkungslexikon/public-fetch.mjs';

async function serverFor(statuses, fn) {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    const status = statuses[Math.min(requests++, statuses.length - 1)];
    response.writeHead(status, {'connection': 'close'});
    response.end(status === 200 ? 'synthetic artifact' : 'unavailable');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/synthetic`;
    await fn(url, () => requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const immediate = async () => {};

test('a temporary 504 is followed by one successful HTTP GET', async () => {
  await serverFor([504, 200], async (url, count) => {
    const response = await fetchPublicArtifact(url, {wait: immediate});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'synthetic artifact');
    assert.equal(count(), 2);
  });
});

test('authentication and missing responses are not retried', async () => {
  for (const status of [401, 403, 404]) {
    await serverFor([status, 200], async (url, count) => {
      const response = await fetchPublicArtifact(url, {wait: immediate});
      assert.equal(response.status, status);
      assert.equal(count(), 1);
      await response.body?.cancel();
    });
  }
  let attempts = 0;
  await assert.rejects(fetchPublicArtifact('https://unused.invalid', {fetcher: async () => { attempts++; throw new Error('synthetic network error'); }, wait: immediate}), /synthetic network error/);
  assert.equal(attempts, 1);
});

test('three persistent 504 responses are the maximum', async () => {
  await serverFor([504], async (url, count) => {
    const response = await fetchPublicArtifact(url, {wait: immediate});
    assert.equal(response.status, 504);
    assert.equal(count(), 3);
    await response.body?.cancel();
  });
});

const publicArtifact = 'https://github.com/sustynats/wirkungsoekonomie.de/releases/download/wirkungslexikon-v10-20261016-journal-r4/wirkungslexikon-public-v10-20261016-journal-r4.tar.gz';

test('three explicit temporary responses trigger one exact public gh fallback', async () => {
  let requests = 0;
  const calls = [];
  const response = await fetchPublicArtifact(publicArtifact, {
    fetcher: async () => { requests++; return new Response(null, {status: 504}); },
    wait: immediate,
    runGh: async (parts) => { calls.push(parts); return Buffer.from('synthetic artifact'); },
  });
  assert.equal(requests, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {tag:'wirkungslexikon-v10-20261016-journal-r4', filename:'wirkungslexikon-public-v10-20261016-journal-r4.tar.gz'});
  assert.equal(await response.text(), 'synthetic artifact');
});

test('invalid release URLs and nontransient errors never invoke gh', async () => {
  for (const url of [publicArtifact+'?secret=not-allowed', publicArtifact+'#fragment', publicArtifact.replace('sustynats/','elsewhere/'), publicArtifact.replace('/download/wirkungslexikon-', '/download/../wirkungslexikon-'), publicArtifact.replace('github.com','github.com.evil.invalid')]) {
    let calls = 0, requests = 0;
    const response = await fetchPublicArtifact(url, {fetcher: async () => { requests++; return new Response(null,{status:504}); }, wait: immediate, runGh: async () => { calls++; throw new Error('must not be called'); }});
    assert.equal(response.status, 504);
    assert.equal(requests, 3);
    assert.equal(calls, 0);
  }
  for (const status of [401, 403, 404]) {
    let calls = 0, requests = 0;
    const response = await fetchPublicArtifact(publicArtifact, {fetcher: async () => { requests++; return new Response(null,{status}); }, wait: immediate, runGh: async () => { calls++; throw new Error('must not be called'); }});
    assert.equal(response.status, status);
    assert.equal(requests, 1);
    assert.equal(calls, 0);
  }
  let calls = 0, requests = 0;
  await assert.rejects(fetchPublicArtifact(publicArtifact, {fetcher: async () => { requests++; throw new Error('synthetic network failure'); }, wait: immediate, runGh: async () => { calls++; }}), /synthetic network failure/);
  assert.equal(requests, 1);
  assert.equal(calls, 0);
});

test('gh fallback error is generic and never retried', async () => {
  let calls = 0, requests = 0;
  await assert.rejects(fetchPublicArtifact(publicArtifact, {fetcher: async () => { requests++; return new Response(null,{status:503}); }, wait: immediate, runGh: async () => { calls++; throw new Error('synthetic sensitive detail'); }}), (error) => error.message === 'LEXIKON_PUBLIC_RELEASE_FALLBACK_UNAVAILABLE');
  assert.equal(requests, 3);
  assert.equal(calls, 1);
});

test('a hung gh fallback is killed at the deadline and reports only a generic error', async () => {
  const {EventEmitter} = await import('node:events');
  const {PassThrough} = await import('node:stream');
  const {downloadPublicRelease} = await import('../../scripts/wirkungslexikon/public-fetch.mjs');
  const child = new EventEmitter(); child.stdout = new PassThrough();
  const signals = []; child.kill = (signal) => { signals.push(signal); child.emit('close', 0); return true; };
  let command, args;
  await assert.rejects(downloadPublicRelease({tag:'synthetic-tag', filename:'wirkungslexikon-public-synthetic.tar.gz'}, {
    timeoutMs:5,
    spawnProcess: (exe, argv) => { command=exe; args=argv; return child; },
  }), (error) => error.message === 'LEXIKON_PUBLIC_RELEASE_FALLBACK_UNAVAILABLE');
  assert.equal(command, 'gh');
  assert.deepEqual(args, ['release','download','synthetic-tag','--repo','sustynats/wirkungsoekonomie.de','--pattern','wirkungslexikon-public-synthetic.tar.gz','--output','-']);
  assert.deepEqual(signals, ['SIGKILL']);
  child.emit('close', 0);
});

test('gh fallback stops before accumulating more than the pinned artifact byte limit', async () => {
  const {EventEmitter} = await import('node:events');
  const {downloadPublicRelease} = await import('../../scripts/wirkungslexikon/public-fetch.mjs');
  const child = new EventEmitter(); child.stdout = new EventEmitter();
  const signals = []; child.kill = (signal) => { signals.push(signal); child.emit('close', 0); return true; };
  const pending = downloadPublicRelease({tag:'synthetic-tag', filename:'wirkungslexikon-public-synthetic.tar.gz'}, {spawnProcess: () => child});
  child.stdout.emit('data', Buffer.alloc(77489996));
  child.stdout.emit('data', Buffer.from('x'));
  await assert.rejects(pending, (error) => error.message === 'LEXIKON_PUBLIC_RELEASE_FALLBACK_UNAVAILABLE');
  assert.deepEqual(signals, ['SIGKILL']);
  child.emit('close', 0);
});
