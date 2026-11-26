import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertReadingEvidence, collectReadingEvidence } from '../../scripts/news/bridge/editorial-reading-evidence.mjs';

const inputFor = host => ({
  job_id: 'wt_20261124T012900Z_aaaaaaaaaaaaaaaaaaaaaaaa',
  input_hash: 'f'.repeat(64),
  request: { kind: 'read', document_url: `https://${host}/document` },
});
const registryFor = host => ({
  sources: [{
    source_id: 'fixture-original', enabled: true, url: `https://${host}/`,
    rsl_url: `https://${host}/rsl.xml`,
    access: { status: 'public', article: 'bounded_public_text', cost_usd: 0 },
  }],
  policy: { resolve_dns: false, user_agent: 'WOek-Wirkungsticker', max_article_excerpt_chars: 320 },
});
const text = 'A synthetic document verifies the difference between the original document representation and a short excerpt. '.repeat(20);
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

function fixtureFetch(document, { robots = 'User-agent: *\nAllow: /', rsl = null } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    const { pathname } = new URL(url);
    calls.push(pathname);
    if (pathname === '/robots.txt') return new Response(robots);
    if (pathname === '/rsl.xml') return rsl === null ? new Response(null, { status: 404 }) : new Response(rsl);
    assert.equal(pathname, '/document');
    return document();
  };
  return { calls, fetchImpl };
}

test('reading evidence fingerprints the bounded HTTP representation before its text is decoded', async () => {
  const host = 'reading-bytes.example.org';
  const input = inputFor(host);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`<article>${text}</article>`)]);
  const fixture = fixtureFetch(() => new Response(bytes, { headers: { 'content-type': 'text/html' } }));
  const { receipt, excerpt } = await collectReadingEvidence(input, registryFor(host), fixture);
  assert.deepEqual(fixture.calls, ['/rsl.xml', '/robots.txt', '/document']);
  assert.equal(receipt.content_sha256, fingerprint(bytes));
  assert.notEqual(receipt.content_sha256, fingerprint(bytes.subarray(3)));
  assert.notEqual(receipt.content_sha256, fingerprint(excerpt));
  assert.ok(excerpt.length <= 320);
  assert.equal(receipt.reading_status, 'excerpt');
  assert.doesNotThrow(() => assertReadingEvidence(input, receipt, receipt));
  assert.throws(() => assertReadingEvidence(input, { ...receipt, reading_status: 'full_text' }, receipt), /MISMATCH/);
  assert.throws(() => assertReadingEvidence({ ...input, input_hash: 'c'.repeat(64) }, receipt, receipt), /MISMATCH/);
});

test('disabled, robots-blocked and RSL-blocked originals never reach the document transport', async () => {
  const blockedFetch = () => assert.fail('the original must not be read');
  const disabled = 'reading-disabled.example.org';
  const disabledRegistry = registryFor(disabled);
  disabledRegistry.sources[0].enabled = false;
  await assert.rejects(collectReadingEvidence(inputFor(disabled), disabledRegistry, { fetchImpl: blockedFetch }), /SOURCE_DISABLED/);
  const robotsHost = 'reading-robots.example.org';
  const robots = fixtureFetch(blockedFetch, { robots: 'User-agent: *\nDisallow: /document' });
  await assert.rejects(collectReadingEvidence(inputFor(robotsHost), registryFor(robotsHost), robots), /ROBOTS_DISALLOWED/);
  assert.deepEqual(robots.calls, ['/rsl.xml', '/robots.txt']);
  const rslHost = 'reading-rsl.example.org';
  const rsl = fixtureFetch(blockedFetch, {
    rsl: '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><prohibits type="usage">ai-input</prohibits></content></rsl>',
  });
  await assert.rejects(collectReadingEvidence(inputFor(rslHost), registryFor(rslHost), rsl), /RSL_AI_INPUT_DISALLOWED/);
  assert.deepEqual(rsl.calls, ['/rsl.xml']);
});

test('partial representations and paywall markup cannot produce a receipt', async () => {
  const host = 'reading-fragment.example.org';
  const partial = fixtureFetch(() => new Response(text, { status: 206, headers: { 'content-range': 'bytes 0-199/2000' } }));
  await assert.rejects(collectReadingEvidence(inputFor(host), registryFor(host), partial), /ORIGINAL_INCOMPLETE/);
  const paywall = fixtureFetch(() => new Response(`<script>{"isAccessibleForFree":false}</script><article>${text}</article>`,
    { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(collectReadingEvidence(inputFor(host), registryFor(host), paywall), /ARTICLE_ACCESS_RESTRICTED/);
});

test('a PDF receipt fingerprints the PDF itself and only passes a bounded excerpt to drafting', async () => {
  const host = 'reading-pdf.example.org';
  const line = 'Synthetic primary document with evidence of a technical reading flow.';
  const stream = `BT /F1 10 Tf 72 700 Td 12 TL ${Array(6).fill(`(${line}) Tj T*`).join(' ')} ET`;
  const records = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [i, record] of records.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, '0')} 00000 n \n`);
    pdf += `${i + 1} 0 obj\n${record}\nendobj\n`;
  }
  pdf += `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
  const bytes = Buffer.from(pdf);
  const fixture = fixtureFetch(() => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  const { excerpt, receipt } = await collectReadingEvidence(inputFor(host), registryFor(host), fixture);
  assert.match(excerpt, /Synthetic primary document/);
  assert.ok(excerpt.length <= 320);
  assert.equal(receipt.content_sha256, fingerprint(bytes));
  assert.equal(receipt.reading_status, 'excerpt');
});
