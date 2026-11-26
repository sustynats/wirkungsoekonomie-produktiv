import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { importDnsObservationSnapshot } from '../../scripts/news/sdg/dns-indicator-intake.mjs';
import { ingestDnsCaptures } from '../../scripts/news/sdg/ingest-dns-captures.mjs';
import { canonicalObservationJson, MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';

const source = 'dns_1_1_ab';
const url = 'https://dns-indikatoren.de/sdg-data-pub/de/data/1-1-ab.csv';
const hash = value => createHash('sha256').update(canonicalObservationJson(value)).digest('hex');
const rawHash = value => createHash('sha256').update(value).digest('hex');
const dimensions = { Year: '2018', Units: 'Prozent', Zeitreihe: 'Synthetischer Indikator',
  Gebiet: 'Test', Geschlecht: '', Altersklasse: '', Bundesland: '', GeoCode: '' };

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'woek-dns-import-'));
  const file = path.join(root, 'source.sqlite');
  const sourceDb = new DatabaseSync(file);
  const measures = new MeasureRevisions(':memory:');
  try {
    sourceDb.exec(`
      CREATE TABLE snapshots (id TEXT PRIMARY KEY, source TEXT, url TEXT, captured_at TEXT, content_hash TEXT, proof_hash TEXT);
      CREATE TABLE observations (id TEXT PRIMARY KEY, source TEXT, source_key TEXT, payload TEXT);
      CREATE TABLE provenance (snapshot_id TEXT, observation_id TEXT);
    `);
    const write = ({ marker, at, value }) => {
      const payload = { dimensions, value, original_flags: { COMMENT_OBS_0: '', COMMENT_OBS_1: '' } };
      const proof = 'a'.repeat(64), content = marker.repeat(64);
      const id = hash([source, url, at, content, proof]);
      const key = canonicalObservationJson(dimensions);
      const observationId = hash([source, key, payload]);
      sourceDb.prepare('INSERT INTO snapshots VALUES (?, ?, ?, ?, ?, ?)').run(id, source, url, at, content, proof);
      sourceDb.prepare('INSERT INTO observations VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(observationId, source, key, canonicalObservationJson(payload));
      sourceDb.prepare('INSERT INTO provenance VALUES (?, ?)').run(id, observationId);
      return { snapshot_id: id, content_sha256: content, proof_sha256: proof, expected_rows: 1 };
    };
    const load = receipt => importDnsObservationSnapshot({ sourceDatabase: file, receipt, measures });
    run({ root, file, sourceDb, measures, write, load });
  } finally {
    measures.close();
    sourceDb.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('imports dateless reported measurements and records changed values as dated source revisions', () => fixture(({ measures, write, load }) => {
  const first = write({ marker: 'b', at: '2026-11-22T09:00:00+00:00', value: null });
  const second = write({ marker: 'c', at: '2026-11-24T09:00:00+00:00', value: '14.20' });
  const [original] = load(first);
  const [correction] = load(second);
  assert.equal(correction.caseId, original.caseId);
  assert.equal(correction.eventId, original.eventId);
  assert.notEqual(correction.revisionId, original.revisionId);
  const rows = measures.timeline(original.caseId);
  assert.deepEqual(rows.map(row => row.value.reported_value), [null, '14.20']);
  assert.deepEqual(rows.map(row => row.event_at), [null, null]);
  assert.ok(rows.every(row => row.value.observation_year === '2018' &&
    row.domain === 'observations' && row.stage === 'reported' && row.sources[0].original_published_at === null));
  assert.equal(load(first)[0].newRevision, false);
  assert.equal(measures.timeline(original.caseId).length, 2);
}));

test('preserves provenance for unchanged values and refuses an unprocessed out-of-order capture', () => fixture(({ measures, write, load }) => {
  const [first] = load(write({ marker: 'b', at: '2026-11-22T09:00:00Z', value: '18.0' }));
  const [repeat] = load(write({ marker: 'c', at: '2026-11-24T09:00:00Z', value: '18.0' }));
  assert.equal(repeat.revisionId, first.revisionId);
  assert.equal(repeat.newEvidence, true);
  assert.equal(measures.timeline(first.caseId)[0].sources.length, 2);
  const stale = write({ marker: 'd', at: '2026-11-23T09:00:00Z', value: '21.0' });
  assert.throws(() => load(stale), /SDG_DNS_SNAPSHOT_OUT_OF_ORDER/);
  assert.equal(measures.timeline(first.caseId).length, 1);
}));

test('a mismatched receipt, incomplete capture or changed observation cannot enter the ledger', () => fixture(({ sourceDb, write, load }) => {
  const receipt = write({ marker: 'b', at: '2026-11-23T09:00:00Z', value: '11.0' });
  assert.throws(() => load({ ...receipt, content_sha256: 'c'.repeat(64) }), /SNAPSHOT_RECEIPT_MISMATCH/);
  assert.throws(() => load({ ...receipt, expected_rows: 2 }), /SNAPSHOT_INCOMPLETE/);
  sourceDb.exec("UPDATE observations SET payload = json_set(payload, '$.value', '71.0')");
  assert.throws(() => load(receipt), /OBSERVATION_HASH_MISMATCH/);
}));

function scheduledBatch(root, sourceDatabase, receipts) {
  const manifest = path.join(root, 'dns-capture-batch.json');
  const captureHash = rawHash(readFileSync(sourceDatabase));
  const manifestBytes = JSON.stringify({ schema_version: 1, source_database_sha256: captureHash, receipts });
  writeFileSync(manifest, manifestBytes, { mode: 0o600 });
  chmodSync(sourceDatabase, 0o600);
  return { manifest, manifestSha256: rawHash(manifestBytes), sourceDatabase,
    measureDatabase: path.join(root, 'measures.sqlite') };
}

test('scheduled intake uses capture time and retains future and previously ingested snapshots on rerun', () => fixture(({ root, file, write }) => {
  const first = write({ marker: 'b', at: '2026-11-22T09:00:00Z', value: '14.0' });
  const second = write({ marker: 'c', at: '2026-11-24T09:00:00Z', value: '14.2' });
  const options = scheduledBatch(root, file, [second, first]);
  const runAt = time => ingestDnsCaptures({ ...options, clock: () => new Date(time) });
  const stats = (processed, deferred, revisions, evidence) => ({
    processed_snapshots: processed, deferred_snapshots: deferred, new_revisions: revisions, new_evidence_links: evidence,
  });

  assert.deepEqual(runAt('2026-11-21T08:00:00Z'), stats(0, 2, 0, 0));
  assert.equal(existsSync(options.measureDatabase), false);
  assert.deepEqual(runAt('2026-11-23T08:00:00Z'), stats(1, 1, 1, 1));
  assert.deepEqual(runAt('2026-11-25T08:00:00Z'), stats(2, 0, 1, 1));
  assert.deepEqual(runAt('2026-11-26T08:00:00Z'), stats(2, 0, 0, 0));

  const ledger = new MeasureRevisions(options.measureDatabase);
  try {
    const { id } = ledger.db.prepare('SELECT id FROM measures').get();
    const revisions = ledger.timeline(id);
    assert.deepEqual(revisions.map(row => row.value.reported_value), ['14.0', '14.2']);
    assert.deepEqual(revisions.map(row => row.event_at), [null, null]);
    assert.equal(revisions[1].supersedes, revisions[0].revision_id);
  } finally { ledger.close(); }
}));

test('scheduled intake rejects unpinned capture bytes and malformed receipt batches before creating a ledger', () => fixture(({ root, file, sourceDb, write }) => {
  const first = write({ marker: 'b', at: '2026-11-22T09:00:00Z', value: '14.0' });
  const second = write({ marker: 'c', at: '2026-11-24T09:00:00Z', value: '14.2' });
  const run = options => ingestDnsCaptures({ ...options, clock: () => new Date('2026-11-25T00:00:00Z') });
  const pinned = scheduledBatch(root, file, [first, second]);
  assert.throws(() => run({ ...pinned, manifestSha256: 'f'.repeat(64) }), /MANIFEST_BINDING_REQUIRED/);
  const wrongRows = scheduledBatch(root, file, [first, { ...second, expected_rows: 2 }]);
  assert.throws(() => run(wrongRows), /SNAPSHOT_INCOMPLETE/);
  const wrongReceipt = scheduledBatch(root, file, [first, { ...second, proof_sha256: 'f'.repeat(64) }]);
  assert.throws(() => run(wrongReceipt), /SNAPSHOT_RECEIPT_MISMATCH/);
  const duplicate = scheduledBatch(root, file, [first, first]);
  assert.throws(() => run(duplicate), /MANIFEST_INVALID/);
  const original = scheduledBatch(root, file, [first, second]);
  sourceDb.exec("UPDATE snapshots SET proof_hash = 'altered'");
  assert.throws(() => run(original), /CAPTURE_BINDING_REQUIRED/);
  assert.equal(existsSync(pinned.measureDatabase), false);
}));
