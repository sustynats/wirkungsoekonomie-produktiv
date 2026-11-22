import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {releasePartUrl, RELEASE_STORE_FORMAT} from './release-part.mjs';
import {newsroomParts} from './newsroom-store.mjs';
const policy = JSON.parse(fs.readFileSync(new URL('../../docs/ops/GIT-STORAGE-POLICY.json', import.meta.url), 'utf8'));
const STORES = new Set(['data/news/stories.json', 'data/news/newsroom.json']);
const RAW_PARTS = /^data\/news\/(?:stories|newsroom)\.json\.parts\//;
const SHA = /^[a-f0-9]{40,64}$/;
export function oversizedGitEntries(entries, limit = 95*1024**2) { return entries.filter(entry => entry.bytes > limit); }
export function repositoryStorageState(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('GIT_STORAGE_REPOSITORY_SIZE_INVALID');
  return bytes >= policy.stop_automated_writes_bytes ? 'stop' : bytes >= policy.warning_bytes ? 'warning' : 'ok';
}
export function assertReleasedManifest(value) {
  if (!/^woek-newsroom-parts-[12]$/.test(value?.storage_format || '') || value.parts_storage !== RELEASE_STORE_FORMAT || !Array.isArray(value.fields)) throw Error('GIT_STORAGE_RAW_STORE_FORBIDDEN');
  for (const field of value.fields) {
    if (['schema_version','updated_at','public_updated_at'].includes(field.key) && field.kind === 'value') continue;
    if (!['array','object'].includes(field.kind) || !Array.isArray(field.parts) || !Number.isSafeInteger(field.count) || field.count < 0 || (field.count > 0 && !field.parts.length)) throw Error('GIT_STORAGE_MANIFEST_FIELD_INVALID');
  }
  // The existing v2 format may split a large logical record into bounded
  // leaf chunks. Require a pinned release for every leaf, not its container.
  for (const part of newsroomParts(value)) releasePartUrl(part);
  return true;
}
const git = (root, args, options={}) => execFileSync('git', args, {cwd:root, env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'}, encoding:'utf8', maxBuffer:16*1024**2, timeout:60000, ...options});
export function stagedEntries(root=process.cwd()) {
  const files=git(root,['diff','--cached','--name-only','--diff-filter=ACMR','-z']).split('\0').filter(Boolean);
  if (!files.length) return [];
  const indexed=new Map(git(root,['ls-files','--stage','-z']).split('\0').filter(Boolean).map(line=>{
    const tab=line.indexOf('\t'), [mode,oid,stage]=line.slice(0,tab).split(' ');return [line.slice(tab+1),stage==='0'?oid:null];
  }));
  const oids=files.map(file=>indexed.get(file));if(oids.some(oid=>!SHA.test(oid||'')))throw Error('GIT_SIZE_INDEX_INVALID');
  const sizes=git(root,['cat-file','--batch-check=%(objectsize)'],{input:oids.join('\n')+'\n'}).trim().split('\n').map(Number);
  if(sizes.length!==files.length||sizes.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('GIT_SIZE_RESULT_INVALID');
  return files.map((file,i)=>({file,oid:oids[i],bytes:sizes[i]}));
}
export function assertStagedStorage(entries, readBlob) {
  const large=oversizedGitEntries(entries,policy.per_file_limit_bytes);if(large.length)throw Error('GIT_FILE_SIZE_GUARD:'+JSON.stringify(large));
  for(const entry of entries){
    if(RAW_PARTS.test(entry.file))throw Error('GIT_STORAGE_RAW_PART_FORBIDDEN:'+entry.file);
    if(STORES.has(entry.file)){
      if(entry.bytes>policy.maximum_manifest_bytes)throw Error('GIT_STORAGE_MANIFEST_TOO_LARGE');
      assertReleasedManifest(JSON.parse(readBlob(entry.oid)));
    }
  }
}
// Measure a synthetic commit with the staged tree and current HEAD as parent.
// HEAD and historical commits are unchanged. A thin pack uses existing blobs
// as delta bases, limiting the additional transport rather than raw file sizes.
export function stagedTransportBytes(root=process.cwd(), maxBytes=policy.maximum_staged_transport_bytes) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('GIT_STORAGE_PACK_LIMIT_INVALID');
  const head=git(root,['rev-parse','HEAD^{commit}']).trim();
  const base=git(root,['rev-parse','HEAD^{tree}']).trim(),tree=git(root,['write-tree']).trim();
  if(!SHA.test(head)||!SHA.test(base)||!SHA.test(tree))throw Error('GIT_STORAGE_TREE_INVALID');
  if(tree===base)return 0;
  // A tree-only exclusion does not expose the old blobs as thin-pack delta
  // bases. Build an unreferenced measurement commit with the staged tree and
  // the actual parent; neither HEAD nor the index or working tree changes.
  const measurementCommit=git(root,['-c','commit.gpgsign=false','commit-tree',tree,'-p',head],{
    input:'Storage transport measurement\n',
    env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',
      GIT_AUTHOR_NAME:'Storage measurement',GIT_AUTHOR_EMAIL:'storage-measurement@example.invalid',
      GIT_COMMITTER_NAME:'Storage measurement',GIT_COMMITTER_EMAIL:'storage-measurement@example.invalid',
      GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},
  }).trim();
  if(!SHA.test(measurementCommit))throw Error('GIT_STORAGE_COMMIT_INVALID');
  try {
    const bytes=git(root,['pack-objects','--revs','--thin','--delta-base-offset','--stdout'],{input:measurementCommit+'\n^'+head+'\n',encoding:null,maxBuffer:maxBytes,timeout:60000});
    return bytes.length;
  } catch(error) {
    if(error.code==='ENOBUFS'||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'||error.signal)throw Error('GIT_STORAGE_TRANSPORT_BUDGET');
    throw Error('GIT_STORAGE_PACK_INSPECTION_FAILED',{cause:error});
  }
}
export function checkStagedGitSize({root=process.cwd(),automatic=false}={}) {
  const entries=stagedEntries(root);if(!entries.length){console.log('Git-Speicher geprüft: keine Änderungen.');return {files:0,transportBytes:0};}
  assertStagedStorage(entries,oid=>git(root,['cat-file','blob',oid]));
  let repository=null;
  if(automatic){
    repository=readRepositoryStorage().state;
    if(policy.enforce_total_repository_after_cleanup && repository==='stop')throw Error('GIT_STORAGE_REPOSITORY_STOP');
  }
  const transportBytes=stagedTransportBytes(root);const result={files:entries.length,transportBytes,repository,totalStopActivated:policy.enforce_total_repository_after_cleanup};console.log(JSON.stringify(result));return result;
}


// The provider measurement is read-only and independent of Git state commits.
export function readRepositoryStorage(run = execFileSync) {
  const text = run('gh', ['api', 'repos/' + policy.repository, '--jq', '.size'], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024,
  }).trim();
  if (!/^\d+$/.test(text)) throw Error('GIT_STORAGE_REPOSITORY_SIZE_INVALID');
  const bytes = Number(text) * 1024;
  return {
    repository: policy.repository, bytes, state: repositoryStorageState(bytes),
    warningBytes: policy.warning_bytes, stopBytes: policy.stop_automated_writes_bytes,
    totalStopActivated: policy.enforce_total_repository_after_cleanup,
  };
}

function commitOid(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.includes('\0')) throw Error('GIT_STORAGE_COMMIT_REQUIRED');
  const oid = git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();
  if (!SHA.test(oid)) throw Error('GIT_STORAGE_COMMIT_INVALID');
  return oid;
}

