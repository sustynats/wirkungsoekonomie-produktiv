// Read-only migration gate for the existing public downloads. This never creates
// or uploads a release: a missing or changed edition must use its own approved
// public publication path before Pages is released.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {JOURNAL_MEDIA_REPO} from './sync-journal-release-assets.mjs';

export const PUBLIC_REPO = 'sustynats/wirkungsoekonomie.de';
export const MIGRATION_REPO = 'sustynats/wirkungsoekonomie-produktiv';
const FIXED = [
  ['woek-public-assets-v2', 'assets/downloads/woek-register/v1.5/WOeK_Masterregister_v1.5_2026-08-21.xlsx', 'WOeK_Masterregister_v1.5_2026-08-21.xlsx'],
  ['woek-public-assets-v2', 'public/downloads/originals/WOeK_Begriffsleitfaden_fuehrend_v1.6.pdf', 'WOeK_Begriffsleitfaden_fuehrend_v1.6-bereinigt-2defe3b6.pdf'],
  ['woek-public-assets-v2', 'public/downloads/originals/WOeK_Begriffsleitfaden_fuehrend_v1.7.pdf', 'WOeK_Begriffsleitfaden_fuehrend_v1.7-bereinigt-89c83f3d.pdf'],
];
const TAGS = new Set(['woek-public-assets-v2', 'woek-journal-pdfs-v1']);
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function requiredAssets(root, journalEntries) {
  if (!Array.isArray(journalEntries) || !journalEntries.length) throw Error('PUBLIC_JOURNAL_LIST_EMPTY');
  const entries = FIXED.map(([tag, source, name]) => ({tag, source, name}));
  for (const entry of journalEntries) {
    const repository = [PUBLIC_REPO, JOURNAL_MEDIA_REPO].find(repo => typeof entry?.[1] === 'string' && entry[1].startsWith(`https://github.com/${repo}/releases/download/woek-journal-pdfs-v1/`));
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0].startsWith('assets/pdf/journal/')
        || !repository) throw Error('PUBLIC_JOURNAL_REFERENCE_INVALID');
    const prefix = `https://github.com/${repository}/releases/download/woek-journal-pdfs-v1/`;
    const name = entry[1].slice(prefix.length);
    if (!/^[A-Za-z0-9_.-]+\.pdf$/.test(name)) throw Error('PUBLIC_JOURNAL_NAME_INVALID');
    entries.push({tag: 'woek-journal-pdfs-v1', source: entry[0], name, repository});
  }
  const rootReal = fs.realpathSync(root), keys = new Set();
  return entries.map(entry => {
    const key = `${entry.repository || PUBLIC_REPO}/${entry.tag}/${entry.name}`;
    if (keys.has(key)) throw Error('PUBLIC_ASSET_DUPLICATE');
    keys.add(key);
    const resolved = fs.realpathSync(path.resolve(rootReal, entry.source));
    if (!resolved.startsWith(rootReal + path.sep)) throw Error('PUBLIC_ASSET_PATH_INVALID');
    const data = fs.readFileSync(resolved);
    if (!data.length) throw Error('PUBLIC_ASSET_EMPTY');
    return {...entry, bytes: data.length, digest: `sha256:${hex(data)}`};
  });
}

