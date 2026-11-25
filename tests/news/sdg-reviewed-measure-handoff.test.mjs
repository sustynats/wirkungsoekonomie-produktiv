import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BridgeStore } from '../../scripts/news/bridge/store.mjs';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';
import { handoffReviewedMeasure, measureReviewBinding } from '../../scripts/news/sdg/reviewed-measure-handoff.mjs';
import { MeasureReviewJournal, stageIndependentMeasureReview } from '../../scripts/news/sdg/measure-review-journal.mjs';
import { packageSdgEdition, writeSdgEditionCandidate } from '../../scripts/news/sdg/package-edition.mjs';
import { confirmSdgPagesDelivery, reconcileSdgPagesDelivery } from '../../scripts/news/sdg/confirm-pages-delivery.mjs';
import { impactMethodology } from '../../scripts/news/impact-methodology.mjs';
import { applySdgAppDescription, SDG_TRACKER_DESCRIPTION, SDG_TRACKER_EVIDENCE, SDG_TRACKER_INTRO } from '../../scripts/news/sdg/presentation.mjs';
import { SDG_PAGES_RELEASE_PATH, verifySdgPagesDelivery, writeSdgPagesRelease } from '../../scripts/news/sdg/pages-release.mjs';
import { prepareScheduledSdgEditions } from '../../scripts/news/sdg/prepare-scheduled-editions.mjs';
import { buildSdgEditionPages } from '../../scripts/news/sdg/edition-pages.mjs';
import { registerSdgEdition } from '../../scripts/news/sdg/register-edition.mjs';
import { loadSdgTickerPresentation, readSdgReleaseCatalog } from '../../scripts/news/sdg/release-catalog.mjs';
import { importFirstSdgPackage, importSdgBridgeEditions } from '../../scripts/news/sdg/import-bridge-editions.mjs';
import { serveSdgEditions } from '../../scripts/news/sdg/bridge-editions.mjs';
import { appNavigation, buildAppPages } from '../../scripts/news/app-pages.mjs';
import { sha256 } from '../../scripts/news/lib.mjs';
import { SEMANTIC_CHECKS } from '../../scripts/news/impact-publication.mjs';
import { syntheticPotentialAssessment, syntheticScopeReview } from './fixtures/impact21.mjs';

const source = {
  registry_id: 'test-registry', reference: 'policy-24', snapshot_sha256: 'a'.repeat(64),
  url: 'https://example.org/synthetic-document', published_at: '2026-11-21', discovered_at: '2026-11-22T10:00:01.000Z',
};
const event = {
  case: { authority: 'test-municipality', reference: 'fictional-programme-55' },
  event: { authority: 'test-municipality', reference: 'policy-24', domain: 'legal', stage: 'adopted' },
  event_at: '2026-11-21', supersedes: null, value: { short_description: 'Fiktives Testvorhaben' }, source,
};
const now = '2026-11-24T05:30:00.000Z';
const reviewedAt = '2026-11-24T04:15:00.000Z';
const acceptedAt = '2026-11-24T04:47:00.000Z';
const window = { date: '2026-11-24', slot: 'morgenlage', cutoff: '2026-11-24T05:00:00.000Z', sealedAt: now };
const reviewId = 'synthetic-independent-review';

function bind(measures, target) {
  const assessment = syntheticPotentialAssessment();
  const packet = { story_id: 'synthetic-story', title: 'Synthetischer Prüfgegenstand',
    expected_content_hash: 'previous-content', expected_analysis_hash: 'previous-analysis',
    analysis: { impact_assessment: assessment, source_summary: 'Die Testfassung beginnt mit einem fiktiven Beschluss.' } };
  const record = {
    story_id: packet.story_id, title: packet.title, analysis: structuredClone(packet.analysis),
    source_summary: packet.analysis.source_summary,
    impact_assessment: structuredClone(assessment),
    sources: [{ source_id: 'official', title: 'Synthetischer Beleg', url: source.url, sdg_evidence: {
      registry_id: source.registry_id, reference: source.reference, snapshot_sha256: source.snapshot_sha256,
    } }],
    versions: [{ version: 1 }], editorial_review: {},
  };
  packet.sdg_measure = measureReviewBinding(measures, { ...target, record }).binding;
  record.content_hash = sha256(JSON.stringify(packet));
  const receipt = {
    kind: 'independent_agent_semantic_review', story_id: packet.story_id,
    review_packet_hash: record.content_hash, author_actor: 'fixture-writer', reviewer_actor: 'fixture-reviewer',
    reviewed_at: reviewedAt, expected_content_hash: packet.expected_content_hash,
    expected_analysis_hash: packet.expected_analysis_hash, review: {
      status: 'ready', scope: syntheticScopeReview(assessment),
      checks: Object.fromEntries(SEMANTIC_CHECKS.map(key => [key, { status: 'pass',
        rationale: 'Explizite unabhängige synthetische Prüfentscheidung.' }])),
    },
  };
  return { record, packet, receipt, accepted_at: acceptedAt };
}

