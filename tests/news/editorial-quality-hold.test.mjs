import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialQualityHeld, editorialQualityHoldFor, runWirkungsticker } from '../../scripts/news/run.mjs';

const now = '2026-11-20T18:00:00.000Z';
function heldStory() {
  const item = { source_id: 'test', publisher_id: 'test', publisher: 'Test', url: 'https://example.org/klimagesetz',
    title: 'Bund beschließt Klimagesetz zur Energieversorgung',
    summary: 'Neue Regeln verändern Investitionen in Energie und Infrastruktur. Die Verwaltung kündigt neue Anforderungen an öffentliche Gebäude und einen Beginn im kommenden Jahr an.',
    primary_source: true, published_at: now, content_hash: 'original-source' };
  return { story_id: 'wt-editorial-held', slug: 'editorial-held', title: item.title, published: false, listed: false,
    first_seen: now, last_updated: now, published_at: now, current_version: 1, content_hash: 'retained-input',
    analysis: { summary: 'Retained known answer for editorial review.' },
    versions: [{ version: 1, analysis: { summary: 'Retained known answer for editorial review.' } }],
    sources: [item], editorial_quality_hold: { schema_version: '1', status: 'open', reason_code: 'SYNTHETIC_EDITORIAL_FINDING',
      reason: 'Synthetic local test only.', held_at: now, original_content_hash: 'retained-input' } };
}

test('editorial hold is independent of mutable paid fingerprints and never invents provider uncertainty', () => {
  const held = heldStory(), before = structuredClone(held);
  for (const marker of [held.editorial_quality_hold, {}, false, 'future-format']) {
    const changed = { ...held, editorial_quality_hold: marker, current_version: 9, content_hash: 'changed', title: 'Changed title' };
    assert.equal(editorialQualityHeld(changed), true);
    assert.equal(editorialQualityHoldFor({ story_id: held.story_id, existing_story: changed, sources: [] }), changed);
  }
  assert.deepEqual(held, before);
  assert.equal(held.provider_request_hold, undefined);
  assert.equal(held.ai_retry, undefined);
});

test('retained document identity fences a renamed candidate while unrelated new inputs remain eligible', () => {
  const held = heldStory();
  const sameDocument = { story_id: 'new-candidate-id', title: 'Changed headline', current_version: 7,
    sources: [{ ...held.sources[0], url: 'https://www.example.org/klimagesetz?utm_source=changed#fragment',
      content_hash: 'changed', published_at: '2026-11-21T12:00:00.000Z' }] };
  assert.equal(editorialQualityHoldFor(sameDocument, [held]), held);
  assert.equal(editorialQualityHoldFor({ story_id: 'new-school', sources: [{ url: 'https://example.org/bildung' }] }, [held]), null);
  assert.equal(editorialQualityHoldFor({ story_id: 'unrelated', sources: [{ url: undefined }] }, [held]), null);
});

