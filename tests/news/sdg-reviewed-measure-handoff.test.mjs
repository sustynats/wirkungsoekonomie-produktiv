import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../../scripts/news/bridge/store.mjs';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';
import { handoffReviewedMeasure, measureReviewBinding } from '../../scripts/news/sdg/reviewed-measure-handoff.mjs';
import { MeasureReviewJournal, stageIndependentMeasureReview } from '../../scripts/news/sdg/measure-review-journal.mjs';
import { packageSdgEdition, writeSdgEditionCandidate } from '../../scripts/news/sdg/package-edition.mjs';
import { buildSdgEditionPages } from '../../scripts/news/sdg/edition-pages.mjs';
import { registerSdgEdition } from '../../scripts/news/sdg/register-edition.mjs';
import { loadSdgTickerPresentation, readSdgReleaseCatalog } from '../../scripts/news/sdg/release-catalog.mjs';
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
    const [detailRoute, indexRoute] = render();
    assert.equal(indexRoute, 'wirkungsticker/sdg/');
    assert.equal(detailRoute, `wirkungsticker/sdg/ausgabe/${edition.id}/`);
    assert.equal(written.size, 2);
    assert.match(written.get(detailRoute + 'index.html'), new RegExp(`sdg-${target.revisionId}`));
    assert.equal([...written.get(detailRoute + 'index.html').matchAll(/<article id="sdg-/g)].length, 42);
    assert.match(written.get(indexRoute + 'index.html'), /Global SDG Impact Tracker/);
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
        pageShell: data => appNavigation(data.canonical, { sdgActive: data.sdgActive }) + data.body,
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
    assert.doesNotMatch(active.get(homepage), /Ältere Meldung/);
    assert.match(active.get(archive), /Ältere Meldung/);
    assert.match(active.get(archive), /Nachrichtenarchiv/);
    for (const item of analyses) assert.ok(active.get(homepage).includes(item.title));
    rmSync(config);
    assert.deepEqual(render(), initial);
    assert.equal(readSdgReleaseCatalog(root).sha256, release.catalog_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));