test('the normal ticker writer receives only checked public packages and resumes a broken Oracle transfer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'woek-sdg-writer-'));
  const storage = path.join(dir, 'sdg');
  const oracleRoot = path.join(storage, 'publication');
  const checkout = path.join(dir, 'checkout');
  mkdirSync(storage, { mode: 0o700 });
  mkdirSync(oracleRoot, { mode: 0o700 });
  mkdirSync(checkout);
  const bridge = new BridgeStore(path.join(dir, 'bridge.sqlite'), { lane: 'import' });
  const measures = new MeasureRevisions(path.join(storage, 'measures.sqlite'));
  const editions = new EditionLedger(path.join(storage, 'editions.sqlite'));
  for (const filename of ['editions.sqlite', 'measures.sqlite']) chmodSync(path.join(storage, filename), 0o600);
  try {
    const journal = new MeasureReviewJournal(bridge);
    const [first] = measures.recordBatch([event]);
    const initial = bind(measures, first);
    await stageIndependentMeasureReview({ packet: initial.packet, receipt: initial.receipt, now: acceptedAt }, {
      measures, editions, journal, prepareRecord: () => ({ record: initial.record }),
    });
    const anchor = editions.stage(window);
    const original = registerSdgEdition({ root: oracleRoot, ledger: editions, editionId: anchor.id, expectedCatalogHash: null });
    const packageFile = path.join(oracleRoot, original.paths[0]);
    const initialPackage = { root: checkout, packageFile, editionId: anchor.id, expectedSha256: original.edition_sha256 };
    const malformed = path.join(dir, 'unexpected-wrapper.json');
    writeFileSync(malformed, JSON.stringify({ ...JSON.parse(readFileSync(packageFile, 'utf8')), draft: 'PRIVATE' }));
    assert.throws(() => importFirstSdgPackage({ ...initialPackage, packageFile: malformed }), /SDG_BRIDGE_PUBLIC_PROJECTION_REQUIRED/);
    assert.throws(() => importFirstSdgPackage({ ...initialPackage, expectedSha256: 'f'.repeat(64) }), /SDG_RELEASE_PACKAGE_MISMATCH/);
    assert.equal(readSdgReleaseCatalog(checkout).sha256, null);
    const importer = fileURLToPath(new URL('../../scripts/news/sdg/import-bridge-editions.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [importer, `--first-package=${packageFile}`,
      `--edition-id=${anchor.id}`, `--sha256=${original.edition_sha256}`],
    { cwd: checkout, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
    assert.equal(JSON.parse(output).status, 'registered_for_website_build');
    assert.equal(importFirstSdgPackage(initialPackage).status, 'already_registered');
    assert.equal(loadSdgTickerPresentation(checkout), null);
    const checked = readSdgReleaseCatalog(checkout);
    assert.equal(original.catalog_sha256, checked.sha256);
    assert.ok(readFileSync(path.join(checkout, original.paths[0])).equals(readFileSync(packageFile)));
    const mode = path.join(checkout, 'data/news/sdg/ticker-mode.json');
    writeFileSync(mode, JSON.stringify({ schema_version: 1, mode: 'sdg',
      anchor: { edition_id: anchor.id, sha256: original.edition_sha256 } }));
    assert.throws(() => importFirstSdgPackage(initialPackage), /SDG_FIRST_PACKAGE_MODE_ALREADY_SET/);

    const [next] = measures.recordBatch([{ ...event,
      case: { ...event.case, reference: 'fictional-programme-56' },
      event: { ...event.event, reference: 'policy-25' },
    }]);
    const incoming = bind(measures, next);
    // A larger checked projection spans multiple bridge frames.
    incoming.record.source_summary = 'Synthetischer Prüftext. '.repeat(22_000);
    incoming.record.analysis.source_summary = incoming.packet.analysis.source_summary = incoming.record.source_summary;
    incoming.packet.analysis.reference_frameworks = ['UN SDG 3.8', 'Deutsche Nachhaltigkeitsstrategie'];
    incoming.record.analysis.reference_frameworks = ['PRIVATE-UNREVIEWED-REFERENCE'];
    incoming.record.editorial_draft = 'PRIVATE-MANUSCRIPT-SENTINEL';
    incoming.record.sources[0].article_excerpt = 'PRIVATE-EXCERPT-SENTINEL';
    incoming.packet.sdg_measure = measureReviewBinding(measures, { ...next, record: incoming.record }).binding;
    incoming.record.content_hash = incoming.receipt.review_packet_hash = sha256(JSON.stringify(incoming.packet));
    await stageIndependentMeasureReview({ packet: incoming.packet, receipt: incoming.receipt, now: '2026-11-24T10:45:00.000Z' }, {
      measures, editions, journal, prepareRecord: () => ({ record: incoming.record }),
    });
    const sdg = serveSdgEditions(dir, window.cutoff, bridge, { clock: () => '2026-11-24T11:05:00.000Z' });
    await assert.rejects(importSdgBridgeEditions({ root: checkout, sdg: {
      ...sdg, readPackage: (digest, offset) => {
        if (offset > 0) throw Error('Interrupted transfer');
        return sdg.readPackage(digest, offset);
      },
    } }), /Interrupted transfer/);
    assert.equal(readSdgReleaseCatalog(checkout).sha256, checked.sha256);
    const oracle = readSdgReleaseCatalog(oracleRoot);
    assert.equal(oracle.releases.length, 2);
    const latest = oracle.releases.at(-1);
    assert.equal(latest.manifest.items[0].revision_id, next.revisionId);
    assert.equal(oracle.releases[0].manifest.schema_version, 1);
    assert.equal(oracle.releases[0].sha256, original.edition_sha256);
    assert.equal(latest.manifest.schema_version, 2);
    assert.deepEqual(latest.manifest.items[0].reference_frameworks, incoming.packet.analysis.reference_frameworks);
    assert.equal(sdg.readPackage(latest.sha256, 512 * 1024).offset, 512 * 1024);
    assert.throws(() => sdg.readPackage('f'.repeat(64), 0), /SDG_BRIDGE_PACKAGE_NOT_REGISTERED/);
    assert.throws(() => sdg.prepare({ edition_id: anchor.id, sha256: 'f'.repeat(64) }), /SDG_BRIDGE_CATALOG_PREFIX_MISMATCH/);
    await assert.rejects(importSdgBridgeEditions({ root: checkout, sdg: {
      ...sdg, readPackage: (...args) => ({ ...sdg.readPackage(...args), offset: 1 }),
    } }), /SDG_BRIDGE_PACKAGE_TRANSFER_MISMATCH/);
    assert.equal(readSdgReleaseCatalog(checkout).sha256, checked.sha256);

    assert.deepEqual(await importSdgBridgeEditions({ root: checkout, sdg }), { changed: true, count: 1 });
    const received = readSdgReleaseCatalog(checkout);
    assert.deepEqual(received.releases, oracle.releases);
    assert.equal(received.sha256, oracle.sha256);
    assert.doesNotMatch(JSON.stringify(received.releases), /PRIVATE-|fixture-reviewer|fixture-writer/);
    assert.deepEqual(await importSdgBridgeEditions({ root: checkout, sdg }), { changed: false, count: 0 });
    assert.doesNotMatch(readFileSync(mode, 'utf8'), new RegExp(latest.sha256));
  } finally {
    bridge.close();
    measures.close();
    editions.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one ticker wake acknowledges all matching editions from a bound Pages run with no dispatch response', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  const midday = editions.stage({ ...window, slot: 'mittagslage', cutoff: '2026-11-24T11:00:00.000Z',
    sealedAt: '2026-11-24T11:01:00.000Z' });
  const dir = mkdtempSync(path.join(tmpdir(), 'woek-sdg-reconcile-'));
  try {
    const root = path.join(dir, 'private-catalog');
    const evidenceDirectory = path.join(dir, 'private-evidence');
    mkdirSync(root);
    const morning = registerSdgEdition({ root, ledger: editions, editionId: edition.id, expectedCatalogHash: null });
    const registered = registerSdgEdition({ root, ledger: editions, editionId: midday.id, expectedCatalogHash: morning.catalog_sha256 });
    const committed = { edition_id: midday.id, sha256: registered.edition_sha256 };
    const sourceCommit = '1'.repeat(40);
    const publishedEditions = [edition.id, midday.id].map((id, index) => {
      const sha = index === 0 ? morning.edition_sha256 : registered.edition_sha256;
      return { id, sha, bytes: Buffer.from(`<main id="main-content" data-sdg-edition-sha256="${sha}"><h1>${id}</h1></main>`) };
    });
    const manifest = {
      schema_version: 1, kind: 'sdg_pages_release', repository: 'sustynats/wirkungsoekonomie-produktiv',
      source_commit: sourceCommit, run_id: '901', run_attempt: '1', catalog_sha256: registered.catalog_sha256,
      editions: publishedEditions.map(({ id, sha, bytes }) => ({ edition_id: id, edition_sha256: sha, html_sha256: sha256(bytes) })),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const archive = execFileSync('python3', ['-c', `
import io, sys, zipfile
data = io.BytesIO()
with zipfile.ZipFile(data, "w") as archive:
    archive.writestr("release.json", sys.stdin.buffer.read())
sys.stdout.buffer.write(data.getvalue())
`], { input: manifestBytes });
    const descriptor = { id: 902, name: `sdg-pages-release-${sourceCommit}-1`, expired: false,
      workflow_run: { id: 901, head_sha: sourceCommit }, created_at: '2026-11-24T11:32:00Z',
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
    const run = { id: 901, run_attempt: 1, repository: { full_name: manifest.repository },
      head_branch: 'main', head_sha: sourceCommit, path: '.github/workflows/deploy.yml',
      event: 'push', status: 'completed' };
    const build = { name: 'build', run_id: 901, status: 'completed', conclusion: 'success',
      started_at: '2026-11-24T11:31:00Z', completed_at: '2026-11-24T11:35:00Z' };
    const deploy = { ...build, name: 'deploy', started_at: '2026-11-24T11:35:01Z', completed_at: '2026-11-24T11:36:00Z' };
    const pending = { root, ledger: editions, committed, evidenceDirectory };
    const noRead = () => assert.fail('Unexpected native or public read');
    assert.deepEqual(await reconcileSdgPagesDelivery(pending, {
      readPublic: route => {
        assert.equal(route, SDG_PAGES_RELEASE_PATH);
        return Buffer.from(JSON.stringify({ ...manifest, editions: [] }));
      },
      readNative: noRead,
    }), { status: 'awaiting_delivery' });
    const native = new Map([
      ['actions/runs/901/attempts/1', Buffer.from(JSON.stringify(run))],
      ['actions/runs/901/attempts/1/jobs?per_page=100', Buffer.from(JSON.stringify({ total_count: 2, jobs: [build, deploy] }))],
      ['actions/runs/901/artifacts?per_page=100', Buffer.from(JSON.stringify({ total_count: 1, artifacts: [descriptor] }))],
      ['actions/artifacts/902/zip', archive],
    ]);
    const published = new Map([
      [SDG_PAGES_RELEASE_PATH, manifestBytes],
      ...publishedEditions.map(({ id, bytes }) => [`wirkungsticker/sdg/ausgabe/${id}/`, bytes]),
    ]);
    const once = rows => route => {
      assert.ok(rows.has(route), `Unexpected or repeated request ${route}`);
      const bytes = rows.get(route);
      rows.delete(route);
      return bytes;
    };
    const checked = await reconcileSdgPagesDelivery(pending, {
      readNative: once(native), readPublic: once(published), clock: () => '2026-11-24T11:41:00.000Z',
    });
    assert.deepEqual(checked, { status: 'confirmed', edition_id: edition.id,
      edition_ids: [edition.id, midday.id], remaining_matching_editions: 0 });
    for (const { id, sha } of publishedEditions) {
      const receipt = editions.readDelivery(id);
      assert.equal(receipt.source_commit, sourceCommit);
      assert.equal(receipt.edition_sha256, sha);
      assert.equal(receipt.deployment_job_completed_at, '2026-11-24T11:36:00.000Z');
    }
    assert.equal(native.size, 0);
    assert.equal(published.size, 0);
    assert.deepEqual(await reconcileSdgPagesDelivery(pending, {
      readPublic: noRead, readNative: noRead,
    }), { status: 'current' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

async function withStore(run) {
  const measures = new MeasureRevisions(':memory:');
  const editions = new EditionLedger(':memory:');
  const reviews = new Map();
  const [target] = measures.recordBatch([event]);
  const perform = (overrides = {}) => handoffReviewedMeasure({ ...target, reviewId, now, ...overrides }, {
    readReview: id => reviews.get(id), measures, editions,
  });
  try { await run({ target, measures, editions, reviews, perform }); }
  finally { measures.close(); editions.close(); }
}

test('the existing MPD review gate contributes the exact approved revision and sources to an edition', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  const staged = await perform();
  assert.equal(staged.status, 'staged_for_edition');
  assert.equal(staged.item.readyAt, acceptedAt);
  assert.deepEqual(await perform(), staged);
  assert.deepEqual(await perform({ now: '2026-11-24T05:52:00.000Z' }), staged);
  // New independent evidence is retained without changing an already reviewed snapshot.
  measures.recordBatch([{ ...event, source: { ...source, registry_id: 'further-source',
    url: 'https://example.net/further-proof', discovered_at: now } }]);
  assert.deepEqual(await perform(), staged);
  const edition = editions.stage(window);
  assert.equal(edition.publication_at, null);
  assert.equal(edition.state, 'staged');
  const { dossier, dossierHash } = editions.readDossier(target.revisionId);
  assert.equal(dossier.record.published_at, null);
  assert.equal(dossier.review.reviewed_at, reviewedAt);
  assert.equal(dossier.review.accepted_at, acceptedAt);
  assert.equal(dossier.revision.revision_id, target.revisionId);
  assert.deepEqual(edition.items.map(row => ({ ...row })), [{
    id: target.revisionId, analysis_hash: staged.item.analysisHash,
    source_hash: staged.item.sourceHash, ready_at: acceptedAt, dossier_hash: dossierHash,
  }]);
}));

test('absent review, a writer reviewing themself, and an explicitly failed native check do not become ready', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  assert.deepEqual(await perform(), { status: 'awaiting_review' });
  const stored = bind(measures, target);
  reviews.set(reviewId, stored);
  stored.receipt.reviewer_actor = stored.receipt.author_actor;
  await assert.rejects(perform(), /EDITORIAL_IMPACT_REVIEW_BINDING_REQUIRED/);
  stored.receipt.reviewer_actor = 'fixture-reviewer';
  stored.receipt.review.checks.source_fidelity.status = 'fail';
  await assert.rejects(perform(), /EDITORIAL_IMPACT_REVIEW_FAILED/);
  assert.deepEqual(editions.stage(window).items, []);
}));

test('stored review cannot be transferred to a corrected event or a substituted source record', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  const stored = bind(measures, target);
  reviews.set(reviewId, stored);
  const [corrected] = measures.recordBatch([{ ...event, supersedes: target.revisionId,
    value: { short_description: 'Korrigierter Testvorgang' } }]);
  await assert.rejects(perform({ revisionId: corrected.revisionId }), /SDG_MEASURE_REVIEW_BINDING_CHANGED/);
  stored.record.sources[0].title = 'Uitgewisselde brontekst';
  await assert.rejects(perform(), /SDG_MEASURE_REVIEW_BINDING_CHANGED/);
  stored.record.sources[0].url = 'https://example.org/other-source';
  await assert.rejects(perform(), /SDG_MEASURE_EVIDENCE_UNBOUND/);
  assert.deepEqual(editions.stage(window).items, []);
}));

test('a review dated before its source discovery cannot introduce a ready timestamp', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  const stored = bind(measures, target);
  stored.receipt.reviewed_at = '2026-11-22T10:00:00.000Z';
  reviews.set(reviewId, stored);
  await assert.rejects(perform(), /SDG_MEASURE_REVIEW_BEFORE_EVIDENCE/);
  assert.deepEqual(editions.stage(window).items, []);
}));

