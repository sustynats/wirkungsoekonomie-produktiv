import { assertDirectNewsUrl, sourceAccess } from '../access-policy.mjs';
import { extractArticleText, fetchPublicArticle } from '../lib.mjs';
import { safeUrl } from './contract.mjs';

export const readingEvidenceKey = input => `editorial-reading-evidence:${input.job_id}:${input.input_hash}`;

export async function collectReadingEvidence(input, registry, { fetchImpl = fetch } = {}) {
  const originalUrl = safeUrl(input.request.document_url);
  const host = assertDirectNewsUrl(originalUrl).hostname;
  const source = registry.sources.find(entry =>
    [entry.url, entry.feed_url].filter(Boolean).some(url => new URL(url).hostname === host));
  if (!source) throw Error('EDITORIAL_DOCUMENT_SOURCE_UNVERIFIED');
  const access = sourceAccess(source, 'article');
  if (!access.allowed) throw Error(access.reason);

  const policy = {
    ...registry.policy,
    allow_public_pdf: true,
    respect_robots: true,
    fingerprint_original: true,
  };
  const original = await fetchPublicArticle({ url: originalUrl }, source, policy, fetchImpl);
  const limit = Math.min(Number(policy.max_article_excerpt_chars || 7000), 7000);
  const excerpt = original.extracted_from === 'public_pdf'
    ? original.body.trim().slice(0, limit)
    : extractArticleText(original.body, limit);
  if (excerpt.length < 120) throw Error('ARTICLE_TEXT_TOO_SHORT');
  return {
    receipt: {
      job_id: input.job_id,
      input_hash: input.input_hash,
      source_id: source.source_id,
      original_url: originalUrl,
      final_url: safeUrl(original.final_url),
      content_sha256: original.original_sha256,
      reading_status: 'excerpt',
    },
    excerpt,
  };
}

export function assertReadingEvidence(input, document, receipt) {
  if (!document || !receipt || receipt.job_id !== input.job_id || receipt.input_hash !== input.input_hash ||
      !receipt.source_id || typeof receipt.content_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.content_sha256) || receipt.reading_status !== 'excerpt' ||
      receipt.original_url !== safeUrl(input.request.document_url) ||
      document.original_url !== receipt.original_url ||
      document.content_sha256 !== receipt.content_sha256 ||
      document.reading_status !== receipt.reading_status) {
    throw Error('EDITORIAL_DOCUMENT_EVIDENCE_MISMATCH');
  }
}
