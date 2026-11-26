import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeSession } from '../bridge/remote.mjs';
import { loadSdgTickerPresentation } from './release-catalog.mjs';
import { SDG_PAGES_REPOSITORY } from './pages-release.mjs';

const oid = /^[a-f0-9]{40}$/;
const catalogPath = 'data/news/sdg/release-catalog.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function releaseIntent(root, runGit) {
  const catalog = loadSdgTickerPresentation(root);
  if (!catalog || catalog.releases.length < 2) return null;
  const sourceCommit = runGit(['rev-parse', 'HEAD']).toString().trim();
  if (!oid.test(sourceCommit)) throw Error('SDG_PAGES_DISPATCH_BINDING_REQUIRED');
  const message = runGit(['show', '-s', '--format=%B', sourceCommit]).toString();
  const trailers = [...message.matchAll(/^WOEK-SDG-Catalog: (\w+)$/gm)];
  if (!trailers.length) return null;
  if (trailers.length !== 1 || trailers[0][1] !== catalog.sha256 ||
      sha256(runGit(['show', `${sourceCommit}:${catalogPath}`])) !== catalog.sha256) {
    throw Error('SDG_PAGES_DISPATCH_BINDING_REQUIRED');
  }
  const { edition_id, sha256: editionHash } = catalog.releases.at(-1);
  return { sourceCommit, committed: { edition_id, sha256: editionHash, catalog_sha256: catalog.sha256 } };
}

export async function dispatchSdgPagesRelease({
  root, withReservation, send, runGit = args => execFileSync('git', args, {
    cwd: root, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
}) {
  const intent = releaseIntent(root, runGit);
  if (!intent) return { status: 'no_committed_sdg_dispatch' };
  const { committed, sourceCommit } = intent;
  const upstream = runGit(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).toString().trim();
  if (upstream !== `${sourceCommit}\trefs/heads/main`) return { status: 'main_moved' };
  const ticket = await withReservation(committed, sourceCommit);
  if (ticket?.status === 'already_confirmed' || ticket?.status === 'dispatch_held') return ticket;
  if (ticket?.status !== 'reserved') throw Error('SDG_PAGES_DISPATCH_RESERVATION_REQUIRED');
  // A failed or lost request is ambiguous. The existing publisher may finish,
  // so the reservation must outlive the runner and cannot be replayed.
  await send(sourceCommit, committed.catalog_sha256);
  return { status: 'dispatch_requested' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== SDG_PAGES_REPOSITORY || !process.env.GH_TOKEN) {
    throw Error('SDG_PAGES_DISPATCH_RUNNER_REQUIRED');
  }
  const result = await dispatchSdgPagesRelease({
    root: process.cwd(),
    async withReservation(committed, sourceCommit) {
      const { store, sdg } = bridgeSession();
      await store.acquire(new Date().toISOString(), 'combined');
      let safe = false;
      try {
        const ticket = await sdg.reserveDispatch(committed, sourceCommit);
        safe = true;
        return ticket;
      } finally { await store.release(safe); }
    },
    send(commit, catalogHash) {
      try {
        execFileSync('gh', ['workflow','run','deploy.yml','--repo',SDG_PAGES_REPOSITORY,'--ref','main',
          '-f','ticker_only=true','-f',`ticker_commit=${commit}`,'-f','skip_ticker_notify=true',
          '-f',`sdg_catalog_sha256=${catalogHash}`], {
          timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { throw Error('SDG_PAGES_DISPATCH_STATUS_UNKNOWN'); }
    },
  });
  console.log(`SDG Pages publication: ${result.status}.`);
}
