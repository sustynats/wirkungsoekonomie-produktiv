import assert from 'node:assert/strict';
import test from 'node:test';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';
import { handoffReviewedMeasure, measureReviewBinding } from '../../scripts/news/sdg/reviewed-measure-handoff.mjs';
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
    analysis: { impact_assessment: assessment } };
  const record = {
    story_id: packet.story_id, title: packet.title, analysis: structuredClone(packet.analysis),
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
