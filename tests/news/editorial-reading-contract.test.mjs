import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiEditorialProcessor, validateApiOutput } from '../../scripts/news/bridge/api-processor.mjs';
import { bridgePath } from '../../scripts/news/bridge/contract.mjs';
import { EditorialApproval } from '../../scripts/news/bridge/editorial-approval.mjs';
import { readingEvidenceKey } from '../../scripts/news/bridge/editorial-reading-evidence.mjs';
import { processEditorialRequest } from '../../scripts/news/redaktionsworker.mjs';
import {
  EDITORIAL_READING_CONTRACT_PATH, editorialRequestContract, importEditorialPreviews,
} from '../../scripts/news/bridge/intake-processing.mjs';

const now = '2026-11-24T01:30:00Z';
const owner = '111111111111111111';
const original = 'https://example.org/original-reading';
const input = {
  schema_version: '1.0', job_type: 'editorial_request', job_id: 'wt_20261124T012900Z_aaaaaaaaaaaaaaaaaaaaaaaa',
  input_hash: 'f'.repeat(64), created_at: '2026-11-24T01:29:00Z', contract_path: EDITORIAL_READING_CONTRACT_PATH,
  request: { kind: 'read', document_url: original, links: [original], author_notes: '' },
};
const response = () => ({
  schema_version: '1.0', job_id: input.job_id, input_hash: input.input_hash, processed_at: now,
  preview: {
    format: 'read', title: 'Fiktiver Lesebeitrag',
    markdown: '## Original\n\nDieser vollständig fiktive Testtext prüft nur die technische Übergabe.\n\n## Meine Einordnung\n\nNeutraler Platzhalter für den Test.',
    sources: [{ url: original, title: 'Fiktives Originaldokument', publisher: 'Test' }],
    source_document: { original_url: original, title: 'Fiktives Originaldokument',
      content_sha256: 'a'.repeat(64), reading_status: 'excerpt' },
    checks: { source_binding: true, editorial_validation: true, personal_experiences_invented: false },
  },
});

test('the native reading worker persists original-byte evidence before drafting and never retries an uncertain attempt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'woek-reading-test-'));
  try {
    const base = path.join(root, 'content/news');
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, 'source-registry.json'), JSON.stringify({
      sources: [{ source_id: 'fixture', name: 'Synthetic fixture', source_type: 'official_article', url: original, enabled: true }],
      policy: { resolve_dns: false, user_agent: 'WOek-Wirkungsticker' },
    }));
    const file = `${input.job_id}.input.json`;
    const job = { input, intake: {}, status: 'queued' };
    const observations = new Map();
    const contents = new Map([[bridgePath('00_INBOX', file), JSON.stringify(input)]]);
    const store = {
      get: async () => job,
      observation: async key => observations.get(key),
      observe: async (key, value) => observations.set(key, value),
    };
    const transport = {
      metadata: async key => contents.has(key) || null,
      read: async key => contents.get(key),
      move: async (from, to) => { contents.set(to, contents.get(from)); contents.delete(from); },
      writeAtomic: async (key, value) => contents.set(key, JSON.stringify(value)),
    };
    const originalBytes = Buffer.from('<article>' + 'Synthetic source text for the reading evidence and approval test. '.repeat(20) + '</article>');
    const digest = createHash('sha256').update(originalBytes).digest('hex');
    let draftCalls = 0;
    const draft = async request => {
      draftCalls += 1;
      const evidence = observations.get(readingEvidenceKey(input));
      assert.equal(evidence.content_sha256, digest);
      assert.match(request.prompt, new RegExp(digest));
      const output = response();
      output.preview.source_document.content_sha256 = digest;
      return { output, model: 'fixture', cost: 0 };
    };
    const fetchImpl = async url => {
      if (new URL(url).pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /');
      assert.equal(url, original);
      return new Response(originalBytes, { headers: { 'content-type': 'text/html' } });
    };
    const options = { root, knowledge: { hash: 'e'.repeat(64), instructions: 'Synthetic editorial fixture.' }, now: () => now, draft, fetchImpl, excerpts: true, rawOutputDir: null, env: {} };
    const run = () => processEditorialRequest({ store, transport }, job, options);
    assert.equal((await run()).status, 'output_delivered');
    assert.equal(draftCalls, 1);
    assert.equal(JSON.parse(contents.get(bridgePath('20_OUTPUT_READY', `${input.job_id}.output.json`))).preview.source_document.content_sha256, digest);
    observations.set(`github-attempt:${input.job_id}`, { provider_called: true, version: 'older-worker', status: 'started' });
    contents.delete(bridgePath('20_OUTPUT_READY', `${input.job_id}.output.json`));
    assert.equal((await run()).status, 'attempt_exhausted');
    assert.equal(draftCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the generic API processor leaves read requests to the source-verified editorial worker', async () => {
  const job = { input, status: 'queued' };
  const processor = new ApiEditorialProcessor({ store: { observation: () => null, get: () => job }, now: () => now });
  assert.deepEqual(await processor.process(job, { at: now, actor: 'oracle_api', status: 'PASS', write_ok: true }),
    { status: 'deferred_to_source_verified_worker', job_id: input.job_id });
});

