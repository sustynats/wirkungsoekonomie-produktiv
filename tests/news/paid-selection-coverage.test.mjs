import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { balanceEventQueue, categoryCoverage, EVENT_RELEVANCE_VERSION } from '../../scripts/news/event-relevance.mjs';
import { newsOnlyPriorWorkHold, partitionAiQueue, aiDeferralReason, queuePriority, runWirkungsticker } from '../../scripts/news/run.mjs';

const now = '2026-11-21T08:00:00.000Z';
const stage = { stage: 0, threshold: 30 };
const ids = rows => rows.map(row => row.story_id);
const candidate = (id, category, base, relevance = 60, priority = 'NORMAL') => ({
  story_id: id, title: id, fresh: true, sources: [], selection_base_priority: base,
  preanalysis: { internal_relevance_score: relevance, event_score: { category, priority } },
});

test('paid selection does not count a held topic as completed coverage of safe inputs', () => {
  const held = { ...candidate('published-hold', 'economy', 300), existing_story: { published: true } };
  const a = candidate('safe-economy', 'economy', 100);
  const b = candidate('safe-science', 'science', 95);
  const originals = structuredClone([held, a, b]);
  // Reproduce the old caller's order with the real balancing and hold rules.
  const ready = balanceEventQueue([held, a, b], {})
    .filter(row => !newsOnlyPriorWorkHold(row, { WOEK_NEWS_ONLY: 'true' }));
  assert.deepEqual(ids(ready), ['safe-science', 'safe-economy']);
  const actual = partitionAiQueue(ready, stage, 1, now, {});
  const withoutHold = partitionAiQueue([a, b], stage, 1, now, {});
  assert.deepEqual(ids(actual.selected), ['safe-economy']);
  assert.deepEqual(ids(actual.selected), ids(withoutHold.selected));
  assert.equal(actual.selected[0], a);
  assert.deepEqual([held, a, b], originals, 'no mutation of candidates or retained records');
});

test('stage-filtered discovery candidates do not consume simulated topic coverage', () => {
  const below = candidate('below-stage-threshold', 'economy', 300, 29);
  below.preanalysis.discovery_review = { review: true };
  const a = candidate('safe-economy', 'economy', 100);
  const b = candidate('safe-science', 'science', 95);
  const previouslyBalanced = balanceEventQueue([below, a, b], {});
  assert.deepEqual(ids(previouslyBalanced), ['below-stage-threshold', 'safe-science', 'safe-economy']);
  const result = partitionAiQueue(previouslyBalanced, stage, 1, now, {});
  assert.deepEqual(ids(result.selected), ['safe-economy']);
  assert.ok(result.deferred.includes(below));
  assert.equal(aiDeferralReason(below, stage, 4), 'EDITORIAL_RELEVANCE_BELOW_THRESHOLD');
});

test('optional coverage preserves caller order when disabled and stable equal-score ties when enabled', () => {
  const first = candidate('first', 'economy', 100), second = candidate('second', 'economy', 100);
  const higher = candidate('higher', 'science', 200);
  const rows = [first, second, higher], original = structuredClone(rows), coverage = { economy: 2 };
  assert.deepEqual(ids(partitionAiQueue(rows, stage, 2, now).selected), ['first', 'second']);
  assert.deepEqual(ids(partitionAiQueue([first, second], stage, 2, now, coverage).selected), ['first', 'second']);
  assert.deepEqual(rows, original);
  assert.deepEqual(coverage, { economy: 2 });
});

