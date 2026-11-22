import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterItems } from '../../scripts/news/lib.mjs';

const now = '2026-11-20T13:05:59.610Z';
const source = (title, url, extra = {}) => ({
  item_id: url, title, summary: '', url, source_id: 'fixture',
  published_at: '2026-11-20T10:00:00Z', source_priority: 1, ...extra,
});
const story = (story_id, title, sources, extra = {}) => ({
  story_id, title, sources, first_seen: '2026-11-20T10:00:00Z',
  last_updated: '2026-11-20T10:00:00Z', published: false, ...extra,
});

test('existing generated headline remains an ordinary matching anchor', () => {
  const records = [
    story('unrelated', 'other words', [source('other words', 'https://example.invalid/other')]),
    story('target', 'alpha beta gamma', [source('different source headline', 'https://example.invalid/old')]),
  ];
  const before = structuredClone(records);
  const result = clusterItems([source('alpha beta gamma', 'https://example.invalid/new')], records, now);
  assert.deepEqual(result.map(row => row.story_id), ['target']);
  assert.equal(result[0].existing_story, records[1]);
  assert.deepEqual(records, before);
});

test('normalized alias documents and equal non-URL strings retain original routing', () => {
  const alias = source('alpha beta gamma', 'https://example.invalid/old-alias');
  const records = [
    story('canonical', 'alpha beta gamma', [source('alpha beta gamma delta', 'https://example.invalid/canonical')],
      { living_file: { merged_story_ids: ['retired'] } }),
    story('retired', alias.title, [alias], { retirement: { reason_code: 'MERGED_INTO_LIVING_FILE' } }),
  ];
  const before = structuredClone(records);
  const routed = clusterItems([{ ...alias, url: alias.url + '?utm_source=fixture' }], records, now);
  assert.deepEqual(routed.map(row => row.story_id), ['canonical']);
  assert.equal(routed[0].existing_story, records[0]);
  assert.deepEqual(records, before);
  const invalid = source('alpha beta', 'not-a-url');
  assert.equal(clusterItems([{ ...invalid }], [story('raw', invalid.title, [invalid])], now)[0].story_id, 'raw');
});

test('a citation-free item can corroborate a court case through its URL path', () => {
  const cited = source('EuGH Urteil C-123/24', 'https://example.invalid/judgment',
    { summary: 'Urteil über Transparenz.' });
  const records = [story('court', cited.title, [cited])];
  const item = source('EuGH verkündet Urteil zur Transparenz', 'https://example.invalid/c12324');
  assert.equal(clusterItems([item], records, now)[0].story_id, 'court');
  const different = source('EuGH Urteil C-456/24', 'https://example.invalid/different');
  assert.notEqual(clusterItems([different], records, now)[0].story_id, 'court');
});

test('structured identities and policy references match without three shared title terms', () => {
  const formation = source('Bundeswehr stellt Cyberregiment auf', 'https://example.invalid/formation');
  const formationItem = source('Bundeswehr bekommt Cyberregiment', 'https://example.invalid/formation-new');
  assert.equal(clusterItems([formationItem], [story('formation', formation.title, [formation])], now)[0].story_id, 'formation');
  const policy = source('Gesicherte Leistung gesetzlich abgesichert', 'https://example.invalid/policy');
  const policyItem = source('Neue Regeln zum Kapazitätsmarkt', 'https://example.invalid/policy-new');
  assert.equal(clusterItems([policyItem], [story('policy', policy.title, [policy])], now)[0].story_id, 'policy');
});

test('exact ties retain original order and unknown or quality histories stay unchanged', () => {
  const base = source('alpha beta gamma', 'https://example.invalid/base');
  const records = [
    story('same', base.title, [base], { marker: 'first', pending_reason: 'AI_PROVIDER_OUTCOME_UNKNOWN',
      provider_hold: { status: 'unknown' }, quality_history: [{ fingerprint: 'retained' }] }),
    story('same', base.title, [base], { marker: 'second' }),
    story('unlisted', base.title, [base], { published: true, listed: false }),
  ];
  const before = structuredClone(records);
  const item = source(base.title, 'https://example.invalid/new');
  const result = clusterItems([item], records, now);
  assert.equal(result[0].existing_story.marker, 'first');
  assert.deepEqual(records, before);
  records.push(story('published', base.title, [base], { published: true, listed: true }));
  assert.equal(clusterItems([item], records, now)[0].story_id, 'published');
});

test('batch insertions and later invocations use current sources and titles', () => {
  const items = [
    source('alpha beta gamma delta', 'https://example.invalid/b1'),
    source('alpha beta gamma delta', 'https://example.invalid/b2', { source_priority: 5 }),
    source('alpha beta gamma delta', 'https://example.invalid/b3', { published_at: '2026-11-20T11:00:00Z' }),
    source('lambda omega theta', 'https://example.invalid/b4'),
  ];
  const before = structuredClone(items);
  const batch = clusterItems(items, [], now);
  assert.equal(batch.length, 2);
  const alpha = batch.find(row => row.title === 'alpha beta gamma delta');
  assert.equal(alpha.sources.length, 3);
  assert.equal(alpha.last_updated, '2026-11-20T11:00:00Z');
  assert.deepEqual(items, before);
  const mutable = story('mutable', 'alpha beta gamma', [source('alpha beta gamma', 'https://example.invalid/old')]);
  assert.equal(clusterItems([source(mutable.title, 'https://example.invalid/one')], [mutable], now)[0].story_id, 'mutable');
  mutable.title = 'lambda omega theta';
  mutable.sources = [source(mutable.title, 'https://example.invalid/replaced')];
  assert.equal(clusterItems([source(mutable.title, 'https://example.invalid/two')], [mutable], now)[0].story_id, 'mutable');
});
