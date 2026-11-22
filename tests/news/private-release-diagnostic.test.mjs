import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {DATA_REPOSITORY, RELEASE_PART_FORMAT, RELEASE_STORE_FORMAT, partDigest,
  releasePartUrl, downloadReleasePart, privateDownloadFailureDiagnostic} from '../../scripts/news/release-part.mjs';
import {downloadHydrationPart, hydrationFailureDiagnostic} from '../../scripts/news/release-hydrate.mjs';

const sensitive = 'SENSITIVE_VALUE_MUST_NOT_LEAK';
const raw = Buffer.from('{"stories":[]}'), zipped = gzipSync(raw);
const part = {sha256: partDigest(raw), bytes: raw.length, release: {
  repository: DATA_REPOSITORY, storage_format: RELEASE_PART_FORMAT,
  tag: 'wirkungsticker-data-2026-11', asset: `${partDigest(raw)}.json.gz`,
  sha256: partDigest(zipped), bytes: zipped.length
}};
const url = releasePartUrl(part);
const childError = fields => Object.assign(Error(sensitive), {cause: Error(sensitive), ...fields});
const absentFields = {exit_status: null, native_code: 'NONE', stderr_shape: 'NONE',
  killed: false, signal: 'NONE', fields_state: 'INVALID'};