test('a review entered after the verified cutoff stays pending for the following edition', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  const stored = bind(measures, target);
  stored.accepted_at = '2026-11-24T05:15:00.000Z';
  reviews.set(reviewId, stored);
  assert.equal((await perform()).item.readyAt, stored.accepted_at);
  assert.deepEqual(editions.stage(window).items, []);
  const later = editions.stage({ date: window.date, slot: 'mittagslage', cutoff: '2026-11-24T11:00:00.000Z',
    sealedAt: '2026-11-24T11:03:00.000Z' });
  assert.deepEqual(later.items.map(row => row.id), [target.revisionId]);
}));

test('the review journal resumes a lost private handoff after real SQLite reopen without accepting a second review', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'woek-review-journal-'));
  const file = path.join(dir, 'bridge.sqlite');
  const measures = new MeasureRevisions(':memory:');
  const editions = new EditionLedger(':memory:');
  let store = new BridgeStore(file, { lane: 'import' });
  try {
    const [target] = measures.recordBatch([event]);
    const { packet, receipt, record } = bind(measures, target);
    const incoming = { packet, receipt, now: acceptedAt };
    await assert.rejects(stageIndependentMeasureReview(incoming, {
      measures,
      editions: { recordReady: () => { throw Error('Interrupted stage'); } },
      journal: new MeasureReviewJournal(store),
      prepareRecord: () => ({ record }),
    }), /Interrupted stage/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sdg_measure_reviews').get().count, 1);
    store.close();
    store = new BridgeStore(file, { lane: 'import' });
    const resumed = await stageIndependentMeasureReview({ ...incoming, now }, {
      measures, editions, journal: new MeasureReviewJournal(store),
      prepareRecord: () => assert.fail('A persisted acceptance must not be regenerated'),
    });
    assert.equal(resumed.item.readyAt, acceptedAt);
    assert.equal(editions.stage(window).items[0].id, target.revisionId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sdg_measure_reviews').get().count, 1);
    const id = editions.readDossier(target.revisionId).dossier.review.id;
    store.db.prepare('UPDATE sdg_measure_reviews SET body = ? WHERE id = ?').run('{}', id);
    assert.throws(() => new MeasureReviewJournal(store).read(id), /JOURNAL_CHANGED/);
  } finally {
    store.close();
    measures.close();
    editions.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the review journal cannot accept a failed native source-fidelity check', () => withStore(async ({
  target, measures, editions,
}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'woek-review-hold-'));
  const store = new BridgeStore(path.join(dir, 'bridge.sqlite'), { lane: 'import' });
  try {
    const journal = new MeasureReviewJournal(store);
    const { packet, receipt, record } = bind(measures, target);
    receipt.review.checks.source_fidelity.status = 'fail';
    await assert.rejects(stageIndependentMeasureReview({ packet, receipt, now }, {
      measures, editions, journal, prepareRecord: () => ({ record }),
    }), /EDITORIAL_IMPACT_REVIEW_FAILED/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sdg_measure_reviews').get().count, 0);
    assert.deepEqual(editions.stage(window).items, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('edition packaging emits only checked public fields and writes identical bytes on restart', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  const stored = bind(measures, target);
  stored.record.editorial_draft = 'PRIVATE-MANUSCRIPT-SENTINEL';
  stored.record.sources[0].article_excerpt = 'PRIVATE-SOURCE-EXCERPT-SENTINEL';
  stored.packet.sdg_measure = measureReviewBinding(measures, { ...target, record: stored.record }).binding;
  stored.record.content_hash = stored.receipt.review_packet_hash = sha256(JSON.stringify(stored.packet));
  reviews.set(reviewId, stored);
  await perform();
  const edition = editions.stage(window);
  const pack = packageSdgEdition(editions, edition.id);
  const [item] = pack.manifest.items;
  assert.equal(pack.manifest.published_at, null);
  assert.equal(item.case_id, target.caseId);
  assert.equal(item.revision_id, target.revisionId);
  assert.equal(item.sources[0].url, source.url);
  assert.deepEqual(Object.keys(item.impact), ['human', 'planet', 'democracy']);
  assert.doesNotMatch(JSON.stringify(pack), /PRIVATE-|fixture-writer|sdg_evidence|source_snapshot/);
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-candidate-'));
  try {
    const output = writeSdgEditionCandidate(root, pack);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), pack);
    assert.equal(writeSdgEditionCandidate(root, packageSdgEdition(editions, edition.id)), output);
    writeFileSync(output, 'Changed');
    assert.throws(() => writeSdgEditionCandidate(root, pack), { code: 'EEXIST' });
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('edition packaging stops when manifest or stored dossier bytes differ', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  editions.db.prepare("UPDATE editions SET hash = ? WHERE id = ?").run('c'.repeat(64), edition.id);
  assert.throws(() => packageSdgEdition(editions, edition.id), /SDG_EDITION_MANIFEST_CHANGED/);
  editions.db.prepare("UPDATE editions SET hash = ? WHERE id = ?").run(edition.hash, edition.id);
  editions.db.prepare("UPDATE qualified SET dossier = '{}' WHERE id = ?").run(target.revisionId);
  assert.throws(() => packageSdgEdition(editions, edition.id), /Reviewed dossier content changed/);
}));

test('edition pages render only catalogued checked packages and retain all entries', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  const initial = packageSdgEdition(editions, edition.id);
  const manifest = { ...initial.manifest, items: [
    ...initial.manifest.items,
    ...Array.from({ length: 41 }, (_, index) => ({ ...initial.manifest.items[0],
      revision_id: sha256(`page-fixture-${index}`), title: `Fiktive Fassung ${index + 1}` })),
  ] };
  const pack = { manifest, sha256: sha256(JSON.stringify(manifest)) };
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-pages-'));
  try {
    const storage = path.join(root, 'data/news/sdg');
    const candidate = writeSdgEditionCandidate(path.join(storage, 'editions'), pack);
    const written = new Map();
    const render = () => buildSdgEditionPages({ root, site: 'https://example.org',
      write: (filename, text) => written.set(path.relative(root, filename), text),
      pageShell: data => data.body,
      escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    });
    assert.deepEqual(render(), []);
    assert.equal(written.size, 0);
    writeFileSync(path.join(storage, 'release-catalog.json'), JSON.stringify({
      schema_version: 1, releases: [{ edition_id: edition.id, sha256: pack.sha256 }],
    }));
    const detailRoute = `wirkungsticker/sdg/ausgabe/${edition.id}/`;
    const caseRoute = `wirkungsticker/sdg/massnahme/${target.caseId}/`;
    const indexRoute = 'wirkungsticker/sdg/';
    assert.deepEqual(render(), [detailRoute, caseRoute, indexRoute]);
    assert.equal(written.size, 3);
    const detail = written.get(detailRoute + 'index.html');
    const measure = written.get(caseRoute + 'index.html');
    assert.match(detail, new RegExp(`sdg-${target.revisionId}`));
    assert.ok(detail.includes(`href="/${caseRoute}#sdg-${target.revisionId}"`));
    assert.ok(measure.includes(`href="/${detailRoute}#sdg-${target.revisionId}"`));
    for (const html of [detail, measure]) {
      assert.equal([...html.matchAll(/<article id="sdg-/g)].length, 42);
      for (const item of manifest.items) assert.ok(html.includes(`id="sdg-${item.revision_id}"`));
    }
    assert.match(written.get(indexRoute + 'index.html'), /SDG-Ausgaben des Global SDG Impact Trackers/);
    assert.match(written.get(detailRoute + 'index.html'), /SDG-Morgenupdate/);
    assert.ok(written.get(indexRoute + 'index.html').includes(SDG_TRACKER_EVIDENCE));
    assert.match(written.get(detailRoute + 'index.html'), /Prüfschluss/);
    assert.match(written.get(detailRoute + 'index.html'), /Erfasst am/);
    assert.doesNotMatch(written.get(detailRoute + 'index.html'), /Veröffentlicht am/);
    const corrupt = structuredClone(pack);
    corrupt.manifest.items[0].title = 'Veränderter Text';
    writeFileSync(candidate, JSON.stringify(corrupt));
    written.clear();
    assert.throws(render, /SDG_RELEASE_PACKAGE_MISMATCH/);
    assert.equal(written.size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('release catalog registration is append-only and survives an uncertain prior acknowledgment', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const firstEdition = editions.stage(window);
  const secondEdition = editions.stage({ date: window.date, slot: 'mittagslage',
    cutoff: '2026-11-24T11:00:00.000Z', sealedAt: '2026-11-24T11:03:00.000Z' });
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-catalog-'));
  try {
    const apply = (id, expectedCatalogHash, ledger = editions) =>
      registerSdgEdition({ root, ledger, editionId: id, expectedCatalogHash });
    const first = apply(firstEdition.id, null);
    assert.equal(first.status, 'registered_for_website_build');
    assert.equal(first.previous_catalog_sha256, null);
    assert.equal(first.paths.length, 2);
    const oldBytes = readFileSync(path.join(root, first.paths[0]), 'utf8');
    const repeated = apply(firstEdition.id, null);
    assert.equal(repeated.status, 'already_registered');
    assert.equal(repeated.catalog_sha256, first.catalog_sha256);
    assert.deepEqual(repeated.paths, []);
    assert.throws(() => apply(secondEdition.id, null), /SDG_RELEASE_CATALOG_MOVED/);
    assert.equal(readSdgReleaseCatalog(root).releases.length, 1);
    const second = apply(secondEdition.id, first.catalog_sha256);
    assert.equal(second.previous_catalog_sha256, first.catalog_sha256);
    assert.deepEqual(readSdgReleaseCatalog(root).releases.map(row => row.edition_id), [firstEdition.id, secondEdition.id]);
    assert.equal(readFileSync(path.join(root, first.paths[0]), 'utf8'), oldBytes);
    const conflictingLedger = new EditionLedger(':memory:');
    try {
      conflictingLedger.stage(window);
      assert.throws(() => apply(firstEdition.id, second.catalog_sha256, conflictingLedger), /EDITION_IMMUTABLE/);
    } finally { conflictingLedger.close(); }
    assert.equal(readSdgReleaseCatalog(root).sha256, second.catalog_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('ticker presentation can switch and roll back while legacy news and editorial browse routes stay intact', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-ticker-mode-'));
  try {
    const release = registerSdgEdition({ root, ledger: editions, editionId: edition.id, expectedCatalogHash: null });
    const config = path.join(root, 'data/news/sdg/ticker-mode.json');
    const useMode = sha256 => writeFileSync(config, JSON.stringify({
      schema_version: 1, mode: 'sdg', anchor: { edition_id: edition.id, sha256 },
    }));
    const stories = [{ story_id: 'legacy', title: 'Ältere Meldung', slug: 'aeltere-meldung', published_at: now }];
    const analyses = [
      { analysis_id: 'analysis-test', title: 'Geprüfte Analyse', slug: 'gepruefte-analyse', published_at: now },
      { analysis_id: 'podcast-test', subtype: 'listened', title: 'Eigenständiger Podcastbeitrag', slug: 'podcastbeitrag', published_at: now },
      { analysis_id: 'book-test', format: 'book_and_impact', title: 'Eigenständige Buchbesprechung', slug: 'buchbesprechung', published_at: now },
    ];
    const render = () => {
      const sdgTicker = loadSdgTickerPresentation(root);
      const pages = new Map();
      buildAppPages({ root, stories, analyses, storiesById: new Map(), updatedAt: now, sdgTicker,
        storyCard: item => `<article>${item.title}</article>`,
        editorialCard: item => `<article>${item.title}</article>`,
        write: (filename, html) => pages.set(path.relative(root, filename), html),
        pageShell: data => `<meta name="description" content="${data.description}">`
          + appNavigation(data.canonical, { sdgActive: data.sdgActive }) + data.body,
      });
      return pages;
    };
    const homepage = 'wirkungsticker/index.html';
    const archive = 'wirkungsticker/news/index.html';
    const initial = render();
    assert.match(initial.get(homepage), /Aktuelle Meldungen/);
    useMode('f'.repeat(64));
    assert.throws(render, /SDG_TICKER_RELEASE_ANCHOR_REQUIRED/);
    useMode(release.edition_sha256);
    const active = render();
    assert.match(active.get(homepage), /Global SDG Impact Tracker/);
    assert.match(active.get(homepage), /\/wirkungsticker\/sdg\/ausgabe\/2026-11-24-morgenlage\//);
    assert.match(active.get(homepage), /SDG-Ausgaben/);
    assert.ok(active.get(homepage).includes(`<meta name="description" content="${SDG_TRACKER_DESCRIPTION}">`));
    assert.ok(active.get(homepage).includes(SDG_TRACKER_INTRO));
    assert.ok(active.get(homepage).includes(SDG_TRACKER_EVIDENCE));
    assert.match(active.get(homepage), /href="\/wirkungsticker\/methodik\/"/);
    assert.match(impactMethodology({ sdgActive: true }), /Deutsche Nachhaltigkeitsstrategie/);
    assert.match(impactMethodology({ sdgActive: true }), /href="\/verstehen\/sdgs-sdgplus\/"/);
    assert.doesNotMatch(impactMethodology(), /id="sdg-rahmen"/);
    assert.doesNotMatch(active.get(homepage), /Ältere Meldung/);
    assert.match(active.get(archive), /Ältere Meldung/);
    assert.match(active.get(archive), /Nachrichtenarchiv \(RSS\)/);
    assert.match(active.get('wirkungsticker/mehr/index.html'), /Nachrichtenarchiv \(RSS\)/);
    for (const item of analyses) assert.ok(active.get(homepage).includes(item.title));

    const artifactRoot = path.join(root, 'artifact');
    const manifest = readFileSync(new URL('../../wirkungsticker/manifest.webmanifest', import.meta.url), 'utf8');
    const manifestPath = path.join(artifactRoot, 'wirkungsticker/manifest.webmanifest');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifest);
    applySdgAppDescription(artifactRoot);
    const { description, categories, shortcuts, ...identity } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const expectedIdentity = JSON.parse(manifest);
    for (const key of ['description', 'categories', 'shortcuts']) delete expectedIdentity[key];
    assert.deepEqual(identity, expectedIdentity);
    assert.equal(description, SDG_TRACKER_DESCRIPTION);
    assert.deepEqual(categories, ['education']);
    assert.deepEqual(shortcuts.map(item => item.url), ['/wirkungsticker/sdg/', '/wirkungsticker/analysen/']);
    rmSync(config);
    assert.deepEqual(render(), initial);
    assert.equal(readSdgReleaseCatalog(root).sha256, release.catalog_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('automatic stream selector allows legacy writes only with the SDG marker absent', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-automatic-stream-'));
  try {
    const config = path.join(root, 'data/news/sdg/ticker-mode.json');
    const output = path.join(root, 'workflow-output');
    const command = fileURLToPath(new URL('../../scripts/news/sdg/select-automatic-stream.mjs', import.meta.url));
    const select = () => {
      writeFileSync(output, '');
      return spawnSync(process.execPath, [command], {
        cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
      });
    };
    assert.equal(select().status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'legacy_news=true\n');

    const release = registerSdgEdition({ root, ledger: editions, editionId: edition.id, expectedCatalogHash: null });
    const setMode = sha256 => writeFileSync(config, JSON.stringify({
      schema_version: 1, mode: 'sdg', anchor: { edition_id: edition.id, sha256 },
    }));
    setMode(release.edition_sha256);
    assert.equal(select().status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'legacy_news=false\n');

    setMode('f'.repeat(64));
    const invalid = select();
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /SDG_TICKER_RELEASE_ANCHOR_REQUIRED/);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('scheduled editions resume a partial registration without replacing the reviewed package', () => withStore(async ({
  target, measures, editions,
}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-scheduled-registration-'));
  const bridge = new BridgeStore(path.join(root, 'bridge.sqlite'), { lane: 'import' });
  try {
    const journal = new MeasureReviewJournal(bridge);
    const { packet, receipt, record } = bind(measures, target);
    await stageIndependentMeasureReview({ packet, receipt, now: acceptedAt }, {
      measures, editions, journal, prepareRecord: () => ({ record }),
    });
    const startAt = window.cutoff;
    const checkedThrough = '2026-11-24T11:00:00.000Z';
    const sealedAt = '2026-11-25T06:00:00.000Z';
    const params = { root, ledger: editions, journal, measures, startAt, checkedThrough, sealedAt };
    const [morning] = editions.stageDue(params);
    const first = registerSdgEdition({ root, ledger: editions, editionId: morning.id, expectedCatalogHash: null });
    assert.throws(() => prepareScheduledSdgEditions({ ...params, expectedCatalogHash: null }), /CATALOG_MOVED/);
    const wrongLedger = new EditionLedger(':memory:');
    try {
      assert.throws(() => prepareScheduledSdgEditions({
        ...params, ledger: wrongLedger, expectedCatalogHash: first.catalog_sha256,
      }), /SDG_RELEASE_LEDGER_MISMATCH/);
      assert.equal(wrongLedger.read(morning.id), null);
    } finally { wrongLedger.close(); }
    const result = prepareScheduledSdgEditions({ ...params, expectedCatalogHash: first.catalog_sha256 });
    assert.deepEqual(result.editions.map(entry => [entry.edition_id, entry.status]), [
      ['2026-11-24-morgenlage', 'already_registered'], ['2026-11-24-mittagslage', 'registered_for_website_build'],
    ]);
    const catalog = readSdgReleaseCatalog(root);
    assert.equal(catalog.releases[0].sha256, first.edition_sha256);
    assert.deepEqual(catalog.releases.map(entry => entry.manifest.items.length), [1, 0]);
    assert.ok(catalog.releases.every(entry => entry.manifest.published_at === null));
    const resumed = prepareScheduledSdgEditions({ ...params, expectedCatalogHash: result.catalog_sha256 });
    assert.equal(resumed.catalog_sha256, result.catalog_sha256);
    assert.ok(resumed.editions.every(entry => entry.status === 'already_registered' && entry.paths.length === 0));
    const pages = new Map();
    const routes = buildSdgEditionPages({ root, site: 'https://example.org', pageShell: data => data.body,
      write: (filename, html) => pages.set(path.relative(root, filename), html), escapeHtml: String });
    const morningRoute = `wirkungsticker/sdg/ausgabe/${morning.id}/`;
    const caseRoute = `wirkungsticker/sdg/massnahme/${target.caseId}/`;
    assert.deepEqual(routes, [
      'wirkungsticker/sdg/ausgabe/2026-11-24-mittagslage/', morningRoute, caseRoute, 'wirkungsticker/sdg/',
    ]);
    assert.ok(pages.get(morningRoute + 'index.html').includes(`href="/${caseRoute}#sdg-${target.revisionId}"`));
    assert.ok(pages.get(caseRoute + 'index.html').includes(`href="/${morningRoute}#sdg-${target.revisionId}"`));
    assert.match(pages.get('wirkungsticker/sdg/ausgabe/2026-11-24-mittagslage/index.html'), /keine geprüften Einträge/);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
}));

test('closed review cutoff recovers an accepted handoff and admits a concurrent intake only to a later edition', () => withStore(async ({
  target, measures, editions,
}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-closed-review-'));
  const bridgeDatabase = path.join(root, 'bridge.sqlite');
  let bridge = new BridgeStore(bridgeDatabase, { lane: 'import' });
  try {
    const initial = bind(measures, target);
    await assert.rejects(stageIndependentMeasureReview({ ...initial, now: acceptedAt }, {
      measures, journal: new MeasureReviewJournal(bridge),
      editions: { recordReady: () => { throw Error('Interrupted handoff after acceptance'); } },
      prepareRecord: () => ({ record: initial.record }),
    }), /Interrupted handoff/);
    assert.equal(editions.readDossier(target.revisionId), null);

    bridge.close();
    bridge = new BridgeStore(bridgeDatabase, { lane: 'import' });
    const journal = new MeasureReviewJournal(bridge);
    const [later] = measures.recordBatch([{ ...event, case: { ...event.case, reference: 'another-test-programme' } }]);
    const another = bind(measures, later);
    let completeIntake;
    let actualTime = '2026-11-24T04:50:00.000Z';
    const pending = stageIndependentMeasureReview({ ...another, now: () => actualTime }, {
      measures, editions, journal,
      prepareRecord: () => new Promise(resolve => { completeIntake = resolve; }),
    });

    const params = { root, ledger: editions, journal, measures, startAt: window.cutoff };
    const sealTime = '2026-11-24T05:30:01.000Z';
    const clock = [now, sealTime];
    const morning = prepareScheduledSdgEditions({
      ...params, checkedThrough: window.cutoff, sealedAt: () => clock.shift(), expectedCatalogHash: null,
    });
    const revision = editions.readDossier(target.revisionId).dossier;
    assert.equal(revision.review.accepted_at, acceptedAt);
    assert.deepEqual(editions.read('2026-11-24-morgenlage').items.map(item => item.id), [target.revisionId]);
    assert.equal(editions.read('2026-11-24-morgenlage').sealed_at, sealTime);
    assert.equal(editions.readDossier(later.revisionId), null);
    assert.equal(bridge.db.prepare('SELECT COUNT(*) AS count FROM sdg_measure_reviews').get().count, 1);

    // A delayed request cannot allocate the old clock time after the barrier.
    await assert.rejects(stageIndependentMeasureReview({ ...another, now: actualTime }, {
      measures, editions, journal, prepareRecord: () => ({ record: another.record }),
    }), /SDG_MEASURE_REVIEW_CUTOFF_CLOSED/);
    actualTime = '2026-11-24T05:31:00.000Z';
    completeIntake({ record: another.record });
    assert.equal((await pending).item.readyAt, actualTime);
    const lunch = prepareScheduledSdgEditions({
      ...params, checkedThrough: '2026-11-24T11:00:00.000Z', sealedAt: '2026-11-24T11:05:00.000Z',
      expectedCatalogHash: morning.catalog_sha256,
    });
    const publishedCandidates = readSdgReleaseCatalog(root).releases;
    assert.equal(lunch.editions[0].edition_sha256, morning.editions[0].edition_sha256);
    assert.deepEqual(publishedCandidates.map(entry => entry.manifest.items.map(item => item.revision_id)),
      [[target.revisionId], [later.revisionId]]);
    assert.ok(publishedCandidates.every(entry => entry.manifest.published_at === null));
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
}));

test('closed review cutoff rejects a corrupt journal and does not seal an unmatched edition ledger', () => withStore(async ({
  target, measures, editions,
}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'woek-sdg-closed-review-hold-'));
  const bridge = new BridgeStore(path.join(root, 'bridge.sqlite'), { lane: 'import' });
  try {
    const journal = new MeasureReviewJournal(bridge);
    const { packet, receipt, record } = bind(measures, target);
    await stageIndependentMeasureReview({ packet, receipt, now: acceptedAt }, {
      measures, editions, journal, prepareRecord: () => ({ record }),
    });
    editions.recordReady([{ id: 'unmatched', readyAt: acceptedAt, analysisHash: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64), dossier: { synthetic_fixture: true } }]);
    const params = { root, ledger: editions, journal, measures, startAt: window.cutoff,
      checkedThrough: window.cutoff, sealedAt: now, expectedCatalogHash: null };
    assert.throws(() => prepareScheduledSdgEditions(params), /SDG_SCHEDULE_REVIEW_LEDGER_MISMATCH/);
    assert.equal(editions.read('2026-11-24-morgenlage'), null);
    assert.equal(readSdgReleaseCatalog(root).sha256, null);
    bridge.db.exec("UPDATE sdg_measure_reviews SET body = '{}'");
    assert.throws(() => prepareScheduledSdgEditions(params), /SDG_MEASURE_REVIEW_JOURNAL_CHANGED/);
    assert.equal(editions.read('2026-11-24-morgenlage'), null);
    assert.equal(readSdgReleaseCatalog(root).sha256, null);
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
}));

test('SDG Pages receipt works before the homepage cutover and resumes a lost ledger write', () => withStore(async ({
  target, measures, editions, reviews, perform,
}) => {
  reviews.set(reviewId, bind(measures, target));
  await perform();
  const edition = editions.stage(window);
  const scratch = mkdtempSync(path.join(tmpdir(), 'woek-sdg-pages-release-'));
  const root = path.join(scratch, 'repository');
  mkdirSync(root);
  try {
    const artifactRoot = path.join(root, '_site');
    const expectedCommit = '1'.repeat(40);
    const releaseParams = { root, artifactRoot, sourceCommit: expectedCommit, runId: '135', runAttempt: '2' };
    assert.equal(writeSdgPagesRelease(releaseParams), null);
    await assert.rejects(confirmSdgPagesDelivery({
      root, ledger: editions, editionId: edition.id, expectedCommit, runId: '135', runAttempt: '2',
      evidenceDirectory: path.join(scratch, 'private-evidence'),
    }, {
      readNative: () => assert.fail('Unregistered edition requested native evidence'),
      readPublic: () => assert.fail('Unregistered edition requested public evidence'),
    }), /SDG_PAGES_REGISTERED_EDITION_REQUIRED/);
    const registered = registerSdgEdition({ root, ledger: editions, editionId: edition.id, expectedCatalogHash: null });
    const editionSha256 = registered.edition_sha256;
    const modeFile = path.join(root, 'data/news/sdg/ticker-mode.json');
    assert.equal(loadSdgTickerPresentation(root), null);
    buildSdgEditionPages({ root: artifactRoot, site: 'https://wirkungsoekonomie.de', pageShell: data => data.body,
      catalog: readSdgReleaseCatalog(root), escapeHtml: String, write: (file, html) => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, html);
      },
    });
    const editionFile = path.join(artifactRoot, 'wirkungsticker/sdg/ausgabe', edition.id, 'index.html');
    const publicEditionBytes = readFileSync(editionFile);
    writeFileSync(editionFile, '<main id="main-content">Falscher Katalogstand</main>');
    assert.throws(() => writeSdgPagesRelease(releaseParams), /SDG_PAGES_EDITION_BINDING_MISMATCH/);
    writeFileSync(editionFile, publicEditionBytes);
    const release = writeSdgPagesRelease(releaseParams);
    assert.equal(release.catalog_sha256, registered.catalog_sha256);
    const publicManifestBytes = readFileSync(path.join(artifactRoot, SDG_PAGES_RELEASE_PATH));
    assert.deepEqual(writeSdgPagesRelease(releaseParams), release);
    assert.equal(release.editions[0].html_sha256, sha256(publicEditionBytes));

    const auditArchiveBytes = execFileSync('python3', ['-c', `
import io, sys, zipfile
data = io.BytesIO()
with zipfile.ZipFile(data, "w") as archive:
    archive.writestr(sys.argv[1], sys.stdin.buffer.read())
sys.stdout.buffer.write(data.getvalue())
`, path.basename(SDG_PAGES_RELEASE_PATH)], { input: publicManifestBytes });
    const run = { id: 135, run_attempt: 2, repository: { full_name: 'sustynats/wirkungsoekonomie-produktiv' },
      head_branch: 'main', head_sha: '2'.repeat(40), path: '.github/workflows/deploy.yml',
      event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' };
    const build = { name: 'build', run_id: 135, status: 'completed', conclusion: 'success',
      started_at: '2026-11-24T05:31:00Z', completed_at: '2026-11-24T05:35:00Z' };
    const deploy = { name: 'deploy', run_id: 135, status: 'completed', conclusion: 'success',
      started_at: '2026-11-24T05:35:01Z', completed_at: '2026-11-24T05:36:00Z' };
    const jobs = { total_count: 3, jobs: [build, deploy, { name: 'notify-ticker', conclusion: 'failure' }] };
    const auditDigest = createHash('sha256').update(auditArchiveBytes).digest('hex');
    const auditArtifact = { id: 246, name: `sdg-pages-release-${expectedCommit}-2`, expired: false,
      workflow_run: { id: 135, head_sha: run.head_sha }, created_at: '2026-11-24T05:34:00Z',
      digest: `sha256:${auditDigest}` };
    const observedAt = '2026-11-24T05:40:00.000Z';
    const evidence = { expectedCommit, editionId: edition.id, editionSha256, run, jobs, auditArtifact,
      auditArchiveBytes, publicManifestBytes, publicEditionBytes, observedAt };
    const receipt = verifySdgPagesDelivery(evidence);
    assert.equal(receipt.source_commit, expectedCommit);
    assert.equal(receipt.edition_sha256, editionSha256);
    assert.equal(receipt.deployment_job_completed_at, '2026-11-24T05:36:00.000Z');
    assert.equal(receipt.observed_at, observedAt);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, auditArchiveBytes: Buffer.from('modified') }),
      /SDG_PAGES_AUDIT_ARTIFACT_MISMATCH/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, publicEditionBytes: Buffer.from('another release') }),
      /SDG_PAGES_PUBLIC_EDITION_MISMATCH/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, publicManifestBytes: Buffer.from('{}') }),
      /SDG_PAGES_RELEASE_BINDING_MISMATCH/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, run: { ...run, run_attempt: 3 } }),
      /SDG_PAGES_AUDIT_ARTIFACT_MISMATCH/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, jobs: { ...jobs, total_count: 4 } }), /SDG_PAGES_RUN_MISMATCH/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, jobs: { total_count: 2,
      jobs: [build, { ...deploy, conclusion: 'failure' }] } }), /SDG_PAGES_DELIVERY_NOT_SUCCESSFUL/);
    assert.throws(() => verifySdgPagesDelivery({ ...evidence, observedAt: '2026-11-24T05:34:00.000Z' }),
      /SDG_PAGES_OBSERVATION_TIME_INVALID/);

    const routes = new Map([
      ['actions/runs/135/attempts/2', run],
      ['actions/runs/135/attempts/2/jobs?per_page=100', jobs],
      ['actions/runs/135/artifacts?per_page=100', { total_count: 1, artifacts: [auditArtifact] }],
      ['actions/artifacts/246/zip', auditArchiveBytes],
    ]);
    const publicRoutes = new Map([
      [SDG_PAGES_RELEASE_PATH, publicManifestBytes],
      [`wirkungsticker/sdg/ausgabe/${edition.id}/`, publicEditionBytes],
    ]);
    const readOnce = responses => request => {
      assert.ok(responses.has(request), `Unexpected or repeated observation ${request}`);
      const body = responses.get(request);
      responses.delete(request);
      return Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    };
    const database = path.join(scratch, 'editions.sqlite');
    editions.db.prepare('VACUUM INTO ?').run(database);
    let durable = new EditionLedger(database);
    const evidenceDirectory = path.join(scratch, 'private-evidence');
    const options = { root, editionId: edition.id, expectedCommit, runId: '135', runAttempt: '2', evidenceDirectory };
    try {
      await assert.rejects(confirmSdgPagesDelivery({ ...options, ledger: durable }, {
        readNative: request => {
          if (request.endsWith('/zip')) throw Error('Interrupted archive capture');
          return readOnce(routes)(request);
        },
        readPublic: readOnce(publicRoutes), clock: () => observedAt,
      }), /Interrupted archive capture/);
      assert.deepEqual([...routes.keys()], ['actions/artifacts/246/zip']);
      assert.equal(publicRoutes.size, 2);
      durable.recordVerifiedDelivery = () => { throw Error('Interrupted before receipt commit'); };
      await assert.rejects(confirmSdgPagesDelivery({ ...options, ledger: durable }, {
        readNative: readOnce(routes), readPublic: readOnce(publicRoutes), clock: () => observedAt,
      }), /Interrupted before receipt commit/);
      assert.equal(durable.readDelivery(edition.id), null);
      assert.equal(routes.size, 0);
      assert.equal(publicRoutes.size, 0);

      const dir = path.join(evidenceDirectory, `135-2-${expectedCommit}`);
      unlinkSync(path.join(dir, 'public-manifest.json'));
      durable.close();
      durable = new EditionLedger(database);
      const confirmed = await confirmSdgPagesDelivery({ ...options, ledger: durable }, {
        readNative: readOnce(routes), readPublic: readOnce(publicRoutes), clock: () => assert.fail('Observation time changed'),
      });
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.receipt.observed_at, observedAt);
      assert.deepEqual(durable.readDelivery(edition.id), confirmed.receipt);
      assert.equal(durable.read(edition.id).publication_at, null);
      assert.equal(loadSdgTickerPresentation(root), null);
      writeFileSync(modeFile, JSON.stringify({
        schema_version: 1, mode: 'sdg', anchor: { edition_id: edition.id, sha256: '0'.repeat(64) },
      }));
      assert.throws(() => writeSdgPagesRelease(releaseParams), /SDG_TICKER_RELEASE_ANCHOR_REQUIRED/);
      writeFileSync(modeFile, JSON.stringify({
        schema_version: 1, mode: 'sdg', anchor: { edition_id: edition.id, sha256: editionSha256 },
      }));
      assert.deepEqual(writeSdgPagesRelease(releaseParams), release);
      const retry = await confirmSdgPagesDelivery({ ...options, ledger: durable }, {
        readNative: readOnce(routes), readPublic: readOnce(publicRoutes), clock: () => assert.fail('Observation time changed'),
      });
      assert.deepEqual(retry, { status: 'already_confirmed', receipt: confirmed.receipt });
      assert.equal(durable.db.prepare('SELECT COUNT(*) AS count FROM edition_deliveries').get().count, 1);
      durable.db.exec("UPDATE edition_deliveries SET receipt = '{}'");
      assert.throws(() => durable.readDelivery(edition.id), /SDG_EDITION_DELIVERY_CHANGED/);
    } finally { durable.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}));
