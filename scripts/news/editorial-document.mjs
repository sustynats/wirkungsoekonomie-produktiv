import { safeUrl } from './bridge/contract.mjs';

const FIELDS = new Set(['title', 'original_url', 'content_sha256', 'reading_status']);
export const readingStatusLabel = Object.freeze({ full_text: 'Volltext', excerpt: 'Auszug' });

export function validateEditorialDocument(value, sources) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !FIELDS.has(key)) ||
      typeof value.title !== 'string' || !value.title.trim() || value.title.length > 250 ||
      typeof value.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.content_sha256) ||
      !Object.hasOwn(readingStatusLabel, value.reading_status)) {
    throw Error('EDITORIAL_DOCUMENT_INVALID');
  }
  const original = safeUrl(value.original_url);
  if (!sources.some(source => safeUrl(source.url) === original)) {
    throw Error('EDITORIAL_DOCUMENT_SOURCE_NOT_BOUND');
  }
}
