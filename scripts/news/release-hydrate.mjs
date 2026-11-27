// Read-only network prefetch before processing/building. Bounded parallelism
// avoids serial cold downloads in the existing synchronous JSON readers.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {newsroomParts} from './newsroom-store.mjs';
import {LEGACY_DATA_REPOSITORY, RELEASE_STORE_FORMAT, releasePartUrl, assertRawPart, decodeReleasePart, releasePartDownloadCommand, validDataTag, privateReleaseDownloadError, privateDownloadDiagnosticFields} from './release-part.mjs';

const exec = promisify(execFile);
const publicTransferInterruptions = new Set([18, 28, 52, 55, 56]);
export async function downloadHydrationPart(url, maxBytes, {run = exec} = {}) {
  const spec = releasePartDownloadCommand(url, maxBytes);
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return (await run(spec.command, spec.args, {...spec.options, encoding: 'buffer'})).stdout; }
    catch (error) {
      if (spec.private) throw privateReleaseDownloadError(error);
      const stderr = String(error.stderr || '').trim();
      failure = error;
      // A completed curl process can identify an interrupted GET. Do not
      // spend another full timeout on the same URL before the pinned fallback.
      if (publicTransferInterruptions.has(error.code) && !error.killed && !error.signal &&
          (error.status == null || error.status === error.code) && stderr.startsWith(`curl: (${error.code}) `)) break;
      const transient = error.code === 22 && /curl:\s*\(22\)\s*The requested URL returned error:\s*(?:500|502|503|504)\b/i.test(stderr);
      if (!transient) throw error;
      if (attempt === 3) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  // Only the declared public legacy asset can use the native API transport.
  // The caller still verifies compressed and raw bytes against the manifest.
  const parsed = new URL(url);
  const prefix = `/${LEGACY_DATA_REPOSITORY}/releases/download/`;
  const parts = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length).split('/') : [];
  if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parts.length !== 2 || !validDataTag(parts[0]) || !/^[a-f0-9]{64}\.json\.gz$/.test(parts[1])) throw failure;
  try {
    return (await run('gh', ['release', 'download', parts[0], '--repo', LEGACY_DATA_REPOSITORY,
      '--pattern', parts[1], '--output', '-'], {...spec.options, encoding: 'buffer'})).stdout;
  } catch { throw Error('PUBLIC_RELEASE_API_DOWNLOAD_UNAVAILABLE'); }
}

export async function hydrateReleaseData({root = process.cwd(), downloadPart = downloadHydrationPart, concurrency = 4} = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error('RELEASE_HYDRATE_CONCURRENCY_INVALID');
  const pending = new Map(); let stores = 0;
  for (const relative of ['data/news/stories.json', 'data/news/newsroom.json']) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file));
    if (manifest.parts_storage !== RELEASE_STORE_FORMAT) continue;
    stores++;
    for (const part of newsroomParts(manifest)) {
      const physical = `${file}.parts/${part.sha256}.json`;
      if (fs.existsSync(physical)) { assertRawPart(fs.readFileSync(physical), part); continue; }
      releasePartUrl(part);
      const task = pending.get(part.sha256);
      if (task && task.part.bytes !== part.bytes) throw Error('RELEASE_HYDRATE_PART_CONFLICT');
      if (task) task.files.push(physical);
      else pending.set(part.sha256, {part, files: [physical]});
    }
  }
  const tasks = [...pending.values()]; let cursor = 0, fetched = 0, rawBytes = 0, failure;
  const worker = async () => {
    while (!failure && cursor < tasks.length) {
      const {part, files} = tasks[cursor++];
      try {
        const bytes = decodeReleasePart(await downloadPart(releasePartUrl(part), part.release.bytes), part);
        for (const file of files) {
          if (fs.existsSync(file)) { assertRawPart(fs.readFileSync(file), part); continue; }
          fs.mkdirSync(path.dirname(file), {recursive: true});
          const temporary = `${file}.tmp-${process.pid}`;
          try { fs.writeFileSync(temporary, bytes, {mode: 0o600}); fs.renameSync(temporary, file); }
          finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
        fetched++; rawBytes += bytes.length;
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, tasks.length)}, worker));
  if (failure) throw failure;
  return {status: stores ? 'verified' : 'not_enabled', stores, fetched_parts: fetched, raw_bytes: rawBytes};
}

const safeHydrationCodes = new Set([
  'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE', 'PUBLIC_RELEASE_API_DOWNLOAD_UNAVAILABLE',
  'RELEASE_HYDRATE_CONCURRENCY_INVALID', 'RELEASE_HYDRATE_PART_CONFLICT',
  'RELEASE_PART_INVALID', 'RELEASE_PART_RAW_CORRUPT', 'RELEASE_PART_REFERENCE_INVALID',
  'RELEASE_PART_COMPRESSED_CORRUPT', 'RELEASE_PART_GZIP_INVALID',
  'NEWSROOM_MANIFEST_INVALID', 'NEWSROOM_PARTS_INVALID', 'NEWSROOM_RECORD_INVALID', 'NEWSROOM_PART_INVALID'
]);
export function hydrationFailureDiagnostic(error) {
  try {
    const {message, category: reportedCategory} = error || {};
    const code = safeHydrationCodes.has(message) ? message : 'RELEASE_HYDRATE_FAILED';
    const privateFailure = code === 'RELEASE_PART_PRIVATE_DOWNLOAD_UNAVAILABLE';
    const fields = privateFailure ? privateDownloadDiagnosticFields(error) : {};
    const category = privateFailure && fields.fields_state === 'VALID' && typeof reportedCategory === 'string' &&
      /^(?:UNKNOWN|OUTPUT_LIMIT|CLIENT_MISSING|TERMINATED_UNKNOWN|RELEASE_NOT_FOUND|ASSET_PATTERN_NO_MATCH|NO_ASSETS|HTTP_[45]\d\d)$/.test(reportedCategory)
      ? reportedCategory : 'UNKNOWN';
    return {error: code, phase: privateFailure ? 'private_release_download' : 'release_hydration', category, ...fields};
  } catch { return {error: 'RELEASE_HYDRATE_FAILED', phase: 'release_hydration', category: 'UNKNOWN'}; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.argv.slice(2).find(arg => arg.startsWith('--root='))?.slice(7);
    console.log(JSON.stringify(await hydrateReleaseData({...(root ? {root} : {})})));
  } catch (error) { console.error(JSON.stringify(hydrationFailureDiagnostic(error))); process.exitCode = 1; }
}
