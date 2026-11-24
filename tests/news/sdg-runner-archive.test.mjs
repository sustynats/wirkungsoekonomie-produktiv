import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { registerSdgEdition } from '../../scripts/news/sdg/register-edition.mjs';
import { SDG_PAGES_REPOSITORY, SDG_PAGES_RELEASE_PATH } from '../../scripts/news/sdg/pages-release.mjs';
import { readSdgPublicNativeMetadata, reconcileRunnerSdgPagesDelivery } from '../../scripts/news/sdg/confirm-pages-delivery.mjs';
import { reconcileSdgReceiptFromRunner } from '../../scripts/news/sdg/import-bridge-editions.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sdg-runner-archive-'));
  const root = path.join(dir, 'catalog');
  fs.mkdirSync(root);
  const ledger = new EditionLedger(':memory:');
  t.after(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const edition = ledger.stage({ date: '2026-11-24', slot: 'morgenlage',
    cutoff: '2026-11-24T05:00:00.000Z', sealedAt: '2026-11-24T05:01:00.000Z' });
  const registered = registerSdgEdition({ root, ledger, editionId: edition.id, expectedCatalogHash: null });
  const committed = { edition_id: edition.id, sha256: registered.edition_sha256 };
  const at = minute => `2026-11-24T05:${minute}:00.000Z`;
  const sourceCommit = 'b'.repeat(40);
  const html = Buffer.from('<p>Runner archive fixture</p>');
  const manifest = Buffer.from(JSON.stringify({
    schema_version: 1, kind: 'sdg_pages_release', repository: SDG_PAGES_REPOSITORY, source_commit: sourceCommit,
    run_id: '41', run_attempt: '2', catalog_sha256: registered.catalog_sha256,
    editions: [{ ...committed, edition_sha256: committed.sha256, html_sha256: sha256(html) }],
  }));
  const archive = execFileSync('python3', ['-c', `
import io, sys, zipfile
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as out:
    out.writestr("release.json", sys.stdin.buffer.read())
sys.stdout.buffer.write(buf.getvalue())
`], { input: manifest });
  const run = { id: 41, run_attempt: 2, repository: { full_name: SDG_PAGES_REPOSITORY },
    path: '.github/workflows/deploy.yml', head_branch: 'main', head_sha: sourceCommit, event: 'push', status: 'completed' };
  const build = { name: 'build', run_id: 41, status: 'completed', conclusion: 'success', started_at: at('02'), completed_at: at('04') };
  const deploy = { ...build, name: 'deploy', started_at: at('04'), completed_at: at('05') };
  const artifact = { id: 42, name: `sdg-pages-release-${sourceCommit}-2`, expired: false,
    created_at: at('03'), digest: `sha256:${sha256(archive)}`, workflow_run: { id: 41, head_sha: sourceCommit } };
  const native = new Map([
    ['actions/runs/41/attempts/2', run],
    ['actions/runs/41/attempts/2/jobs?per_page=100', { total_count: 2, jobs: [build, deploy] }],
    ['actions/runs/41/artifacts?per_page=100', { total_count: 1, artifacts: [artifact] }],
  ]);
  const publicBytes = new Map([[SDG_PAGES_RELEASE_PATH, manifest], [`wirkungsticker/sdg/ausgabe/${edition.id}/`, html]]);
  const take = (store, key) => {
    assert.ok(store.has(key), `Unexpected or repeated request: ${key}`);
    const value = store.get(key);
    store.delete(key);
    return value;
  };
  const options = {
    readNative: route => readSdgPublicNativeMetadata(route, async (url, init) => {
      assert.equal(url, `https://api.github.com/repos/${SDG_PAGES_REPOSITORY}/${route}`);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      return new Response(JSON.stringify(take(native, route)));
    }),
    readPublic: route => take(publicBytes, route),
    clock: () => at('06'),
  };
  const sdg = { reconcile: (cursor, archive) => reconcileRunnerSdgPagesDelivery({
    root, ledger, committed: cursor, evidenceDirectory: path.join(dir, 'receipts'),
  }, archive, options) };
  return { archive, committed, ledger, edition, native, publicBytes, sdg };
}

test('the runner downloads just the requested ZIP and Oracle uses its own metadata and public bytes to acknowledge', async t => {
  const f = fixture(t);
  let downloads = 0;
  const options = { sdg: f.sdg, committed: f.committed, downloadArchive(id) {
    downloads++;
    assert.equal(id, '42');
    return f.archive;
  } };
  assert.deepEqual(await reconcileSdgReceiptFromRunner(options), { status: 'confirmed', edition_id: f.edition.id });
  assert.equal(f.ledger.readDelivery(f.edition.id).audit_artifact_sha256, sha256(f.archive));
  assert.deepEqual(await reconcileSdgReceiptFromRunner(options), { status: 'current' });
  assert.equal(downloads, 1);
  assert.equal(f.native.size, 0);
  assert.equal(f.publicBytes.size, 0);
});

test('Oracle rejects the wrong artifact ID and tampered ZIP without losing its checked metadata', async t => {
  const f = fixture(t);
  const request = await f.sdg.reconcile(f.committed);
  assert.equal(request.status, 'archive_required');
  assert.equal(request.artifact_sha256, sha256(f.archive));
  assert.equal(f.ledger.readDelivery(f.edition.id), null);
  const upload = { artifact_id: request.artifact_id, manifest_observation: request.manifest_observation,
    archive_base64: f.archive.toString('base64') };
  await assert.rejects(f.sdg.reconcile(f.committed, { ...upload, artifact_id: '43' }), /SDG_PAGES_RUNNER_ARCHIVE_INVALID/);
  await assert.rejects(f.sdg.reconcile(f.committed, { ...upload, archive_base64: Buffer.from('bad ZIP').toString('base64') }),
    /SDG_PAGES_AUDIT_ARTIFACT_MISMATCH/);
  assert.equal(f.ledger.readDelivery(f.edition.id), null);
  assert.deepEqual(await f.sdg.reconcile(f.committed, upload), { status: 'confirmed', edition_id: f.edition.id });
  assert.equal(f.native.size, 0);
  assert.equal(f.publicBytes.size, 0);
});

test('the Oracle metadata reader cannot be used as an archive or alternate-host client', async () => {
  const neverFetch = () => assert.fail('Route must be rejected before the network');
  await assert.rejects(readSdgPublicNativeMetadata('actions/artifacts/42/zip', neverFetch), /SDG_PAGES_NATIVE_ROUTE_INVALID/);
  await assert.rejects(readSdgPublicNativeMetadata('https://example.org/actions/runs/41/attempts/2', neverFetch),
    /SDG_PAGES_NATIVE_ROUTE_INVALID/);
});