test('native run preserves the whole held record and historical usage while a different input reaches the local provider stub', async t => {
  const config = { WIRKUNGSTICKER_PROCESSING_MODE: 'api', WOEK_NEWS_AI_BATCH_SIZE: '1',
    WOEK_NEWS_MAX_AI_STORIES_PER_RUN: '2', WOEK_NEWS_ONLY: 'false' };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  }
  const held = heldStory();
  held.pending_update = { sources: held.sources.map(s => ({ ...s, content_hash: 'changed-fingerprint' })),
    detected_at: now, reason: 'AI_BUDGET_OR_BATCH_LIMIT', reassessment: true };
  const untouched = structuredClone(held);
  const neighbour = { story_id: 'wt-new-school', slug: 'new-school',
    title: 'Bund beschließt Bildungsgesetz nach neuer Vergleichsstudie', published: false, listed: true,
    first_seen: now, last_updated: now, pending_reason: 'AI_BUDGET_OR_BATCH_LIMIT',
    sources: [{ ...held.sources[0], url: 'https://example.org/bildung',
      title: 'Bund beschließt Bildungsgesetz nach neuer Vergleichsstudie',
      summary: 'Eine Vergleichsstudie nennt Ergebnisse für Mathematik. Neue Regeln für die Ausbildung von Lehrkräften betreffen Schulen und Unterricht.' }] };
  const source = { source_id: 'test', publisher_id: 'test', name: 'Test', url: 'https://example.org/',
    feed_url: 'https://example.org/rss', enabled: true, source_type: 'official_rss', primary_source: true,
    access: { status: 'public', article: 'metadata_only', cost_usd: 0 }, frequency_class: 'high_frequency' };
  const historicalUsage = { run_id: 'synthetic-old-paid', started_at: '2026-11-19T12:00:00.000Z', ai_calls: 1, estimated_cost_usd: 0.01 };
  let captured, localStubCalls = 0;
  const report = await runWirkungsticker({ dryRun: true, now,
    registry: { schema_version: '1.0', sources: [source], policy: {} },
    state: { source_status: {}, seen_items: {}, pending_story_ids: [], relevance_filter_version: '4.0' },
    storyStore: { stories: [held, neighbour] }, usage: { runs: [historicalUsage] },
    newsroom: { source_items: {}, events: {}, event_sources: [], discovery_candidates: [], decisions: [] },
    budgetFx: { rate_date: '2026-11-20', rate_usd_per_eur: 1.16 },
    fetchFeedImpl: async () => ({ not_modified: true, final_url: source.feed_url }),
    fetchArticleImpl: async () => { throw Error('No network in this local test'); },
    aiBatchDelayImpl: async () => {}, captureState: value => { captured = value; },
    callAiImpl: async stories => {
      localStubCalls++; assert.equal(stories.length, 1); assert.equal(stories[0].story_id, neighbour.story_id);
      throw Object.assign(Error('AI_PROVIDER_ERROR:429'), { requestAttempts: 0, providerNotCalled: true });
    } });
  assert.equal(localStubCalls, 1, 'only the unheld neighbour reaches the local stub; no external provider is used');
  assert.deepEqual(captured.storyStore.stories.find(s => s.story_id === held.story_id), untouched);
  assert.deepEqual(captured.usage.runs.find(r => r.run_id === historicalUsage.run_id), historicalUsage);
  assert.ok(report.editorial_quality_holds.some(r => r.held_story_id === held.story_id));
  assert.equal(captured.storyStore.stories.find(s => s.story_id === held.story_id).provider_request_hold, undefined);
});

test('a dormant editorial hold without pending work or a new feed item keeps the native editorial status at holds', async t => {
  const config = { WIRKUNGSTICKER_PROCESSING_MODE: 'api', WOEK_NEWS_AI_BATCH_SIZE: '1',
    WOEK_NEWS_MAX_AI_STORIES_PER_RUN: '2', WOEK_NEWS_ONLY: 'false' };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  }
  const held = heldStory(), original = structuredClone(held);
  assert.equal(held.pending_update, undefined);
  assert.equal(held.pending_reason, undefined);
  const source = { source_id: 'test', publisher_id: 'test', name: 'Test', url: 'https://example.org/',
    feed_url: 'https://example.org/rss', enabled: true, source_type: 'official_rss', primary_source: true,
    access: { status: 'public', article: 'metadata_only', cost_usd: 0 }, frequency_class: 'high_frequency' };
  let captured, localStubCalls = 0;
  const report = await runWirkungsticker({ dryRun: true, now,
    registry: { schema_version: '1.0', sources: [source], policy: {} },
    state: { source_status: {}, seen_items: {}, pending_story_ids: [], relevance_filter_version: '4.0' },
    storyStore: { stories: [held] }, usage: { runs: [] },
    newsroom: { source_items: {}, events: {}, event_sources: [], discovery_candidates: [], decisions: [] },
    budgetFx: { rate_date: '2026-11-20', rate_usd_per_eur: 1.16 },
    fetchFeedImpl: async () => ({ not_modified: true, final_url: source.feed_url }),
    fetchArticleImpl: async () => { throw Error('No network in this local test'); },
    aiBatchDelayImpl: async () => {}, captureState: value => { captured = value; },
    callAiImpl: async () => { localStubCalls++; assert.fail('A dormant hold must not reach any provider'); } });
  assert.equal(localStubCalls, 0);
  assert.equal(report.ai_calls, 0);
  assert.equal(report.story_clusters, 0);
  assert.equal(report.pending_stories_retried, 0);
  assert.equal(report.editorial_status, 'holds');
  assert.deepEqual(captured.storyStore.stories.find(s => s.story_id === held.story_id), original);
});
