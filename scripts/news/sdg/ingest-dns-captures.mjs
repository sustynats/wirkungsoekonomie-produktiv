import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importDnsObservationSnapshot, readDnsSnapshotReceipt } from './dns-indicator-intake.mjs';
import { MeasureRevisions } from './measure-revisions.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptHashes = ['snapshot_id', 'content_sha256', 'proof_sha256'];

function readPrivateFile(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077) throw Error('SDG_DNS_INTAKE_PRIVATE_FILE_REQUIRED');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function loadPinnedManifest(filename, expectedHash) {
  const bytes = readPrivateFile(filename);
  if (!hashPattern.test(expectedHash ?? '') || sha256(bytes) !== expectedHash) {
    throw Error('SDG_DNS_INTAKE_MANIFEST_BINDING_REQUIRED');
  }
  const value = JSON.parse(bytes);
  if (value?.schema_version !== 1 || !Object.hasOwn(value, 'source_database_sha256') ||
      !hashPattern.test(value.source_database_sha256 ?? '') || !Array.isArray(value.receipts) ||
      value.receipts.length === 0 || Object.keys(value).length !== 3 || value.receipts.some(receipt =>
        !receipt || Object.keys(receipt).length !== 4 ||
        !receiptHashes.every(key => typeof receipt[key] === 'string' && hashPattern.test(receipt[key])) ||
        !Number.isSafeInteger(receipt.expected_rows) || receipt.expected_rows < 1) ||
      new Set(value.receipts.map(receipt => receipt.snapshot_id)).size !== value.receipts.length) {
    throw Error('SDG_DNS_INTAKE_MANIFEST_INVALID');
  }
  return value;
}

function orderReceipts(capture, receipts) {
  const source = new DatabaseSync(capture, { readOnly: true });
  try {
    const count = source.prepare(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT o.source_key) AS keys
      FROM provenance p JOIN observations o ON o.id = p.observation_id
      WHERE p.snapshot_id = ?
    `);
    const ordered = receipts.map(receipt => {
      const snapshot = readDnsSnapshotReceipt(source, receipt);
      const { rows, keys } = count.get(snapshot.id);
      if (rows !== receipt.expected_rows || keys !== rows) throw Error('SDG_DNS_SNAPSHOT_INCOMPLETE');
      return { receipt, capturedAt: new Date(snapshot.captured_at).toISOString() };
    }).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    if (new Set(ordered.map(item => item.capturedAt)).size !== ordered.length) {
      throw Error('SDG_DNS_INTAKE_CAPTURE_ORDER_AMBIGUOUS');
    }
    return ordered;
  } finally { source.close(); }
}

function openPrivateLedger(filename) {
  const parent = fs.lstatSync(path.dirname(filename));
  if (!parent.isDirectory() || parent.mode & 0o077) throw Error('SDG_DNS_INTAKE_PRIVATE_DIRECTORY_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077) throw Error('SDG_DNS_INTAKE_PRIVATE_FILE_REQUIRED');
  } finally { fs.closeSync(fd); }
  return new MeasureRevisions(filename);
}

// A scheduler supplies the manifest digest from trusted configuration. It
// pins an operator-selected, already captured batch. This does not collect
// sources, confer approval by itself, stage a review, or publish an edition.
export function ingestDnsCaptures({
  manifest, manifestSha256, sourceDatabase, measureDatabase, clock = () => new Date(),
}) {
  const pinned = loadPinnedManifest(manifest, manifestSha256);
  const bytes = readPrivateFile(sourceDatabase);
  if (sha256(bytes) !== pinned.source_database_sha256) throw Error('SDG_DNS_INTAKE_CAPTURE_BINDING_REQUIRED');
  const output = path.resolve(measureDatabase);
  if ([sourceDatabase, manifest].some(input => path.resolve(input) === output)) {
    throw Error('SDG_DNS_INTAKE_SEPARATE_LEDGER_REQUIRED');
  }
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'woek-dns-capture-'));
  try {
    // The verified bytes, not a later view of a mutable SQLite/WAL pair, are read by the adapter.
    const capture = path.join(scratch, 'capture.sqlite');
    fs.writeFileSync(capture, bytes, { mode: 0o600, flag: 'wx' });
    const ordered = orderReceipts(capture, pinned.receipts);
    const now = clock().toISOString();
    const due = ordered.filter(item => item.capturedAt <= now);
    const result = { processed_snapshots: 0, deferred_snapshots: ordered.length - due.length, new_revisions: 0, new_evidence_links: 0 };
    if (!due.length) return result;
    const measures = openPrivateLedger(output);
    try {
      for (const { receipt } of due) {
        const changes = importDnsObservationSnapshot({ sourceDatabase: capture, receipt, measures });
        result.processed_snapshots++;
        result.new_revisions += changes.filter(row => row.newRevision).length;
        result.new_evidence_links += changes.filter(row => row.newEvidence).length;
      }
      return result;
    } finally { measures.close(); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, 'manifest-sha256': { type: 'string' },
    'capture-db': { type: 'string' }, 'measure-db': { type: 'string' },
  } });
  if (['manifest', 'manifest-sha256', 'capture-db', 'measure-db'].some(key => !values[key])) {
    throw Error('SDG_DNS_INTAKE_ARGUMENTS_REQUIRED');
  }
  console.log(JSON.stringify(ingestDnsCaptures({
    manifest: values.manifest, manifestSha256: values['manifest-sha256'],
    sourceDatabase: values['capture-db'], measureDatabase: values['measure-db'],
  })));
}