test('reading packets use version five and validate the ordered document, including returned corrections', () => {
  assert.equal(editorialRequestContract(input).schema_version, '5.0');
  assert.equal(editorialRequestContract({ request: { kind: 'listened' } }).schema_version, '4.0');
  assert.throws(() => editorialRequestContract({ ...input, contract_path: 'old-contract' }), /CONTRACT_REQUIRED/);
  const packet = { original_input: input };
  assert.equal(validateApiOutput(response(), packet, now).preview.source_document.original_url, original);
  const invalid = response();
  const alternate = 'https://example.org/unrequested-document';
  invalid.preview.source_document.original_url = alternate;
  invalid.preview.sources.push({ url: alternate, title: 'Zweitquelle', publisher: 'Test' });
  assert.throws(() => validateApiOutput(invalid, packet, now), /DOCUMENT_REQUEST_CHANGED/);
  const incomplete = response();
  delete incomplete.preview.source_document;
  assert.throws(() => validateApiOutput(incomplete, input, now));
});

test('an unread original may return HOLD, and a valid transport result only stages a private preview', async () => {
  const result = response();
  const { preview: _, ...hold } = result;
  assert.equal(validateApiOutput({
    ...hold, disposition: 'hold',
    hold: { code: 'SOURCE_VERIFICATION_REQUIRED', reason: 'Das Original liegt nicht geprüft vor.', requested_information: 'Originalzugriff' },
  }, input, now).disposition, 'hold');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE jobs(body TEXT NOT NULL)');
    const job = { input, intake: { owner }, candidate: { story_id: 'fixture' }, status: 'queued' };
    db.prepare('INSERT INTO jobs VALUES (?)').run(JSON.stringify(job));
    let receipt = null;
    const store = {
      db,
      put: updated => db.prepare('UPDATE jobs SET body = ?').run(JSON.stringify(updated)),
      observation: key => {
        assert.equal(key, readingEvidenceKey(input));
        return receipt;
      },
    };
    const approval = new EditorialApproval(db, { now: () => now });
    const transport = {
      list: async () => [{ name: `${input.job_id}.output.json` }],
      read: async () => JSON.stringify(result),
    };
    const run = () => importEditorialPreviews({ store, transport, approval, now: () => now });
    const mismatch = { staged: 0, failed: [{ job_id: input.job_id, code: 'EDITORIAL_DOCUMENT_EVIDENCE_MISMATCH' }] };
    assert.deepEqual(await run(), mismatch);
    assert.equal(approval.claimPublications().length, 0);
    receipt = { job_id: input.job_id, input_hash: input.input_hash, source_id: 'fixture', original_url: original,
      final_url: original, content_sha256: 'b'.repeat(64), reading_status: 'excerpt' };
    assert.deepEqual(await run(), mismatch);
    receipt = { ...receipt, content_sha256: result.preview.source_document.content_sha256 };
    assert.deepEqual(await run(), { staged: 1, failed: [] });
    assert.equal(approval.get(input.job_id).status, 'AWAITING_FINAL_APPROVAL');
    assert.equal(approval.get(input.job_id).preview.source_document.original_url, original);
    assert.deepEqual(approval.claimPublications(), []);
  } finally {
    db.close();
  }
});
