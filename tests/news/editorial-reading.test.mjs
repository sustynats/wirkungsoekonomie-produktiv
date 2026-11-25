import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EditorialApproval, editorialPreviewHash } from '../../scripts/news/bridge/editorial-approval.mjs';
import { EDITORIAL_READING_CONTRACT_PATH } from '../../scripts/news/bridge/intake-processing.mjs';
import { editorialAnalysisPage, tickerRssFeeds } from '../../scripts/news/build.mjs';
import { validatePersonalEdition, personalContentHash } from '../../scripts/news/personal-editorial.mjs';

const owner = '111111111111111111';
const at = '2026-11-24T00:00:00Z';
const job = { input: {
  job_id: 'wt_20261124T000000Z_aaaaaaaaaaaaaaaaaaaaaaaa',
  contract_path: EDITORIAL_READING_CONTRACT_PATH,
}, intake: { owner } };
const original = 'https://example.org/reading-source';
const draft = () => ({
  format: 'read',
  title: 'Fiktiver Beitrag für den Freigabetest',
  markdown: '## Gegenstand\n\nEin fiktiver Text zur Prüfung der Freigabe.\n\n## Meine Einordnung\n\nDiese Einordnung gehört ausschließlich zur Testfassung und simuliert die redaktionelle Schlusssektion.',
  sources: [{ url: original, title: 'Fiktive Originalquelle', publisher: 'Test' }],
  source_document: {
    title: 'Fiktives Originaldokument', original_url: original,
    content_sha256: 'a'.repeat(64), reading_status: 'excerpt',
  },
  checks: { source_binding: true, editorial_validation: true, personal_experiences_invented: false },
});
const decide = (store, preview_hash) => store.decide(owner, job.input.job_id, { action: 'APPROVE', preview_hash });

test('document and reading scope must be bound to an eligible original source', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new EditorialApproval(db, { now: () => at });
    const valid = draft();
    assert.throws(() => store.stage(job, { ...valid, source_document: null }), /DOCUMENT_INVALID/);
    assert.throws(() => store.stage(job, { ...valid, source_document: { ...valid.source_document, reading_status: 'unknown' } }), /DOCUMENT_INVALID/);
    assert.throws(() => store.stage(job, { ...valid, source_document: { ...valid.source_document, original_url: 'https://example.org/unbound' } }), /SOURCE_NOT_BOUND/);
    assert.throws(() => store.stage(job, { ...valid, source_media: { show: 'Fiktive Sendung' } }), /NOT_EPISODE/);
    assert.throws(() => store.stage(job, { ...valid, markdown: '## Gegenstand\n\nDie fiktive Arbeitsfassung hat eine ausreichende Länge zur formalen Prüfung. In diesem Fall endet der Haupttext vor der persönlichen Einordnung.' }), /FINAL_PERSPECTIVE_REQUIRED/);
    assert.equal(store.pendingPublicationCount(), 0);
  } finally {
    db.close();
  }
});

test('Nachgelesen takes the owner-approved exact edition into the existing reader and feed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new EditorialApproval(db, { now: () => at });
    const valid = draft();
    const first = store.stage(job, valid);
    assert.equal(first.status, 'AWAITING_FINAL_APPROVAL');
    assert.deepEqual(store.claimPublications(), []);
    assert.throws(() => store.decide('222222222222222222', job.input.job_id, { action: 'APPROVE', preview_hash: first.preview_hash }), /NOT_FOUND/);
    decide(store, first.preview_hash);
    const edited = { ...valid, source_document: { ...valid.source_document, content_sha256: 'b'.repeat(64) } };
    const second = store.stage(job, edited);
    assert.notEqual(editorialPreviewHash(valid), editorialPreviewHash(edited));
    assert.equal(second.status, 'AWAITING_FINAL_APPROVAL');
    assert.equal(second.revision, 2);
    assert.deepEqual(store.claimPublications(), []);
    assert.throws(() => decide(store, first.preview_hash), /CHANGED/);
    decide(store, second.preview_hash);
    const [edition] = store.claimPublications();
    validatePersonalEdition(edition);
    assert.equal(edition.subtype, 'read');
    assert.deepEqual(edition.source_document, edited.source_document);
    assert.equal(edition.content_hash, personalContentHash(edition));
    assert.throws(() => validatePersonalEdition({ ...edition, source_document: valid.source_document }), /INVALID/);

    const html = editorialAnalysisPage(edition);
    assert.match(html, /Lesestand: Auszug/);
    assert.match(html, /href="https:\/\/example.org\/reading-source"[^>]+>Originaldokument öffnen/);
    assert.match(html, /"articleSection":"Nachgelesen"/);
    const item = { ...edition, status: 'published', teaser: 'Fiktiver Vorspann', updated_at: at };
    const feeds = tickerRssFeeds([], [item]);
    assert.match(feeds.analyses, /Nachgelesen: Fiktiver Beitrag/);
    assert.doesNotMatch(feeds.news, /Fiktiver Beitrag/);
  } finally {
    db.close();
  }
});
