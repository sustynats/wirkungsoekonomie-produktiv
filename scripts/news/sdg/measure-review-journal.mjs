import { hash } from '../bridge/contract.mjs';
import { handoffReviewedMeasure, prepareReviewedMeasure } from './reviewed-measure-handoff.mjs';

function reviewKey(packet, receipt) {
  if (!receipt || !packet?.sdg_measure) throw Error('SDG_MEASURE_INDEPENDENT_REVIEW_REQUIRED');
  const { case_id, revision_id } = packet.sdg_measure;
  return hash([case_id, revision_id, hash(packet), hash(receipt)]);
}

function reviewTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw Error('SDG_MEASURE_REVIEW_TIME_INVALID');
  }
  return value;
}

function checkedReview({ id, body, body_sha256 }) {
  if (hash(body) !== body_sha256) throw Error('SDG_MEASURE_REVIEW_JOURNAL_CHANGED');
  const review = JSON.parse(body);
  if (reviewKey(review.packet, review.receipt) !== id) throw Error('SDG_MEASURE_REVIEW_JOURNAL_BINDING_CHANGED');
  reviewTime(review.accepted_at);
  return review;
}

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
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sdg_review_revision ON sdg_measure_reviews
        (json_extract(body, '$.packet.sdg_measure.revision_id'));
      CREATE TABLE IF NOT EXISTS sdg_review_cutoff (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        closed_through TEXT NOT NULL
      ) STRICT
    `);
  }

  read(id) {
    const row = this.db.prepare('SELECT * FROM sdg_measure_reviews WHERE id = ?').get(id);
    return row ? checkedReview(row) : null;
  }

  #transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  accept(id, makeReview) {
    return this.#transaction(() => {
      const stored = this.read(id);
      if (stored) return stored;
      const review = makeReview();
      const acceptedAt = reviewTime(review.accepted_at);
      const cutoff = this.db.prepare('SELECT closed_through FROM sdg_review_cutoff WHERE id = 1').get();
      if (reviewKey(review.packet, review.receipt) !== id) throw Error('SDG_MEASURE_REVIEW_JOURNAL_BINDING_CHANGED');
      if (cutoff && acceptedAt <= reviewTime(cutoff.closed_through)) {
        throw Error('SDG_MEASURE_REVIEW_CUTOFF_CLOSED');
      }
      const prior = this.db.prepare(`
        SELECT id FROM sdg_measure_reviews WHERE json_extract(body, '$.packet.sdg_measure.revision_id') = ?
      `).get(review.packet.sdg_measure.revision_id);
      if (prior) throw Error('SDG_MEASURE_REVIEW_REVISION_CONFLICT');
      const body = JSON.stringify(review);
      this.db.prepare('INSERT INTO sdg_measure_reviews VALUES (?, ?, ?)').run(id, body, hash(body));
      return review;
    });
  }

  *closeThrough(checkedThrough, now) {
    if (reviewTime(checkedThrough) > reviewTime(now)) throw Error('SDG_MEASURE_REVIEW_CUTOFF_IN_FUTURE');
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO sdg_review_cutoff VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET closed_through = excluded.closed_through
        WHERE excluded.closed_through > sdg_review_cutoff.closed_through
      `).run(checkedThrough);
    });
    // Further acceptances are now strictly after this cutoff. Existing
    // journal rows are immutable, including on a retry after interruption.
    for (const row of this.db.prepare('SELECT * FROM sdg_measure_reviews ORDER BY id').iterate()) {
      const review = checkedReview(row);
      if (review.accepted_at <= checkedThrough) yield { id: row.id, review };
    }
  }
}

export function recoverClosedMeasureReviews({ checkedThrough, now }, { journal, measures, editions }) {
  const accepted = new Map();
  const missing = [];
  for (const { id, review } of journal.closeThrough(checkedThrough, now)) {
    const { case_id: caseId, revision_id: revisionId } = review.packet.sdg_measure;
    if (accepted.has(revisionId)) throw Error('SDG_MEASURE_REVIEW_REVISION_CONFLICT');
    const saved = editions.readDossier(revisionId);
    let dossierHash;
    if (saved) {
      const receipt = saved.dossier.review;
      if (saved.dossier.case_id !== caseId || saved.dossier.revision?.revision_id !== revisionId ||
          receipt?.id !== id || receipt.receipt_hash !== hash(review.receipt) ||
          receipt.packet_hash !== review.receipt.review_packet_hash || receipt.accepted_at !== review.accepted_at) {
        throw Error('SDG_MEASURE_REVIEW_HANDOFF_CONFLICT');
      }
      dossierHash = saved.dossierHash;
    } else {
      const prepared = prepareReviewedMeasure({ caseId, revisionId, reviewId: id, now }, measures, review);
      missing.push(prepared);
      dossierHash = hash(prepared.dossier);
    }
    accepted.set(revisionId, { readyAt: review.accepted_at, dossierHash });
  }
  if (missing.length) editions.recordReady(missing);
  return accepted;
}

// prepareRecord is the existing reviewed-story intake, executed only for a
// new receipt. The MPD gate is checked before acceptance and again at handoff.
export async function stageIndependentMeasureReview({ packet, receipt, now }, {
  measures, editions, journal, prepareRecord,
}) {
  const clock = typeof now === 'function' ? now : () => now;
  const reviewId = reviewKey(packet, receipt);
  const { case_id: caseId, revision_id: revisionId } = packet.sdg_measure;
  let stored = journal.read(reviewId);
  if (!stored) {
    const result = await prepareRecord(packet, clock());
    // A crash after this commit can resume from the journal without importing
    // another draft, moving the acceptance time or issuing a new review.
    stored = journal.accept(reviewId, () => {
      const acceptedAt = clock();
      const proposed = { record: result.record, packet, receipt, existing: result.existing ?? null, accepted_at: acceptedAt };
      prepareReviewedMeasure({ caseId, revisionId, reviewId, now: acceptedAt }, measures, proposed);
      return proposed;
    });
  }
  if (hash(stored.packet) !== hash(packet) || hash(stored.receipt) !== hash(receipt)) {
    throw Error('SDG_MEASURE_REVIEW_JOURNAL_BINDING_CHANGED');
  }
  return handoffReviewedMeasure({ caseId, revisionId, reviewId, now: clock() }, {
    measures, editions, readReview: () => stored,
  });
}