const cases = [
  ['standard gh HTTP 403 buffer', {code: 1, stderr: Buffer.from(`HTTP 403: ${sensitive} (https://example.invalid/${sensitive})\n`)}, 'HTTP_403'],
  ['standard gh HTTP 404 string', {code: 1, stderr: `gh: ${sensitive} (HTTP 404)\n`}, 'HTTP_404'],
  ['private HTTP 502', {code: 1, stderr: `HTTP 502: ${sensitive}\n`}, 'HTTP_502'],
  ['bounded output failure', {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM'}, 'OUTPUT_LIMIT'],
  ['missing executable', {code: 'ENOENT'}, 'CLIENT_MISSING'],
  ['terminated subprocess', {code: null, killed: true, signal: 'SIGTERM'}, 'TERMINATED_UNKNOWN'],
  ['ambiguous HTTP statuses', {code: 1, stderr: 'HTTP 403: unknown (HTTP 404)'}, 'UNKNOWN'],
  ['multiple diagnostic lines', {code: 1, stderr: 'HTTP 403: first\nHTTP 403: second'}, 'UNKNOWN'],
  ['nonstandard HTTP mention', {code: 1, stderr: `diagnostic ${sensitive} HTTP 403`}, 'UNKNOWN'],
  ['mixed code type', {code: '1', stderr: 'HTTP 403: failure'}, 'UNKNOWN'],
  ['sync numeric exit status', {status: 1, stderr: 'HTTP 403: failure'}, 'HTTP_403'],
  ['contradictory exit fields', {code: 1, status: 2, stderr: 'HTTP 403: failure'}, 'UNKNOWN'],
  ['contradictory native and exit fields', {code: 'ENOBUFS', status: 1}, 'UNKNOWN'],
  ['mixed status type', {status: '1', stderr: 'HTTP 403: failure'}, 'UNKNOWN'],
  ['mixed stderr type', {code: 1, stderr: {toString: () => 'HTTP 403: failure'}}, 'UNKNOWN'],
  ['mixed signal type', {code: 1, signal: 15, stderr: 'HTTP 403: failure'}, 'UNKNOWN'],
  ['oversized diagnostic', {code: 1, stderr: `HTTP 403: ${'x'.repeat(8192)}`}, 'UNKNOWN'],
  ['standard HTTP with context lines', {code: 1, stderr: `${sensitive}\nHTTP 403: denied\ncontext ${sensitive}\n`}, 'HTTP_403'],
  ['standard gh suffix with context lines', {status: 1, stderr: `context ${sensitive}\ngh: denied (HTTP 404)\n`}, 'HTTP_404'],
  ['two statuses across context', {code: 1, stderr: 'HTTP 403: denied\ncontext HTTP 500'}, 'UNKNOWN'],
  ['unverified wrapper prefix', {code: 1, stderr: 'error fetching release: HTTP 403: denied'}, 'UNKNOWN'],
  ['oversized stderr keeps native async output limit', {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, stderr: sensitive.repeat(8192)}, 'OUTPUT_LIMIT'],
  ['oversized stderr keeps native sync output limit', {code: 'ENOBUFS', signal: 'SIGTERM', stderr: Buffer.alloc(16384)}, 'OUTPUT_LIMIT'],
  ['oversized stderr keeps missing executable', {code: 'ENOENT', stderr: sensitive.repeat(8192)}, 'CLIENT_MISSING'],
  ['oversized stderr cannot excuse conflicting fields', {code: 'ENOBUFS', status: 1, stderr: sensitive.repeat(8192)}, 'UNKNOWN'],
  ['numeric exit and termination contradict', {code: 1, killed: true, stderr: 'HTTP 403: denied'}, 'UNKNOWN'],
  ['invalid UTF8 is not HTTP evidence', {code: 1, stderr: Buffer.concat([Buffer.from('HTTP 403: '), Buffer.from([255])])}, 'UNKNOWN'],
  ['exact gh release-not-found message', {code: 1, stderr: 'release not found\n'}, 'RELEASE_NOT_FOUND'],
  ['exact gh no-pattern-match message', {status: 1, stderr: 'no assets match the file pattern\n'}, 'ASSET_PATTERN_NO_MATCH'],
  ['exact gh no-assets message', {code: 1, stderr: 'no assets to download\n'}, 'NO_ASSETS'],
  ['quoted gh message in context is unknown', {code: 1, stderr: `context: no assets to download ${sensitive}`}, 'UNKNOWN'],
  ['arbitrary native code is not copied', {code: sensitive, stderr: sensitive}, 'UNKNOWN'],
  ['arbitrary signal is not copied', {signal: sensitive, killed: true}, 'TERMINATED_UNKNOWN'],
  ['unknown client failure', {}, 'UNKNOWN']
];

for (const [name, fields, expected] of cases) {
  test(`${name}: sync and async preserve one attempt and emit only a safe category`, async () => {
    let syncCalls = 0, asyncCalls = 0;
    const check = error => {
      assert.equal(error.message, 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE');
      assert.equal(error.category, expected);
      assert.equal(error.phase, 'private_release_download');
      assert.ok(error.exit_status === null || Number.isInteger(error.exit_status));
      assert.equal(typeof error.killed, 'boolean');
      assert.match(error.stderr_shape, /^(NONE|SINGLE_LINE|MULTILINE|OVERSIZED|INVALID)$/);
      assert.match(error.fields_state, /^(VALID|INVALID|CONFLICT)$/);
      for (const key of ['stderr', 'stdout', 'cause', 'cmd', 'path', 'spawnargs']) assert.equal(Object.hasOwn(error, key), false);
      assert.equal(String(error.stack).includes(sensitive), false);
      const output = JSON.stringify(hydrationFailureDiagnostic(error));
      assert.equal(output.includes(sensitive), false);
      assert.equal(output.includes('https://'), false);
      return true;
    };
    assert.throws(() => downloadReleasePart(url, part.release.bytes, {run: () => {
      syncCalls++; throw childError(fields);
    }}), check);
    await assert.rejects(downloadHydrationPart(url, part.release.bytes, {run: async () => {
      asyncCalls++; throw childError(fields);
    }}), check);
    assert.equal(syncCalls, 1);
    assert.equal(asyncCalls, 1);
  });
}

test('real synchronous child exit uses status and keeps the same private diagnostic', () => {
  let calls = 0;
  assert.throws(() => downloadReleasePart(url, part.release.bytes, {run: (_cmd, _args, options) => {
    calls++;
    try {
      return execFileSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(`HTTP 403: ${sensitive}\n`)});process.exit(1);`], options);
    } catch (error) {
      assert.equal(error.status, 1);
      assert.equal(error.code, undefined);
      throw error;
    }
  }}), error => {
    assert.equal(error.message, 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE');
    assert.equal(error.category, 'HTTP_403');
    assert.equal(error.exit_status, 1);
    assert.equal(error.native_code, 'NONE');
    assert.equal(error.stderr_shape, 'SINGLE_LINE');
    assert.equal(JSON.stringify(hydrationFailureDiagnostic(error)).includes(sensitive), false);
    assert.equal(Object.hasOwn(error, 'stderr'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('real synchronous output overflow keeps OUTPUT_LIMIT without a second attempt', () => {
  let calls = 0;
  assert.throws(() => downloadReleasePart(url, part.release.bytes, {run: (_cmd, _args, options) => {
    calls++;
    try {
      return execFileSync(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536));'], {...options, maxBuffer: 1024});
    } catch (error) {
      assert.equal(error.code, 'ENOBUFS');
      assert.equal(error.status, null);
      throw error;
    }
  }}), error => error.message === 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE' && error.category === 'OUTPUT_LIMIT');
  assert.equal(calls, 1);
});

test('diagnostic formatter does not copy unknown or spoofed client fields', () => {
  assert.deepEqual(hydrationFailureDiagnostic(childError({category: sensitive, phase: sensitive})), {
    error: 'RELEASE_HYDRATE_FAILED', phase: 'release_hydration', category: 'UNKNOWN'
  });
  assert.deepEqual(hydrationFailureDiagnostic(Object.assign(Error('RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE'), {
    category: sensitive, phase: sensitive, stderr: sensitive
  })), {error: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', phase: 'private_release_download', category: 'UNKNOWN', ...absentFields});
  assert.equal(hydrationFailureDiagnostic(Error('RELEASE_PART_COMPRESSED_CORRUPT')).error, 'RELEASE_PART_COMPRESSED_CORRUPT');
});

test('real hydration CLI keeps the private failure exit and hides fake client output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-private-diagnostic-'));
  try {
    const bin = path.join(root, 'bin'), data = path.join(root, 'data/news');
    fs.mkdirSync(bin); fs.mkdirSync(data, {recursive: true});
    fs.writeFileSync(path.join(data, 'stories.json'), JSON.stringify({
      storage_format: 'woek-newsroom-parts-1', parts_storage: RELEASE_STORE_FORMAT,
      fields: [{name: 'stories', kind: 'array', parts: [part]}]
    }));
    const counter = path.join(root, 'calls');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf 'call\\n' >> '${counter}'\nprintf '%s\\n' '${sensitive}' 'HTTP 403: ${sensitive} (https://example.invalid/${sensitive})' >&2\nexit 1\n`, {mode: 0o700});
    const cli = fileURLToPath(new URL('../../scripts/news/release-hydrate.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, `--root=${root}`], {
      env: {PATH: `${bin}:${process.env.PATH || ''}`}, encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', phase: 'private_release_download', category: 'HTTP_403',
      exit_status: 1, native_code: 'NONE', stderr_shape: 'MULTILINE', killed: false, signal: 'NONE', fields_state: 'VALID'
    });
    assert.equal(result.stderr.includes(sensitive), false);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'call\n');
    assert.equal(fs.existsSync(path.join(data, 'stories.json.parts')), false);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('UNKNOWN retains only typed process evidence for real sync and async exits', async () => {
  const exec = promisify(execFile);
  let syncCalls = 0, asyncCalls = 0;
  const args = ['-e', `process.stderr.write(${JSON.stringify(`${sensitive}\ncontext https://example.invalid/${sensitive}\n`)});process.exit(7);`];
  const check = error => {
    assert.deepEqual(hydrationFailureDiagnostic(error), {
      error: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', phase: 'private_release_download', category: 'UNKNOWN',
      exit_status: 7, native_code: 'NONE', stderr_shape: 'MULTILINE', killed: false, signal: 'NONE', fields_state: 'VALID'
    });
    assert.equal(JSON.stringify(error).includes(sensitive), false);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
  assert.throws(() => downloadReleasePart(url, part.release.bytes, {run: (_cmd, _args, options) => {
    syncCalls++; return execFileSync(process.execPath, args, options);
  }}), check);
  await assert.rejects(downloadHydrationPart(url, part.release.bytes, {run: async (_cmd, _args, options) => {
    asyncCalls++; return exec(process.execPath, args, options);
  }}), check);
  assert.equal(syncCalls, 1); assert.equal(asyncCalls, 1);
});

test('typed diagnostic shapes distinguish missing, invalid, oversized and conflicting fields', () => {
  assert.deepEqual(privateDownloadFailureDiagnostic({code: 9, stderr: sensitive}), {
    ...absentFields, fields_state: 'VALID', category: 'UNKNOWN', exit_status: 9, stderr_shape: 'SINGLE_LINE'
  });
  assert.equal(privateDownloadFailureDiagnostic({code: 1, status: 2}).fields_state, 'CONFLICT');
  assert.equal(privateDownloadFailureDiagnostic({code: 1, status: 2}).exit_status, null);
  assert.equal(privateDownloadFailureDiagnostic({code: 1, stderr: {value: sensitive}}).stderr_shape, 'INVALID');
  assert.equal(privateDownloadFailureDiagnostic({code: 1, stderr: 'x'.repeat(8193)}).stderr_shape, 'OVERSIZED');
  assert.equal(privateDownloadFailureDiagnostic({code: 'EACCES'}).native_code, 'EACCES');
  assert.equal(privateDownloadFailureDiagnostic({code: sensitive}).native_code, 'OTHER');
  assert.equal(privateDownloadFailureDiagnostic({signal: sensitive}).signal, 'OTHER');
  assert.equal(privateDownloadFailureDiagnostic({code: 256}).fields_state, 'INVALID');
  const throwing = {get code() {throw Error(sensitive);}};
  assert.deepEqual(privateDownloadFailureDiagnostic(throwing), {...absentFields, category: 'UNKNOWN'});
  assert.equal(JSON.stringify(privateDownloadFailureDiagnostic(throwing)).includes(sensitive), false);
});

test('CLI metadata whitelist rejects forged arbitrary fields and throwing accessors', () => {
  for (const key of ['exit_status', 'native_code', 'stderr_shape', 'killed', 'signal', 'fields_state']) {
    const error = Object.assign(Error('RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE'), {
      category: 'HTTP_403', ...absentFields, fields_state: 'VALID', [key]: sensitive
    });
    assert.deepEqual(hydrationFailureDiagnostic(error), {
      error: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', phase: 'private_release_download', category: 'UNKNOWN', ...absentFields
    });
  }
  assert.deepEqual(hydrationFailureDiagnostic({get message() {throw Error(sensitive);}}), {
    error: 'RELEASE_HYDRATE_FAILED', phase: 'release_hydration', category: 'UNKNOWN'
  });
});

test('CLI boundary reads each getter once before validating and emitting the same values', () => {
  const firstValues = {message: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', category: 'HTTP_403',
    exit_status: 1, native_code: 'NONE', stderr_shape: 'SINGLE_LINE', killed: false, signal: 'NONE', fields_state: 'VALID'};
  const reads = {}, error = {};
  for (const [key, value] of Object.entries(firstValues)) {
    reads[key] = 0;
    Object.defineProperty(error, key, {get() {return ++reads[key] === 1 ? value : sensitive;}});
  }
  const result = hydrationFailureDiagnostic(error);
  assert.deepEqual(result, {error: firstValues.message, phase: 'private_release_download', category: firstValues.category,
    exit_status: 1, native_code: 'NONE', stderr_shape: 'SINGLE_LINE', killed: false, signal: 'NONE', fields_state: 'VALID'});
  assert.deepEqual(reads, Object.fromEntries(Object.keys(firstValues).map(key => [key, 1])));
  assert.equal(JSON.stringify(result).includes(sensitive), false);
});

test('real hydration CLI UNKNOWN emits exit and shape without exposing stderr', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-private-unknown-'));
  try {
    const bin = path.join(root, 'bin'), data = path.join(root, 'data/news');
    fs.mkdirSync(bin); fs.mkdirSync(data, {recursive: true});
    fs.writeFileSync(path.join(data, 'stories.json'), JSON.stringify({
      storage_format: 'woek-newsroom-parts-1', parts_storage: RELEASE_STORE_FORMAT,
      fields: [{name: 'stories', kind: 'array', parts: [part]}]
    }));
    const counter = path.join(root, 'calls');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf 'call\\n' >> '${counter}'\nprintf '%s\\n' '${sensitive}' >&2\nexit 7\n`, {mode: 0o700});
    const cli = fileURLToPath(new URL('../../scripts/news/release-hydrate.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, `--root=${root}`], {
      env: {PATH: `${bin}:${process.env.PATH || ''}`}, encoding: 'utf8', timeout: 10000
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', phase: 'private_release_download', category: 'UNKNOWN',
      exit_status: 7, native_code: 'NONE', stderr_shape: 'SINGLE_LINE', killed: false, signal: 'NONE', fields_state: 'VALID'
    });
    assert.equal(result.stderr.includes(sensitive), false);
    assert.equal(fs.readFileSync(counter, 'utf8'), 'call\n');
    assert.equal(fs.existsSync(path.join(data, 'stories.json.parts')), false);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});

test('real hydration CLI hides invalid manifest text without attempting a download', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-invalid-manifest-'));
  try {
    const data = path.join(root, 'data/news'); fs.mkdirSync(data, {recursive: true});
    fs.writeFileSync(path.join(data, 'stories.json'), sensitive);
    const cli = fileURLToPath(new URL('../../scripts/news/release-hydrate.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, `--root=${root}`], {env: {}, encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {error: 'RELEASE_HYDRATE_FAILED', phase: 'release_hydration', category: 'UNKNOWN'});
    assert.equal(result.stderr.includes(sensitive), false);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