test('post-filter coverage keeps TOP precedence, the existing old-work reserve and hard limits', () => {
  const tops = Array.from({ length: 4 }, (_, n) => candidate(`top-${n}`, 'security', 90, 60, 'TOP'));
  const fresh = Array.from({ length: 5 }, (_, n) => candidate(`fresh-${n}`, 'economy', 300, 70));
  const old = { ...candidate('old-unpaid', 'science', 1), fresh: false,
    existing_story: { published: false, pending_reason: 'AI_BUDGET_OR_BATCH_LIMIT', event_detected_at: '2026-11-21T04:00:00Z' } };
  assert.deepEqual(ids(partitionAiQueue([...fresh, ...tops, old], stage, 4, now, {}).selected), ids(tops));
  const reserved = partitionAiQueue([...fresh, old], stage, 4, now, {}).selected;
  assert.equal(reserved.length, 4);
  assert.ok(reserved.includes(old));
  for (const cap of [0, 1, 2, 4]) assert.equal(partitionAiQueue(fresh, stage, cap, now, {}).selected.length, cap);
  assert.equal(partitionAiQueue(fresh, { ...stage, max_stories_per_run: 2 }, 4, now, {}).selected.length, 2);
  assert.equal(partitionAiQueue(fresh, { ...stage, stage: 3 }, 4, now, {}).selected.length, 0);
});

test('native coverage selection retains published, paid, unknown and editorial holds while a safe input reaches only a local stub', async t => {
  const env = { WIRKUNGSTICKER_PROCESSING_MODE: 'api', WOEK_NEWS_ONLY: 'true', WOEK_NEWS_AI_BATCH_SIZE: '1',
    WOEK_NEWS_MAX_AI_STORIES_PER_RUN: '1', WOEK_NEWS_BUDGET_PACING: 'false', WOEK_NEWS_MAX_SOURCE_AGE_HOURS: '24' };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  }
  const source = { source_id: 'test', publisher_id: 'test', name: 'Test', url: 'https://example.org/',
    feed_url: 'https://example.org/rss', enabled: true, source_type: 'official_rss', primary_source: true,
    access: { status: 'public', article: 'metadata_only', cost_usd: 0 }, frequency_class: 'high_frequency' };
  const story = (id, title, summary) => ({ story_id: id, slug: id, title, published: false, listed: true,
    first_seen: now, last_updated: now, event_detected_at: now, pending_reason: 'AI_BUDGET_OR_BATCH_LIMIT',
    sources: [{ source_id: 'test', publisher_id: 'test', publisher: 'Test', url: `https://example.org/${id}`,
      title, summary, primary_source: true, published_at: now, content_hash: id }], versions: [] });
  const safe = story('safe-school', 'Bund beschließt Bildungsgesetz nach neuer Vergleichsstudie',
    'Eine Vergleichsstudie nennt Ergebnisse für Mathematik. Neue Regeln für die Ausbildung von Lehrkräften betreffen Schulen und Unterricht.');
  const published = story('published-poll', 'Neue Umfrage zur Bundestagswahl', 'Die Befragten nennen ihre Parteipräferenz für die Wahl.');
  published.published = true; published.current_version = 1;
  published.analysis = { summary: 'Retained published answer.' };
  published.versions = [{ version: 1, analysis: published.analysis }];
  published.pending_update = { reason: 'PAID_RECOVERY_PENDING', sources: published.sources, detected_at: now, reassessment: true };
  const paid = story('paid-factory', 'Unternehmen schließt Werk in Kiel', 'Die Fabrik wird geschlossen. Die Beschäftigten verlieren ihre Arbeitsplätze.');
  paid.ai_retry_history = [{ version: 'older-version', fingerprint: 'a'.repeat(64), retry_count: 1 }];
  const unknown = story('unknown-hospital', 'Gesundheitsbehörde eröffnet Krankenhaus in Bremen', 'Eine neue Versorgungskapazität soll Patientinnen und Patienten behandeln.');
  unknown.provider_request_hold = { status: 'unknown', run_id: 'synthetic-prior-run', request_attempts: 1, input_hash: 'retained-unknown' };
  const editorial = story('editorial-energy', 'Behörde eröffnet neue Energiezentrale in Leipzig', 'Neue Infrastruktur soll die Versorgung verändern.');
  editorial.listed = false; editorial.editorial_quality_hold = { status: 'open', reason_code: 'SYNTHETIC_REVIEW' };
  editorial.versions = [{ version: 1, analysis: { summary: 'Retained editorial answer.' } }];
  const originals = structuredClone([published, paid, unknown, editorial]);
  const usageRow = { run_id: 'synthetic-old-usage', started_at: '2026-11-19T12:00:00Z', ai_calls: 1, estimated_cost_usd: 0.01 };
  let captured; const calls = [];
  const report = await runWirkungsticker({ dryRun: true, now,
    registry: { sources: [source], policy: { event_relevance: { enabled: true } } },
    state: { source_status: {}, seen_items: {}, pending_story_ids: [], relevance_filter_version: EVENT_RELEVANCE_VERSION },
    storyStore: { stories: [published, paid, unknown, editorial, safe] }, usage: { runs: [usageRow] },
    newsroom: { source_items: {}, events: {}, event_sources: [], discovery_candidates: [], decisions: [] },
    budgetFx: { rate_date: '2026-11-21', rate_usd_per_eur: 1.16 },
    fetchFeedImpl: async () => ({ not_modified: true, final_url: source.feed_url }),
    fetchArticleImpl: async () => { assert.fail('No article/network request is needed by the synthetic fixture'); },
    aiBatchDelayImpl: async () => {}, captureState: value => { captured = value; },
    callAiImpl: async rows => {
      calls.push(...ids(rows));
      throw Object.assign(Error('AI_PROVIDER_ERROR:429'), { requestAttempts: 0, providerNotCalled: true });
    },
  });
  assert.deepEqual(calls, [safe.story_id]);
  assert.equal(report.ai_calls, 0, 'the local refusal stub never calls a provider');
  for (const original of originals) {
    assert.deepEqual(captured.storyStore.stories.find(row => row.story_id === original.story_id), original);
  }
  assert.deepEqual(captured.usage.runs.find(row => row.run_id === usageRow.run_id), usageRow);
  assert.ok(report.news_only_prior_work_held.some(row => row.story_id === published.story_id));
  assert.ok(report.news_only_prior_work_held.some(row => row.story_id === paid.story_id));
  assert.ok(report.provider_outcome_holds.some(row => row.story_id === unknown.story_id));
  assert.ok(report.editorial_quality_holds.some(row => row.held_story_id === editorial.story_id));
});

