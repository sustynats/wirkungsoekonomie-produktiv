import {spawn} from 'node:child_process';

const MAX_PUBLIC_ARTIFACT_BYTES = 77489996;

// Accept only the explicit public GitHub release path; never forward a URL,
// query, signed redirect or arbitrary repository to the gh fallback.
function publicReleaseParts(url) {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/sustynats\/wirkungsoekonomie\.de\/releases\/download\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(wirkungslexikon-public-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz)$/.exec(url);
  if (!match || match[0] !== url || match[1].includes('..') || match[2].includes('..')) return null;
  return {tag: match[1], filename: match[2]};
}

export async function downloadPublicRelease({tag, filename}, {spawnProcess = spawn, timeoutMs = 50000} = {}) {
  return new Promise((resolve, reject) => {
    const generic = () => new Error('LEXIKON_PUBLIC_RELEASE_FALLBACK_UNAVAILABLE');
    let child, timer, settled = false;
    const chunks = [];
    let totalBytes = 0;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { chunks.length = 0; reject(generic()); }
      else resolve(bytes);
    };
    try {
      child = spawnProcess('gh', ['release', 'download', tag, '--repo', 'sustynats/wirkungsoekonomie.de', '--pattern', filename, '--output', '-'], {stdio: ['ignore', 'pipe', 'ignore']});
    } catch { finish(true); return; }
    const stop = () => {
      finish(true);
      try { child.kill('SIGKILL'); } catch { /* already failed with the fixed error */ }
    };
    timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      if (!Buffer.isBuffer(chunk) || chunk.length > MAX_PUBLIC_ARTIFACT_BYTES - totalBytes) return stop();
      totalBytes += chunk.length;
      chunks.push(chunk);
    });
    child.stdout.on('error', stop);
    child.on('error', () => finish(true));
    child.on('close', (code) => {
      if (code !== 0) return finish(true);
      try { finish(false, Buffer.concat(chunks)); }
      catch { finish(true); }
    });
  });
}

// Retry only transient HTTP responses to this public, read-only artifact GET.
// The original caller still performs the same mandatory SHA and publication checks.
export async function fetchPublicArtifact(url, {fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), runGh = downloadPublicRelease} = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url);
    if (![500, 502, 503, 504].includes(response.status)) return response;
    if (attempt >= 2) {
      const parts = publicReleaseParts(url);
      if (!parts) return response;
      await response.body?.cancel();
      try {
        const bytes = await runGh(parts);
        if (!Buffer.isBuffer(bytes)) throw new Error();
        return new Response(bytes, {status: 200});
      } catch {
        throw new Error('LEXIKON_PUBLIC_RELEASE_FALLBACK_UNAVAILABLE');
      }
    }
    await response.body?.cancel();
    await wait(1000);
  }
}
