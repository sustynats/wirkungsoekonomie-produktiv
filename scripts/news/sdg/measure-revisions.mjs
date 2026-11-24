import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const stages = Object.freeze({
  legal: new Set(['proposed', 'adopted', 'in_force', 'repealed']),
  implementation: new Set(['announced', 'started', 'implemented', 'suspended']),
  finance: new Set(['pledged', 'approved', 'committed', 'disbursed', 'spent']),
  observations: new Set(['reported', 'observed']),
});

export function canonicalObservationJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value) && Object.keys(value).length === value.length) {
    return '[' + Array.from(value, canonicalObservationJson).join(',') + ']';
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalObservationJson(value[key])).join(',') + '}';
  }
  throw new TypeError('Expected JSON source data');
}

const sha = value => createHash('sha256').update(canonicalObservationJson(value)).digest('hex');

function identifier(value) {
  if (typeof value !== 'string' || !value.length || value.length > 500 || value.trim() !== value || /\p{C}/u.test(value)) {
    throw new TypeError('Expected a stable source identifier');
  }
  return value;
}

export function measureId({ authority, reference }) {
  return sha(['measure', identifier(authority), identifier(reference)]);
}

function date(value, label, allowCalendarDate = true) {
  if (value === null && allowCalendarDate) return null;
  if (typeof value !== 'string') throw new TypeError(`Invalid ${label}`);
  const calendar = allowCalendarDate && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== (calendar ? value + 'T00:00:00.000Z' : value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function digest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError('Expected SHA-256');
  return value;
}

function originalUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      [...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api[_-]?key/i.test(key))) {
    throw new TypeError('Expected a public original-source address');
  }
  url.hash = '';
  return url.href;
}

function normalize(record) {
  const caseKey = [identifier(record.case.authority), identifier(record.case.reference)];
  const domain = record.event.domain;
  const stage = record.event.stage;
  if (!Object.hasOwn(stages, domain) || !stages[domain].has(stage)) throw new TypeError('Invalid event stage for its domain');
  const eventKey = [identifier(record.event.authority), identifier(record.event.reference), domain, stage];
  const caseId = measureId(record.case);
  const eventId = sha(['event', caseId, ...eventKey]);
  const eventAt = date(record.event_at, 'event date');
  const supersedes = record.supersedes === null ? null : digest(record.supersedes);
  const value = canonicalObservationJson(record.value);
  const valueHash = sha([eventAt, JSON.parse(value)]);
  const revisionId = sha(['revision', eventId, supersedes, valueHash]);

  const source = record.source;
  const sourceKey = [identifier(source.registry_id), identifier(source.reference), digest(source.snapshot_sha256)];
  const sourceId = sha(['evidence', ...sourceKey]);
  const url = originalUrl(source.url);
  const sourcePublishedAt = date(source.published_at, 'source publication date');
  const discoveredAt = date(source.discovered_at, 'discovery time', false);
  return {
    caseId, caseKey, eventId, eventKey, eventAt, supersedes, value, valueHash, revisionId,
    sourceId, sourceKey, url, sourcePublishedAt, discoveredAt,
  };
}

// The input represents an attributed observation with explicit official IDs.
// Registry rights, evidence quality and MPD review belong to their own gates.
// The ledger confers no qualification, authorization or publication status.
export class MeasureRevisions {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS measures (
        id TEXT PRIMARY KEY NOT NULL, authority TEXT NOT NULL, reference TEXT NOT NULL,
        UNIQUE(authority, reference)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL, case_id TEXT NOT NULL REFERENCES measures(id),
        authority TEXT NOT NULL, reference TEXT NOT NULL, domain TEXT NOT NULL, stage TEXT NOT NULL,
        UNIQUE(case_id, authority, reference, domain, stage)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES events(id),
        ordinal INTEGER NOT NULL, supersedes TEXT REFERENCES revisions(id), event_at TEXT,
        value TEXT NOT NULL, value_hash TEXT NOT NULL, discovered_at TEXT NOT NULL,
        UNIQUE(event_id, ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY NOT NULL, registry_id TEXT NOT NULL, reference TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL, url TEXT NOT NULL, original_published_at TEXT, discovered_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revision_evidence (
        revision_id TEXT NOT NULL REFERENCES revisions(id), evidence_id TEXT NOT NULL REFERENCES evidence(id),
        PRIMARY KEY(revision_id, evidence_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_by_measure ON events(case_id);
    `);
  }

  close() {
    this.db.close();
  }

  recordBatch(records) {
    const batch = records.map(normalize);
    const insertCase = this.db.prepare('INSERT INTO measures VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    const insertEvent = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    const getRevision = this.db.prepare('SELECT id FROM revisions WHERE id = ?');
    const head = this.db.prepare('SELECT id, ordinal, value_hash FROM revisions WHERE event_id = ? ORDER BY ordinal DESC LIMIT 1');
    const insertRevision = this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertEvidence = this.db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    const readEvidence = this.db.prepare('SELECT url, original_published_at FROM evidence WHERE id = ?');
    const link = this.db.prepare('INSERT INTO revision_evidence VALUES (?, ?) ON CONFLICT DO NOTHING');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = batch.map(row => {
        insertCase.run(row.caseId, ...row.caseKey);
        insertEvent.run(row.eventId, row.caseId, ...row.eventKey);
        const alreadyRecorded = Boolean(getRevision.get(row.revisionId));
        if (!alreadyRecorded) {
          const prior = head.get(row.eventId);
          if ((prior?.id ?? null) !== row.supersedes) throw new Error('Revision does not follow the current event version');
          if (prior?.value_hash === row.valueHash) throw new Error('Unchanged event must link evidence to the existing revision');
          insertRevision.run(row.revisionId, row.eventId, (prior?.ordinal ?? 0) + 1,
            row.supersedes, row.eventAt, row.value, row.valueHash, row.discoveredAt);
        }
        if (!insertEvidence.run(row.sourceId, ...row.sourceKey, row.url, row.sourcePublishedAt, row.discoveredAt).changes) {
          const previous = readEvidence.get(row.sourceId);
          if (previous.url !== row.url || previous.original_published_at !== row.sourcePublishedAt) {
            throw new Error('Source snapshot metadata has changed');
          }
        }
        const newEvidence = Boolean(link.run(row.revisionId, row.sourceId).changes);
        return {
          caseId: row.caseId, eventId: row.eventId, revisionId: row.revisionId,
          newRevision: !alreadyRecorded, newEvidence,
        };
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  timeline(caseId) {
    const revisions = this.db.prepare(`
      SELECT e.id AS event_id, e.domain, e.stage, r.id AS revision_id, r.ordinal, r.supersedes,
        r.event_at, r.value, r.discovered_at
      FROM events e JOIN revisions r ON e.id = r.event_id
      JOIN revisions current ON current.event_id = e.id AND current.ordinal = (
        SELECT MAX(ordinal) FROM revisions WHERE event_id = e.id
      )
      WHERE e.case_id = ?
      ORDER BY (current.event_at IS NULL), current.event_at, e.id, r.ordinal
    `).all(digest(caseId));
    const sources = this.db.prepare(`
      SELECT s.registry_id, s.reference, s.snapshot_sha256, s.url, s.original_published_at, s.discovered_at
      FROM evidence s JOIN revision_evidence r ON r.evidence_id = s.id
      WHERE r.revision_id = ? ORDER BY s.discovered_at, s.id
    `);
    return revisions.map(row => ({ ...row, value: JSON.parse(row.value), sources: sources.all(row.revision_id) }));
  }
}
