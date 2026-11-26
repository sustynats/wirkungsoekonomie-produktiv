import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalObservationJson, measureId } from './measure-revisions.mjs';

const SOURCE = 'dns_1_1_ab';
const URL = 'https://dns-indikatoren.de/sdg-data-pub/de/data/1-1-ab.csv';
const DIMENSIONS = ['Units', 'Zeitreihe', 'Gebiet', 'Geschlecht', 'Altersklasse', 'Bundesland', 'GeoCode'];
const FLAGS = ['COMMENT_OBS_0', 'COMMENT_OBS_1'];
const hash = value => createHash('sha256').update(canonicalObservationJson(value)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function observation(row) {
  const payload = JSON.parse(row.payload);
  const { dimensions, value, original_flags: flags } = payload;
  if (!dimensions || typeof dimensions !== 'object' || !flags || typeof flags !== 'object' ||
      Object.keys(dimensions).length !== DIMENSIONS.length + 1 || Object.keys(flags).length !== FLAGS.length ||
      !/^[0-9]{4}$/.test(dimensions.Year) ||
      !DIMENSIONS.every(name => typeof dimensions[name] === 'string') ||
      !FLAGS.every(name => typeof flags[name] === 'string') ||
      (value !== null && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)))) {
    throw Error('SDG_DNS_OBSERVATION_INVALID');
  }
  if (row.source !== SOURCE || row.source_key !== canonicalObservationJson(dimensions) ||
      row.id !== hash([SOURCE, row.source_key, payload])) {
    throw Error('SDG_DNS_OBSERVATION_HASH_MISMATCH');
  }
  return payload;
}

function priorVersion(ledger, timelines, series, year, nextValue, snapshot, observedAt) {
  const caseId = measureId(series);
  if (!timelines.has(caseId)) timelines.set(caseId, ledger.timeline(caseId));
  const versions = timelines.get(caseId).filter(item =>
    item.domain === 'observations' && item.stage === 'reported' && item.value.observation_year === year);
  const sameSource = versions.find(item =>
    item.sources.some(source => source.registry_id === SOURCE && source.snapshot_sha256 === snapshot.content_hash));
  const current = versions.at(-1);
  if (sameSource) {
    if (canonicalObservationJson(sameSource.value) !== canonicalObservationJson(nextValue)) {
      throw Error('SDG_DNS_SNAPSHOT_REPLAY_CHANGED');
    }
    return sameSource.supersedes;
  }
  if (!current) return null;
  if (versions.some(item => item.sources.some(source => source.registry_id === SOURCE && source.discovered_at > observedAt))) {
    throw Error('SDG_DNS_SNAPSHOT_OUT_OF_ORDER');
  }
  return canonicalObservationJson(current.value) === canonicalObservationJson(nextValue)
    ? current.supersedes : current.revision_id;
}

export function readDnsSnapshotReceipt(source, receipt) {
  if (!receipt || ![receipt.snapshot_id, receipt.content_sha256, receipt.proof_sha256].every(isHash) ||
      !Number.isInteger(receipt.expected_rows) || receipt.expected_rows < 1) {
    throw Error('SDG_DNS_SNAPSHOT_RECEIPT_REQUIRED');
  }
  const snapshot = source.prepare('SELECT * FROM snapshots WHERE id = ?').get(receipt.snapshot_id);
  if (!snapshot || snapshot.source !== SOURCE || snapshot.url !== URL ||
      snapshot.content_hash !== receipt.content_sha256 || snapshot.proof_hash !== receipt.proof_sha256 ||
      hash([SOURCE, snapshot.url, snapshot.captured_at, snapshot.content_hash, snapshot.proof_hash]) !== snapshot.id) {
    throw Error('SDG_DNS_SNAPSHOT_RECEIPT_MISMATCH');
  }
  return snapshot;
}

// The caller supplies the receipt already verified by source intake. This
// adapter consumes its bounded capture; it neither discovers nor publishes.
export function importDnsObservationSnapshot({ sourceDatabase, receipt, measures }) {
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    const snapshot = readDnsSnapshotReceipt(source, receipt);
    const observedAt = new Date(snapshot.captured_at).toISOString();
    const rows = source.prepare(`
      SELECT o.id, o.source, o.source_key, o.payload
      FROM provenance p JOIN observations o ON o.id = p.observation_id
      WHERE p.snapshot_id = ? ORDER BY o.source_key
    `).all(snapshot.id);
    if (rows.length !== receipt.expected_rows || new Set(rows.map(row => row.source_key)).size !== rows.length) {
      throw Error('SDG_DNS_SNAPSHOT_INCOMPLETE');
    }
    const timelines = new Map();
    const records = rows.map(row => {
      const reading = observation(row);
      const { Year: year, ...stratum } = reading.dimensions;
      const series = { authority: SOURCE, reference: canonicalObservationJson(stratum) };
      const value = { observation_year: year, dimensions: stratum,
        reported_value: reading.value, source_quality_flags: reading.original_flags };
      return {
        case: series,
        event: { authority: SOURCE, reference: year, domain: 'observations', stage: 'reported' },
        event_at: null,
        value,
        supersedes: priorVersion(measures, timelines, series, year, value, snapshot, observedAt),
        source: { registry_id: SOURCE, reference: row.source_key, snapshot_sha256: snapshot.content_hash,
          url: snapshot.url, published_at: null, discovered_at: observedAt },
      };
    });
    return measures.recordBatch(records);
  } finally {
    source.close();
  }
}