export function checkStoragePreflight({measure = readRepositoryStorage} = {}) {
  const repository = measure();
  if (repository.state !== repositoryStorageState(repository.bytes)) throw Error('GIT_STORAGE_REPOSITORY_SIZE_INVALID');
  if (policy.enforce_total_repository_after_cleanup && repository.state === 'stop') throw Error('GIT_STORAGE_REPOSITORY_STOP');
  return {...repository, preflight: true, totalStopActivated: policy.enforce_total_repository_after_cleanup};
}

// Inspect every outgoing commit, including intermediate blobs later removed.
// A clean staging area or an unchanged final tree does not mean a small push.
export function outgoingCommits(root, base, head = 'HEAD') {
  const baseOid = commitOid(root, base), headOid = commitOid(root, head);
  if (baseOid === headOid) return {base: baseOid, head: headOid, commits: []};
  try { git(root, ['merge-base', '--is-ancestor', baseOid, headOid]); }
  catch { throw Error('GIT_STORAGE_PUSH_NOT_FAST_FORWARD'); }
  const limit = policy.maximum_outgoing_commits;
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error('GIT_STORAGE_COMMIT_LIMIT_INVALID');
  const commits = git(root, ['rev-list', '--reverse', '--max-count=' + (limit + 1), headOid, '^' + baseOid])
    .trim().split('\n').filter(Boolean);
  if (commits.length > limit) throw Error('GIT_STORAGE_OUTGOING_COMMIT_LIMIT');
  if (!commits.length || commits.some(oid => !SHA.test(oid))) throw Error('GIT_STORAGE_COMMIT_INVALID');
  return {base: baseOid, head: headOid, commits};
}

