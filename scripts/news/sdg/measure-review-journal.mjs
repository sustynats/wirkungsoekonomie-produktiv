import { hash } from '../bridge/contract.mjs';
import { handoffReviewedMeasure, prepareReviewedMeasure } from './reviewed-measure-handoff.mjs';

// A separate table in the authenticated Oracle bridge database. Only the
// explicit independent-review import writes here. Generic job updates and
// worker output cannot replace a previously accepted review.
export class MeasureReviewJournal {
  constructor(bridgeStore) {
    this.db = bridgeStore.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sdg_measure_reviews (
        id TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL,
        body_sha256 TEXT NOT NULL
      ) STRICT
    `);
  }

  read(id) {
    const row = this.db.prepare('SELECT body, body_sha256 FROM sdg_measure_reviews WHERE id = ?').get(id);
    if (!row) return null;
    if (hash(row.body) !== row.body_sha256) throw Error('SDG_MEASURE_REVIEW_JOURNAL_CHANGED');
    return JSON.parse(row.body);
  }

  accept(id, review) {
    const body = JSON.stringify(review);
    this.db.prepare(`
      INSERT INTO sdg_measure_reviews VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING
    `).run(id, body, hash(body));
    return this.read(id);
  }
}

// prepareRecord is the existing reviewed-story intake, executed only for a
// new receipt. The MPD gate is checked before acceptance and again at handoff.
export async function stageIndependentMeasureReview({ packet, receipt, now }, {
  measures, editions, journal, prepareRecord,
}) {
  if (!receipt || !packet?.sdg_measure) throw Error('SDG_MEASURE_INDEPENDENT_REVIEW_REQUIRED');
  const { case_id: caseId, revision_id: revisionId } = packet.sdg_measure;
  const reviewId = hash([caseId, revisionId, hash(packet), hash(receipt)]);
  const target = { caseId, revisionId, reviewId, now };
  let stored = journal.read(reviewId);
  if (!stored) {
    const result = await prepareRecord(packet, now);
    const proposed = { record: result.record, packet, receipt, existing: result.existing ?? null, accepted_at: now };
    prepareReviewedMeasure(target, measures, proposed);
    // A crash after this commit can resume from the journal without importing
    // another draft, moving the acceptance time or issuing a new review.
    stored = journal.accept(reviewId, proposed);
  }
  if (hash(stored.packet) !== hash(packet) || hash(stored.receipt) !== hash(receipt)) {
    throw Error('SDG_MEASURE_REVIEW_JOURNAL_BINDING_CHANGED');
  }
  return handoffReviewedMeasure(target, { measures, editions, readReview: () => stored });
}