test('non-API admission preserves the original thematic order without starting any worker', () => {
  // Execute only the real caller's pure ordering block, with its real scoring
  // and balancing functions. No bridge runtime, feed or provider is started.
  const source = fs.readFileSync(new URL('../../scripts/news/run.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const initiallyEligible = currentClusters');
  const end = source.indexOf('  const eligibleIds =', start);
  assert.ok(start > 0 && end > start);
  const order = new Function('currentClusters', 'now', 'eventAuditEnabled', 'mode', 'storyStore',
    'queuePriority', 'latestSourceDate', 'balanceEventQueue', 'categoryCoverage',
    source.slice(start, end) + '\nreturn eligible;');
  const latestSourceDate = rows => rows.reduce((latest, row) => Math.max(latest, Date.parse(row.published_at)), 0);
  const a = candidate('fresh-economy', 'economy', 0, 60);
  const b = candidate('fresh-science', 'science', 0, 55);
  const held = { ...candidate('published-top', 'economy', 0, 100, 'TOP'), existing_story: { published: true } };
  held.preanalysis.material_development_review = { time_sensitive: true };
  const rows = [held, a, b]; rows.forEach(row => { row.sources = [{ published_at: now }]; });
  const original = structuredClone(rows);
  const base = [...rows].sort((left, right) => queuePriority(right, now) - queuePriority(left, now))
    .map(row => ({ ...row, selection_base_priority: queuePriority(row, now) }));
  const previousOrder = balanceEventQueue(base, categoryCoverage([], now));
  assert.notDeepEqual(ids(previousOrder), ids(base), 'fixture must exercise a real thematic reordering');
  for (const mode of ['dropbox_chatgpt_bridge', 'disabled']) {
    assert.deepEqual(order(rows, now, true, mode, { stories: [] }, queuePriority, latestSourceDate, balanceEventQueue, categoryCoverage), previousOrder);
  }
  assert.deepEqual(order(rows, now, true, 'api', { stories: [] }, queuePriority, latestSourceDate, balanceEventQueue, categoryCoverage), base,
    'API alone postpones balancing until after readiness holds');
  assert.deepEqual(rows, original);
});
