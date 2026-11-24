import { createHash } from 'node:crypto';
import { finalizeReviewedImpact } from '../reviewed-impact.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function evidenceKey(source) {
  return JSON.stringify([source.registry_id, source.reference, source.snapshot_sha256]);
}

// An explicit projection of the particular revision and sources seen by the
// reviewer. Other subsequently registered evidence belongs to its own review.
export function measureReviewBinding(measures, { caseId, revisionId, record }) {
  const entry = measures.timeline(caseId).find(item => item.revision_id === revisionId);
  if (!entry) throw Error('SDG_MEASURE_REVISION_UNKNOWN');
  if (!Array.isArray(record.sources) || !record.sources.length) throw Error('SDG_MEASURE_EVIDENCE_REQUIRED');
  const available = new Map(entry.sources.map(item => [evidenceKey(item), item]));
  const attached = new Map();
  const sourceIds = new Set();
  for (const source of record.sources) {
    if (typeof source.source_id !== 'string' || !source.source_id.trim() ||
        sourceIds.has(source.source_id) || !source.sdg_evidence) {
      throw Error('SDG_MEASURE_EVIDENCE_UNBOUND');
    }
    sourceIds.add(source.source_id);
    const key = evidenceKey(source.sdg_evidence);
    const original = available.get(key);
    if (!original || original.url !== source.url || attached.has(key)) throw Error('SDG_MEASURE_EVIDENCE_UNBOUND');
    attached.set(key, original);
  }
  const { sources: _, ...eventRevision } = entry;
  const evidence = [...attached.values()].sort((a, b) => {
    const left = evidenceKey(a);
    const right = evidenceKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    binding: {
      case_id: caseId,
      revision_id: revisionId,
      revision_sha256: sha(eventRevision),
      evidence_sha256: sha(evidence),
      record_sources_sha256: sha({
        sources: record.sources,
        impact_sources: record.impact_sources ?? [],
        source_snapshot: record.source_snapshot ?? [],
      }),
    },
    evidence,
    discovered_at: entry.discovered_at,
    eventRevision,
  };
}

// readReview must read an independently persisted review, not a proposed
// writer output or a client-provided approval payload.
export async function handoffReviewedMeasure({ caseId, revisionId, reviewId, now }, {
  measures, editions, readReview,
}) {
  const stored = await readReview(reviewId);
  if (!stored) return { status: 'awaiting_review' };
  const prepared = prepareReviewedMeasure({ caseId, revisionId, reviewId, now }, measures, stored);
  const { dossier, ...item } = prepared;
  editions.recordReady([prepared]);
  return { status: 'staged_for_edition', item };
}

export function prepareReviewedMeasure({ caseId, revisionId, reviewId, now }, measures, stored) {
  const { record, packet, receipt, existing = null } = stored;
  const projection = measureReviewBinding(measures, { caseId, revisionId, record });
  if (sha(packet.sdg_measure ?? null) !== sha(projection.binding)) throw Error('SDG_MEASURE_REVIEW_BINDING_CHANGED');
  const reviewedAt = Date.parse(receipt?.reviewed_at);
  if (!Number.isFinite(reviewedAt) || Date.parse(projection.discovered_at) > reviewedAt ||
      projection.evidence.some(item => Date.parse(item.discovered_at) > reviewedAt)) {
    throw Error('SDG_MEASURE_REVIEW_BEFORE_EVIDENCE');
  }
  const acceptedAt = Date.parse(stored.accepted_at);
  const checkedAt = Date.parse(now);
  if (!Number.isFinite(acceptedAt) || !Number.isFinite(checkedAt) || acceptedAt < reviewedAt || acceptedAt > checkedAt) {
    throw Error('SDG_MEASURE_REVIEW_ACCEPTANCE_TIME_INVALID');
  }
  const readyAt = new Date(acceptedAt).toISOString();
  const reviewed = finalizeReviewedImpact(record, packet, receipt, existing, readyAt);
  const dossier = {
    revision: projection.eventRevision,
    evidence: projection.evidence,
    record: { ...reviewed, published: false, published_at: null },
    review: { id: reviewId, packet_hash: receipt.review_packet_hash,
      receipt_hash: sha(receipt), reviewed_at: receipt.reviewed_at, accepted_at: readyAt },
  };
  return {
    id: revisionId,
    analysisHash: sha(reviewed.impact_assessment),
    sourceHash: sha([projection.binding.evidence_sha256, projection.binding.record_sources_sha256]),
    readyAt,
    dossier,
  };
}
