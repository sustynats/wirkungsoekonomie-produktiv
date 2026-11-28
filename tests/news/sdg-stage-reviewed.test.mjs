import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hash } from '../../scripts/news/bridge/contract.mjs';
import { SEMANTIC_CHECKS } from '../../scripts/news/impact-publication.mjs';
import { readRepositoryJson } from '../../scripts/news/newsroom-store.mjs';
import { prepareReviewedStory } from '../../scripts/news/publish-reviewed.mjs';
import { loadNewsRegistry } from '../../scripts/news/registry.mjs';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';
import { packageSdgEdition } from '../../scripts/news/sdg/package-edition.mjs';
import { measureReviewBinding } from '../../scripts/news/sdg/reviewed-measure-handoff.mjs';
import { syntheticPotentialAssessment, syntheticScopeReview } from './fixtures/impact21.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stager = path.join(root, 'scripts/news/sdg/stage-reviewed.mjs');
const reviewedAt = '2026-09-09T22:00:00.000Z';

test('staging CLI binds the exact private source proof and packages only public fields', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'woek-sdg-stage-'));
  try {
    const reviewFile = path.join(directory, 'review.json');
    const receiptFile = path.join(directory, 'receipt.json');
    const measureFile = path.join(directory, 'measures.sqlite');
    const editionFile = path.join(directory, 'editions.sqlite');
    const draft = readRepositoryJson(path.join(root, 'content/news/reviews/2026-09-09-generaldebatte-nachricht.json'));
    const packet = {
      ...draft,
      review_type: 'story',
      event_key: 'synthetic-sdg-stage-reviewed',
      story_id: `wt-${hash('synthetic-sdg-stage-reviewed').slice(0, 16)}`,
    };
    const leadSourceId = packet.sources[0].source_id;
    const assessment = JSON.parse(JSON.stringify(syntheticPotentialAssessment()).replaceAll('"official"', JSON.stringify(leadSourceId)));
    assessment.system_check.enablement = ['enables_budget_control'];
    packet.analysis.impact_assessment = assessment;
    delete packet.analysis.direction_assessment_version;

    const event = {
      case: { authority: 'test-authority', reference: 'test-measure' },
      event: { authority: 'test-authority', reference: 'test-event', domain: 'legal', stage: 'proposed' },
      event_at: packet.original_event_date,
      supersedes: null,
      value: { fixture: 'synthetic stage projection only' },
    };
    const measures = new MeasureRevisions(measureFile);
    let target;
    try {
      for (const [index, source] of packet.sources.entries()) {
        const proof = {
          registry_id: source.source_id,
          reference: `PRIVATE-STAGE-SOURCE-REFERENCE-${index}`,
          snapshot_sha256: hash(`private snapshot ${index}`),
        };
        source.sdg_evidence = proof;
        [target] = measures.recordBatch([{ ...event, source: {
          ...proof,
          url: source.url,
          published_at: source.published_at,
          discovered_at: packet.research_checked_at,
        } }]);
      }
      const registry = loadNewsRegistry(root);
      const { errors, record } = prepareReviewedStory(packet, registry, [], reviewedAt);
      assert.deepEqual(errors, []);
      assert.ok(record.sources.every(source => !Object.hasOwn(source, 'sdg_evidence')));
      const boundRecord = { ...record, sources: record.sources.map(source => ({
        ...source,
        sdg_evidence: packet.sources.find(original => original.source_id === source.source_id).sdg_evidence,
      })) };
      packet.sdg_measure = measureReviewBinding(measures, { ...target, record: boundRecord }).binding;
    } finally {
      measures.close();
    }

    const receipt = {
      kind: 'independent_agent_semantic_review',
      story_id: packet.story_id,
      review_packet_hash: hash(packet),
      author_actor: 'synthetic-stage-author',
      reviewer_actor: 'synthetic-stage-reviewer',
      reviewed_at: reviewedAt,
      expected_content_hash: packet.expected_content_hash,
      expected_analysis_hash: packet.expected_analysis_hash,
      review: {
        status: 'ready',
        scope: syntheticScopeReview(assessment),
        checks: Object.fromEntries(SEMANTIC_CHECKS.map(key => [key, {
          status: 'pass', rationale: 'Synthetische Testentscheidung für die protokollierte Prüfung.',
        }])),
      },
    };
    const invoke = () => spawnSync(process.execPath, [
      stager, `--review=${reviewFile}`, `--impact-review=${receiptFile}`,
      `--bridge-db=${path.join(directory, 'bridge.sqlite')}`, `--measure-db=${measureFile}`, `--edition-db=${editionFile}`,
    ], { encoding: 'utf8' });
    const tampered = structuredClone(packet);
    tampered.sources[0].sdg_evidence.snapshot_sha256 = hash('unregistered source snapshot');
    writeFileSync(reviewFile, JSON.stringify(tampered));
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, review_packet_hash: hash(tampered) }));
    const rejected = invoke();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /SDG_MEASURE_EVIDENCE_UNBOUND/);

    writeFileSync(reviewFile, JSON.stringify(packet));
    writeFileSync(receiptFile, JSON.stringify(receipt));
    const outcome = invoke();
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), { status: 'staged_for_edition', revision_id: target.revisionId });
    const retried = invoke();
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(retried.stdout, outcome.stdout);

    const editions = new EditionLedger(editionFile);
    try {
      const { dossier } = editions.readDossier(target.revisionId);
      assert.equal(dossier.record.published, false);
      assert.deepEqual(dossier.record.sources.map(source => source.sdg_evidence), packet.sources.map(source => source.sdg_evidence));
      const ready = dossier.review.accepted_at;
      const edition = editions.stage({ date: ready.slice(0, 10), slot: 'abendlage', cutoff: ready, sealedAt: ready });
      const packaged = packageSdgEdition(editions, edition.id);
      assert.equal(packaged.manifest.items.length, 1);
      assert.deepEqual(new Set(packaged.manifest.items[0].sources.map(source => source.url)), new Set(packet.sources.map(source => source.url)));
      assert.doesNotMatch(JSON.stringify(packaged), /sdg_evidence|snapshot_sha256|PRIVATE-STAGE-SOURCE-REFERENCE|synthetic-stage-reviewer/);
    } finally {
      editions.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