export function outgoingTreeEntries(root, commit) {
  if (!SHA.test(commit)) throw Error('GIT_STORAGE_COMMIT_INVALID');
  const raw = git(root, ['diff-tree', '--no-commit-id', '--root', '-r', '-m', '--no-renames',
    '--diff-filter=ACMT', '--raw', '-z', commit]).split('\0');
  if (raw.at(-1) !== '') throw Error('GIT_STORAGE_DIFF_INVALID');
  raw.pop();
  if (raw.length % 2) throw Error('GIT_STORAGE_DIFF_INVALID');
  const entries = [], seen = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([ACMT])$/.exec(raw[i]);
    const file = raw[i + 1];
    if (!match || !file) throw Error('GIT_STORAGE_DIFF_INVALID');
    const mode = match[2], oid = match[4], key = file + '\0' + oid;
    if (!['100644', '100755', '120000', '160000'].includes(mode)) throw Error('GIT_STORAGE_MODE_INVALID');
    if (seen.has(key)) continue;
    seen.add(key);
    // A gitlink does not transfer its submodule's objects in this repository.
    entries.push({file, oid, bytes: 0, gitlink: mode === '160000'});
  }
  const blobs = entries.filter(entry => !entry.gitlink);
  if (blobs.length) {
    const metadata = git(root, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], {
      input: blobs.map(entry => entry.oid).join('\n') + '\n',
    }).trim().split('\n');
    if (metadata.length !== blobs.length) throw Error('GIT_SIZE_RESULT_INVALID');
    for (let i = 0; i < blobs.length; i++) {
      const match = /^blob (\d+)$/.exec(metadata[i]);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error('GIT_SIZE_RESULT_INVALID');
      blobs[i].bytes = Number(match[1]);
    }
  }
  return entries;
}

export function outgoingTransportBytes(root, base, head = 'HEAD', maxBytes = policy.maximum_outgoing_transport_bytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('GIT_STORAGE_PACK_LIMIT_INVALID');
  const baseOid = commitOid(root, base), headOid = commitOid(root, head);
  if (baseOid === headOid) return 0;
  try {
    const packed = git(root, ['pack-objects', '--revs', '--thin', '--delta-base-offset', '--stdout'], {
      input: headOid + '\n^' + baseOid + '\n', encoding: null, maxBuffer: maxBytes, timeout: 60000,
    });
    return packed.length;
  } catch (error) {
    if (error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.signal) {
      throw Error('GIT_STORAGE_TRANSPORT_BUDGET');
    }
    throw Error('GIT_STORAGE_PACK_INSPECTION_FAILED', {cause: error});
  }
}

export function checkOutgoingGitSize({root = process.cwd(), base, head = 'HEAD', automatic = false} = {}) {
  const range = outgoingCommits(root, base, head);
  if (!range.commits.length) return {...range, commits: 0, files: 0, transportBytes: 0};
  let files = 0;
  for (const commit of range.commits) {
    const entries = outgoingTreeEntries(root, commit);
    assertStagedStorage(entries, oid => git(root, ['cat-file', 'blob', oid]));
    files += entries.length;
  }
  const repository = automatic ? readRepositoryStorage() : null;
  if (repository?.totalStopActivated && repository.state === 'stop') throw Error('GIT_STORAGE_REPOSITORY_STOP');
  const transportBytes = outgoingTransportBytes(root, range.base, range.head);
  const result = {...range, commits: range.commits.length, files, transportBytes,
    repository: repository?.state || null, totalStopActivated: policy.enforce_total_repository_after_cleanup};
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--automatic' && arg !== '--preflight' && !arg.startsWith('--base=') && !arg.startsWith('--head='))) {
    throw Error('GIT_STORAGE_ARGUMENT_INVALID');
  }
  if (args.filter(arg => arg.startsWith('--base=')).length > 1 || args.filter(arg => arg.startsWith('--head=')).length > 1) {
    throw Error('GIT_STORAGE_ARGUMENT_INVALID');
  }
  const base = args.find(arg => arg.startsWith('--base='))?.slice(7);
  const head = args.find(arg => arg.startsWith('--head='))?.slice(7);
  if (args.some(arg => arg.startsWith('--head=')) && (base === undefined || !head)) throw Error('GIT_STORAGE_COMMIT_REQUIRED');
  const automatic = args.includes('--automatic');
  if (args.includes('--preflight')) {
    if (base !== undefined || head !== undefined) throw Error('GIT_STORAGE_ARGUMENT_INVALID');
    console.log(JSON.stringify(checkStoragePreflight()));
  } else if (base !== undefined) checkOutgoingGitSize({base, head: head || 'HEAD', automatic});
  else checkStagedGitSize({automatic});
}
