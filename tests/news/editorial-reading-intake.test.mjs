import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BridgeStore } from '../../scripts/news/bridge/store.mjs';
import { EditorialIntake } from '../../scripts/news/bridge/intake.mjs';
import { ensureEditorialContracts } from '../../scripts/news/bridge/editorial-bootstrap.mjs';
import { hash } from '../../scripts/news/bridge/contract.mjs';
import {
  EDITORIAL_READING_CONTRACT_PATH, EDITORIAL_REQUEST_CONTRACT_V4, EDITORIAL_REQUEST_CONTRACT_V5,
} from '../../scripts/news/bridge/intake-processing.mjs';

const owner = '111111111111111111';
const readingUrl = 'https://example.org/source';
const submission = () => ({
  client_id: randomUUID(), kind: 'read', brief: 'Fiktiver Nachgelesen-Test',
  links: 'https://example.org/context', author_notes: '', publish: true, urgent: false, attachments: [],
  document_url: readingUrl,
});

test('a document request is stored privately with an exact original and idempotent V5 identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'woek-reading-intake-'));
  const store = new BridgeStore(join(directory, 'queue.sqlite'), { lane: 'intake' });
  try {
    const intake = new EditorialIntake({ store, directory: join(directory, 'uploads'), transport: {} });
    assert.throws(() => intake.draft(owner, { ...submission(), document_url: '' }), /ORIGINAL_REQUIRED/);
    assert.throws(() => intake.draft(owner, { ...submission(), document_url: 'http://example.org/source' }), /URL_INVALID/);
    const original = submission();
    const draft = intake.draft(owner, original);
    assert.throws(() => intake.draft(owner, { ...original, document_url: 'https://example.org/replacement' }), /IDEMPOTENCY_CONFLICT/);
    const first = await intake.submit(owner, draft.id);
    assert.deepEqual(await intake.submit(owner, draft.id), { ...first, duplicate: true });
    const saved = store.get(first.job_id);
    assert.equal(saved.status, 'intake_prepared');
    assert.equal(saved.input.contract_path, EDITORIAL_READING_CONTRACT_PATH);
    assert.equal(saved.input.request.document_url, readingUrl);
    assert.equal(saved.input.request.publication_intent, 'final_approval_required');
    assert.equal(saved.input.input_hash, hash(saved.input.request));
    assert.deepEqual(saved.input.request.links, [readingUrl, 'https://example.org/context']);
    assert.equal(intake.list(owner)[0].document_url, readingUrl);
    assert.deepEqual(intake.list('222222222222222222'), []);
    const older = intake.draft(owner, { ...submission(), kind: 'opinion_analysis' });
    const olderSaved = store.get((await intake.submit(owner, older.id)).job_id);
    assert.match(olderSaved.input.contract_path, /editorial-request-contract-4\.json$/);
    assert.ok(!Object.hasOwn(olderSaved.input.request, 'document_url'));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('V5 installs beside the immutable former contract in the existing bootstrap', async () => {
  const existing = { ...EDITORIAL_REQUEST_CONTRACT_V4, instructions: ['Historischer Teststand'] };
  const existingPath = EDITORIAL_READING_CONTRACT_PATH.replace('-5.json', '-4.json');
  const files = new Map([[existingPath, JSON.stringify(existing)]]);
  const transport = {
    metadata: async (path) => files.has(path) ? {} : null,
    read: async (path) => files.get(path),
    writeAtomic: async (path, value) => files.set(path, JSON.stringify(value)),
  };
  const contracts = [EDITORIAL_REQUEST_CONTRACT_V4, EDITORIAL_REQUEST_CONTRACT_V5];
  assert.deepEqual(await ensureEditorialContracts(transport, contracts), [
    { version: '4.0', status: 'existing_immutable' }, { version: '5.0', status: 'installed' },
  ]);
  assert.equal(files.get(existingPath), JSON.stringify(existing));
  assert.equal(files.get(EDITORIAL_READING_CONTRACT_PATH), JSON.stringify(EDITORIAL_REQUEST_CONTRACT_V5));
});
