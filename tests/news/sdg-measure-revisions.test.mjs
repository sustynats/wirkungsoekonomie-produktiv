import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MeasureRevisions } from '../../scripts/news/sdg/measure-revisions.mjs';

const report = {
  case: { authority: 'case-fixture-issuer', reference: 'programme-417' },
  event: { authority: 'event-fixture-issuer', reference: 'document-35', domain: 'legal', stage: 'adopted' },
  event_at: '2026-10-22',
  value: { amount: null, label: 'Synthetic programme' },
  supersedes: null,
  source: {
    registry_id: 'fixture-official', reference: 'document-35', snapshot_sha256: 'a'.repeat(64),
    url: 'https://example.org/programme-417', published_at: '2026-10-23', discovered_at: '2026-11-24T04:35:00.000Z',
  },
};

function withLedger(run) {
  const ledger = new MeasureRevisions(':memory:');
  try { run(ledger); }
  finally { ledger.close(); }
}

test('the same identified event links later sources without duplicating its chronology', () => withLedger(ledger => {
  const [first] = ledger.recordBatch([report]);
  const alternate = { ...report, value: { label: report.value.label, amount: null }, source: {
    ...report.source, registry_id: 'fixture-observer', reference: 'notice-89', snapshot_sha256: 'b'.repeat(64),
    url: 'https://example.net/report-89', published_at: null, discovered_at: '2026-11-25T05:00:00.000Z',
  } };
  const [second, retry] = ledger.recordBatch([alternate, alternate]);
  assert.equal(first.caseId, second.caseId);
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.revisionId, second.revisionId);
  assert.equal(second.newRevision, false);
  assert.equal(second.newEvidence, true);
  assert.equal(retry.newEvidence, false);
  const [revision] = ledger.timeline(first.caseId);
  assert.equal(ledger.timeline(first.caseId).length, 1);
  assert.equal(revision.event_at, '2026-10-22');
  assert.equal(revision.discovered_at, report.source.discovered_at);
  assert.deepEqual(revision.sources.map(item => item.original_published_at), ['2026-10-23', null]);
  assert.ok(!Object.hasOwn(revision, 'published_at'));
}));

test('independent actions and status dimensions retain their own identity and original money facts', () => withLedger(ledger => {
  const financiallyCommitted = {
    ...report, event: { ...report.event, domain: 'finance', stage: 'committed' },
    value: { amount: '1300000.40', currency: 'EUR', unit: 'currency_unit' },
  };
  const disbursed = {
    ...financiallyCommitted, event: { ...financiallyCommitted.event, stage: 'disbursed' },
    event_at: '2026-11-01', value: { ...financiallyCommitted.value, amount: '40000.00' },
  };
  const effective = { ...report, event: { ...report.event, stage: 'in_force' }, event_at: '2026-11-10' };
  const caseB = { ...report, case: { ...report.case, reference: 'programme-418' } };
  const [adopted, committed, paid, inForce, otherCase] = ledger.recordBatch([report, financiallyCommitted, disbursed, effective, caseB]);
  assert.equal(new Set([adopted, committed, paid, inForce].map(item => item.eventId)).size, 4);
  assert.equal(new Set([adopted, committed, paid, inForce].map(item => item.caseId)).size, 1);
  assert.notEqual(otherCase.caseId, adopted.caseId);
  const timeline = ledger.timeline(adopted.caseId);
  assert.deepEqual(timeline.filter(row => row.domain === 'finance').map(row => [row.stage, row.value.amount]), [
    ['committed', '1300000.40'], ['disbursed', '40000.00'],
  ]);
  assert.ok(!timeline.some(row => row.domain === 'observations'));
  assert.throws(() => ledger.recordBatch([{ ...report, event: { ...report.event, domain: 'implementation', stage: 'adopted' } }]), /Invalid event stage/);
}));

test('a correction requires the current predecessor and keeps both dated versions across restart', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'woek-measure-history-'));
  const db = path.join(root, 'ledger.sqlite');
  let ledger;
  try {
    ledger = new MeasureRevisions(db);
    const [first] = ledger.recordBatch([report]);
    const update = {
      ...report, supersedes: first.revisionId, value: { label: 'Corrected notice', amount: null },
      source: { ...report.source, snapshot_sha256: 'c'.repeat(64), published_at: '2026-11-02', discovered_at: '2026-11-02T12:30:00.000Z' },
    };
    const [corrected] = ledger.recordBatch([update]);
    assert.equal(corrected.eventId, first.eventId);
    assert.notEqual(corrected.revisionId, first.revisionId);
    ledger.close();
    ledger = new MeasureRevisions(db);
    const before = ledger.timeline(first.caseId);
    assert.equal(before.length, 2);
    assert.deepEqual(before.map(item => item.ordinal), [1, 2]);
    assert.equal(before[1].supersedes, first.revisionId);
    assert.deepEqual(before.map(item => item.event_at), ['2026-10-22', '2026-10-22']);
    assert.equal(ledger.recordBatch([report])[0].newRevision, false);
    assert.throws(() => ledger.recordBatch([{ ...update, value: { label: 'Stale sibling' } }]), /current event version/);
    assert.deepEqual(ledger.timeline(first.caseId), before);
    const reversion = {
      ...report, supersedes: corrected.revisionId,
      source: { ...report.source, snapshot_sha256: 'd'.repeat(64), published_at: '2026-11-29', discovered_at: '2026-11-29T11:00:00.000Z' },
    };
    const [third] = ledger.recordBatch([reversion]);
    assert.notEqual(third.revisionId, first.revisionId);
    assert.equal(ledger.timeline(first.caseId).find(item => item.revision_id === third.revisionId).ordinal, 3);
  } finally {
    ledger?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an evidence collision rolls back the entire batch', () => withLedger(ledger => {
  const [first] = ledger.recordBatch([report]);
  const valid = { ...report, event: { ...report.event, reference: 'document-36' },
    source: { ...report.source, reference: 'document-36' } };
  const conflict = { ...report, source: { ...report.source, url: 'https://example.org/wrong-document' } };
  assert.throws(() => ledger.recordBatch([valid, conflict]), /Source snapshot metadata has changed/);
  assert.equal(ledger.timeline(first.caseId).length, 1);
  assert.equal(ledger.recordBatch([valid])[0].newRevision, true);
}));

test('undated observations stay undated and malformed dates or values are refused', () => withLedger(ledger => {
  const undated = { ...report, event_at: null, source: { ...report.source, published_at: null } };
  const [first] = ledger.recordBatch([undated]);
  const [stored] = ledger.timeline(first.caseId);
  assert.equal(stored.event_at, null);
  assert.equal(stored.sources[0].original_published_at, null);
  assert.throws(() => ledger.recordBatch([{ ...report, event_at: '2026-02-30' }]), /Invalid event date/);
  assert.throws(() => ledger.recordBatch([{ ...report, value: { amount: Infinity } }]), /Expected JSON source data/);
  assert.throws(() => ledger.recordBatch([{ ...report, source: { ...report.source, discovered_at: '2026-11-24' } }]), /Invalid discovery time/);
}));
