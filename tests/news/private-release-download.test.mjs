import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {DATA_REPOSITORY, LEGACY_DATA_REPOSITORY, RELEASE_PART_FORMAT, decodeReleasePart,
  downloadReleasePart, partDigest, releasePartUrl} from '../../scripts/news/release-part.mjs';
import {downloadHydrationPart} from '../../scripts/news/release-hydrate.mjs';

const raw = Buffer.from('{"stories":[{"id":"original"}]}');
const zipped = gzipSync(raw);
const ref = repository => ({sha256:partDigest(raw), bytes:raw.length,
  release:{repository, storage_format:RELEASE_PART_FORMAT, tag:'wirkungsticker-data-2026-11',
    asset:partDigest(raw)+'.json.gz', sha256:partDigest(zipped), bytes:zipped.length}});

test('a pinned private part is retrieved by the GitHub client and verified byte-for-byte', () => {
  const part = ref(DATA_REPOSITORY), calls = [];
  const result = downloadReleasePart(releasePartUrl(part), part.release.bytes, {run:(cmd,args,options) => {
    calls.push({cmd,args,options}); return zipped;
  }});
  assert.deepEqual(decodeReleasePart(result,part),raw);
  assert.equal(calls[0].cmd,'gh');
  assert.deepEqual(calls[0].args,['release','download',part.release.tag,'--repo',DATA_REPOSITORY,
    '--pattern',part.release.asset,'--output','-']);
  assert.equal(calls[0].options.maxBuffer,part.release.bytes+1024);
  assert.ok(!calls[0].args.some(value => /token|authorization/i.test(value)));
});

test('the legacy public release still uses its existing anonymous transport', () => {
  const part = ref(LEGACY_DATA_REPOSITORY); let executable;
  const result = downloadReleasePart(releasePartUrl(part),part.release.bytes,{run:(cmd) => {executable=cmd;return zipped;}});
  assert.equal(executable,'curl'); assert.deepEqual(decodeReleasePart(result,part),raw);
});

test('private repository references with unpinned names or URL parameters fail before the client starts', () => {
  const part = ref(DATA_REPOSITORY), valid=releasePartUrl(part); let calls=0;
  const run=()=>{calls++;throw Error('unexpected network');};
  for (const invalid of [valid+'?download=1',valid+'#fragment',valid.replace(part.release.asset,'other.gz'),
    valid.replace(part.release.tag,'other-tag')])
    assert.throws(()=>downloadReleasePart(invalid,part.release.bytes,{run}),/RELEASE_PART_REFERENCE_INVALID/);
  assert.equal(calls,0);
});

test('private downloads propagate authorization failures and reject corrupted compressed bytes', () => {
  const part=ref(DATA_REPOSITORY), url=releasePartUrl(part);
  assert.throws(()=>downloadReleasePart(url,part.release.bytes,{run:()=>{throw Error('sensitive-client-output');}}),
    error => error.message === 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE');
  assert.throws(()=>decodeReleasePart(Buffer.alloc(part.release.bytes),part),/RELEASE_PART_COMPRESSED_CORRUPT/);
});

test('parallel hydration uses the same pinned private transport and hides client errors', async () => {
  const part=ref(DATA_REPOSITORY), url=releasePartUrl(part); let argsSeen;
  const bytes=await downloadHydrationPart(url,part.release.bytes,{run:async (cmd,args,options) => {
    argsSeen={cmd,args,options}; return {stdout:zipped};
  }});
  assert.equal(argsSeen.cmd,'gh');
  assert.equal(argsSeen.args[argsSeen.args.indexOf('--repo')+1],DATA_REPOSITORY);
  assert.equal(argsSeen.options.encoding,'buffer');
  assert.deepEqual(decodeReleasePart(bytes,part),raw);
  await assert.rejects(downloadHydrationPart(url,part.release.bytes,{run:async()=>{throw Error('private-client-output');}}),
    error => error.message==='RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE');
});

test('parallel hydration preserves the legacy public curl transport', async () => {
  const part=ref(LEGACY_DATA_REPOSITORY); let executable;
  const bytes=await downloadHydrationPart(releasePartUrl(part),part.release.bytes,
    {run:async cmd=>{executable=cmd;return {stdout:zipped};}});
  assert.equal(executable,'curl'); assert.deepEqual(decodeReleasePart(bytes,part),raw);
});
