import assert from 'node:assert/strict';
import test from 'node:test';
import { attachRelatedTickerHistory, storySimilarityFromTokens } from '../../scripts/news/related-ticker-history.mjs';

// The production tokenizer remains unchanged in lib.mjs. An injected pure
// tokenizer lets this regression exercise the actual history helper without
// loading provider, source-fetch, build or repository modules.
const tokenize = value => new Set(String(value).split(/\s+/).filter(Boolean));
const storySimilarity = (a, b) => {
  const left = tokenize(a), right = tokenize(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter(token => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const containment = shared / Math.min(left.size, right.size);
  return Math.max(shared / union, containment * 0.86);
};
// Differential oracle retained from run.mjs at 47e74b5. No source contents,
// paid replies or runtime state are required by these synthetic tests.
function storyComparisonText(story) {
  return [
    story.title,
    story.analysis?.summary,
    ...(story.sources || []).flatMap((source) => [source.title, source.summary]),
  ].filter(Boolean).join(" ");
}

function originalHistory(candidates, stories) {
  const publishedHistory = (stories || [])
    .filter((story) => story.published && story.retirement?.reason_code !== "MERGED_INTO_LIVING_FILE");
  return candidates.map((candidate) => {
    const candidateText = storyComparisonText(candidate);
    const relatedTickerHistory = publishedHistory
      .filter((story) => story.story_id !== candidate.story_id)
      .map((story) => ({ story, similarity: storySimilarity(candidateText, storyComparisonText(story)) }))
      .filter(({ similarity }) => similarity >= 0.1)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(({ story }) => ({
        story_id: story.story_id,
        title: story.title,
        summary: story.analysis?.summary || "",
        source_published_at: (story.sources || [])
          .map((source) => source.published_at)
          .filter(Boolean)
          .sort()[0] || story.first_seen,
        source_urls: (story.sources || []).map((source) => source.url).slice(0, 3),
      }));
    return { ...candidate, related_ticker_history: relatedTickerHistory };
  });
}

const tokens = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const record = (id, title, extra = {}) => ({ story_id: id, title, published: true,
  first_seen: '2026-11-01T00:00:00Z', sources: [], ...extra });

// Explicit score cases protect the formula independently of the differential oracle.
test('token scores preserve empty, disjoint, containment and union behavior', () => {
  assert.equal(storySimilarityFromTokens(new Set(), new Set(['a'])), 0);
  assert.equal(storySimilarityFromTokens(new Set(['a']), new Set(['b'])), 0);
  assert.equal(storySimilarityFromTokens(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(storySimilarityFromTokens(new Set(['a']), new Set(['a', 'b', 'c'])), 0.86);
  assert.equal(storySimilarityFromTokens(new Set(['a', 'b']), new Set(['b', 'c'])), 0.43);
});

test('history preserves floating precision at the 0.1 inclusion threshold', () => {
  const left = tokens('left', 43);
  const history = [4, 5, 6].map(shared => record(`h${shared}`,
    [...left.slice(0, shared), ...tokens(`right${shared}-`, 43 - shared)].join(' ')));
  const candidate = record('candidate', left.join(' '), { published: false });
  const result = attachRelatedTickerHistory([candidate], history, tokenize);
  assert.deepEqual(result, originalHistory([candidate], history));
  // The original IEEE-754 formula yields 0.09999999999999999 for h5.
  assert.ok(storySimilarity(candidate.title, history[1].title) < 0.1);
  assert.deepEqual(result[0].related_ticker_history.map(x => x.story_id), ['h6']);
});

test('self and retired filters, listed false, stable ties and top five remain exact', () => {
  const candidate = record('self', 'same words', { published: false });
  const history = [record('self', 'same words'), record('unpublished', 'same words', { published: false }),
    record('retired', 'same words', { retirement: { reason_code: 'MERGED_INTO_LIVING_FILE' } }),
    record('h0', 'same words', { listed: false }),
    ...Array.from({ length: 7 }, (_, i) => record(`h${i + 1}`, 'same words'))];
  const result = attachRelatedTickerHistory([candidate], history, tokenize);
  assert.deepEqual(result, originalHistory([candidate], history));
  assert.deepEqual(result[0].related_ticker_history.map(x => x.story_id), ['h0', 'h1', 'h2', 'h3', 'h4']);
});

test('all comparison fields and the original history payload are retained', () => {
  const candidate = record('candidate', 'alpha', { published: false, analysis: { summary: 'beta' },
    sources: [{ title: 'gamma', summary: 'delta' }], related_ticker_history: ['stale'], marker: 4 });
  const history = [record('h', 'unrelated', { analysis: { summary: 'beta' }, sources: [
    { title: 'gamma', summary: 'delta', published_at: '2026-11-09T01:00:00Z', url: 'one' },
    { title: 'alpha', published_at: '2026-11-02T08:00:00Z', url: 'two' },
    { summary: '', published_at: null, url: 'three' }, { url: 'four' } ] }),
    record('fallback', 'alpha beta gamma delta', { analysis: {}, first_seen: 'fallback-date' })];
  const result = attachRelatedTickerHistory([candidate], history, tokenize);
  assert.deepEqual(result, originalHistory([candidate], history));
  const found = result[0].related_ticker_history.find(x => x.story_id === 'h');
  assert.equal(found.source_published_at, '2026-11-02T08:00:00Z');
  assert.deepEqual(found.source_urls, ['one', 'two', 'three']);
  assert.equal(result[0].marker, 4);
});

test('preparation scales tokenization by records while keeping all pair comparisons', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => record(`c${i}`, `common candidate${i}`, { published: false }));
  const history = Array.from({ length: 20 }, (_, i) => record(`h${i}`, `common history${i}`));
  let calls = 0;
  const result = attachRelatedTickerHistory(candidates, history, value => { calls++; return tokenize(value); });
  assert.deepEqual(result, originalHistory(candidates, history));
  assert.equal(calls, candidates.length + history.length);
  assert.equal(2 * candidates.length * history.length, 1200);
});

test('empty and self-only histories cause no tokenization and preserve duplicate records', () => {
  const candidate = record('self', 'words');
  let calls = 0;
  const counted = value => { calls++; return tokenize(value); };
  assert.deepEqual(attachRelatedTickerHistory([], [candidate], counted), []);
  assert.deepEqual(attachRelatedTickerHistory([candidate], undefined, counted), originalHistory([candidate], undefined));
  assert.deepEqual(attachRelatedTickerHistory([candidate], [candidate], counted), originalHistory([candidate], [candidate]));
  assert.equal(calls, 0);
  const other = record('other', 'words');
  assert.deepEqual(attachRelatedTickerHistory([candidate], [other, other], counted), originalHistory([candidate], [other, other]));
  assert.equal(calls, 2);
});

test('input records are not mutated and repeated invocations observe source changes', () => {
  const candidates = [record('c', 'first matched', { published: false })];
  const history = [record('h', 'first matched')];
  const before = structuredClone({ candidates, history });
  assert.deepEqual(attachRelatedTickerHistory(candidates, history, tokenize), originalHistory(candidates, history));
  assert.deepEqual({ candidates, history }, before);
  history[0].title = 'completely separate';
  history[0].sources.push({ title: 'new source', summary: 'fresh evidence' });
  assert.deepEqual(attachRelatedTickerHistory(candidates, history, tokenize), originalHistory(candidates, history));
  assert.deepEqual(attachRelatedTickerHistory(candidates, history, tokenize)[0].related_ticker_history, []);
});

test('deterministic varied corpora produce identical complete outputs', () => {
  let seed = 534811;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const sentence = () => Array.from({ length: random(12) }, () => `term${random(24)}`).join(' ');
  for (let round = 0; round < 16; round++) {
    const candidates = Array.from({ length: 9 }, (_, i) => record(`c${i}`, sentence(), { published: false,
      analysis: { summary: sentence() }, sources: [{ title: sentence(), summary: sentence() }] }));
    const history = Array.from({ length: 13 }, (_, i) => record(i < 3 ? `c${i}` : `h${i}`, sentence(), {
      published: i % 6 !== 0, listed: i % 4 !== 0, analysis: { summary: sentence() },
      retirement: i % 7 === 0 ? { reason_code: 'MERGED_INTO_LIVING_FILE' } : undefined,
      sources: [{ title: sentence(), summary: sentence(), url: `synthetic:${i}`, published_at: i % 2 ? '' : '2026-11-20T00:00:00Z' }] }));
    assert.deepEqual(attachRelatedTickerHistory(candidates, history, tokenize), originalHistory(candidates, history));
  }
});