export async function readPublicRelease(tag, fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, repository = PUBLIC_REPO) {
  if (!TAGS.has(tag)) throw Error('PUBLIC_RELEASE_TAG_INVALID');
  if (repository !== PUBLIC_REPO && !(repository === JOURNAL_MEDIA_REPO && tag === 'woek-journal-pdfs-v1')) throw Error('PUBLIC_RELEASE_REPOSITORY_INVALID');
  const base = `https://api.github.com/repos/${repository}/releases`;
  const request = async url => {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetcher(url, {method: 'GET', headers: {'Accept': 'application/vnd.github+json', 'User-Agent': 'woek-public-release-verifier'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
      if (res.ok) return res.json();
      // Only retry an explicitly temporary server error or a rate limit with a
      // known, nearby reset. All other failures preserve the blocking gate.
      const status = Number.isInteger(res.status) ? res.status : 0;
      let delay = null;
      if ([500, 502, 503, 504].includes(status)) delay = 1000 * (2 ** attempt);
      if ((status === 403 || status === 429) && res.headers?.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const untilReset = reset - now();
        if (Number.isFinite(reset) && untilReset >= 0 && untilReset <= 60000) delay = untilReset + 1000;
      }
      const maxRetries = [500, 502, 503, 504].includes(status) ? 3 : 1;
      if (attempt >= maxRetries || delay === null) throw Error(`PUBLIC_RELEASE_METADATA_UNAVAILABLE_HTTP_${status}`);
      await sleep(delay);
    }
    throw Error('PUBLIC_RELEASE_METADATA_UNAVAILABLE');
  };
  const release = await request(`${base}/tags/${encodeURIComponent(tag)}`);
  if (release.tag_name !== tag || release.draft !== false || !Number.isSafeInteger(release.id) || release.id < 1)
    throw Error('PUBLIC_RELEASE_INVALID');
  const assets = [];
  for (let page = 1; page <= 11; page++) {
    const batch = await request(`${base}/${release.id}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw Error('PUBLIC_RELEASE_ASSETS_INVALID');
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
  throw Error('PUBLIC_RELEASE_ASSETS_UNBOUNDED');
}

export async function verifyExistingPublicAssets(expected, readRelease = (tag, repository) => readPublicRelease(tag, fetch, undefined, undefined, repository)) {
  if (!Array.isArray(expected) || !expected.length) throw Error('PUBLIC_ASSET_LIST_EMPTY');
  let count = 0;
  for (const tag of TAGS) {
    if (!expected.some(item => item.tag === tag)) throw Error('PUBLIC_ASSET_SCOPE_INCOMPLETE');
  }
  const groups = new Map();
  for (const item of expected) {
    const repository = item.repository || PUBLIC_REPO;
    if (!TAGS.has(item.tag) || (repository !== PUBLIC_REPO && !(repository === JOURNAL_MEDIA_REPO && item.tag === 'woek-journal-pdfs-v1'))) throw Error('PUBLIC_ASSET_SCOPE_INVALID');
    const key = `${repository}/${item.tag}`;
    if (!groups.has(key)) groups.set(key, {repository, tag: item.tag, needed: []});
    groups.get(key).needed.push(item);
  }
  for (const {repository, tag, needed} of groups.values()) {
    const assets = await readRelease(tag, repository), byName = new Map();
    if (!Array.isArray(assets)) throw Error('PUBLIC_RELEASE_ASSETS_INVALID');
    for (const asset of assets) {
      if (typeof asset?.name !== 'string' || byName.has(asset.name)) throw Error('PUBLIC_RELEASE_ASSET_AMBIGUOUS');
      byName.set(asset.name, asset);
    }
    for (const item of needed) {
      const actual = byName.get(item.name);
      if (!actual || actual.state !== 'uploaded' || actual.size !== item.bytes || actual.digest !== item.digest)
        throw Error('PUBLIC_ASSET_MISSING_OR_CHANGED');
      count++;
    }
  }
  if (count !== expected.length) throw Error('PUBLIC_ASSET_SCOPE_INVALID');
  return {status: 'EXISTING_PUBLIC_ASSETS_VERIFIED', checked: count, releases: groups.size};
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== MIGRATION_REPO) throw Error('PUBLIC_ASSET_WRONG_REPOSITORY');
  const {journalReleaseEntries} = await import('./sync-journal-release-assets.mjs');
  const expected = requiredAssets(process.cwd(), journalReleaseEntries(process.cwd()));
  console.log(JSON.stringify(await verifyExistingPublicAssets(expected)));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
