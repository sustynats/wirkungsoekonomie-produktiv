import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedStories } from '../../scripts/news/living-files.mjs';

const story = (story_id, title, source_summary = '', last_updated = '2026-11-21T12:00:00Z') => ({
  story_id, title, source_summary, last_updated, published: true, listed: true, analysis: {},
});
const ids = (query, catalog, limit) => relatedStories(query, catalog, limit).map(({story}) => story.story_id);

test('related stories follow changed query and candidate titles after an initial lookup', () => {
  const query = story('query', 'Stromnetz-Sabotage');
  const grid = story('grid', 'Umspannwerk');
  const care = story('care', 'Pflegeausbildung', '', '2026-11-21T13:00:00Z');
  const catalog = [query, grid, care];
  assert.deepEqual(ids(query, catalog), ['grid']);
  query.title = 'Pflegeausbildung';
  assert.deepEqual(ids(query, catalog), ['care']);
  grid.title = 'Pflegeausbildung';
  assert.deepEqual(ids(query, catalog), ['care', 'grid']);
  assert.equal(relatedStories(query, catalog)[0].reason, 'Ausbildung und Versorgung in Gesundheitsberufen');
});

test('related stories follow changed summaries without retaining an obsolete topic', () => {
  const query = story('query', 'Bericht', 'Hitzeschutz');
  const heat = story('heat', 'Mitteilung', 'Hitzewelle');
  const fuel = story('fuel', 'Ankündigung', 'Kraftstoffpreise');
  const catalog = [query, heat, fuel];
  assert.deepEqual(ids(query, catalog), ['heat']);
  query.source_summary = 'Spritpreise';
  assert.deepEqual(ids(query, catalog), ['fuel']);
  fuel.source_summary = '';
  assert.deepEqual(ids(query, catalog), []);
  fuel.source_summary = 'Kraftstoffpreise';
  assert.deepEqual(ids(query, catalog), ['fuel']);
});

test('word rarity is recalculated for the current eligible catalog on every lookup', () => {
  const title = 'Solarspeicher Förderfenster Nordhafen';
  const query = story('query', title, 'Netzanschluss');
  const target = story('target', title, 'Netzanschluss');
  const extraA = story('extra-a', title);
  const extraB = story('extra-b', title);
  assert.deepEqual(ids(query, [query, target]), ['target']);
  assert.deepEqual(ids(query, [query, target, extraA, extraB]), []);
  assert.deepEqual(ids(query, [query, target]), ['target']);
  extraA.listed = false;
  extraB.published = false;
  assert.deepEqual(ids(query, [query, target, extraA, extraB]), ['target']);
});

test('publication, visibility, analysis and retirement changes remain effective after lookup', () => {
  const query = story('query', 'Umspannwerk');
  const target = story('target', 'Stromnetz-Sabotage');
  const catalog = [query, target];
  assert.deepEqual(ids(query, catalog), ['target']);
  target.published = false;
  assert.deepEqual(ids(query, catalog), []);
  target.published = true;
  target.listed = false;
  assert.deepEqual(ids(query, catalog), []);
  target.listed = true;
  target.analysis = null;
  assert.deepEqual(ids(query, catalog), []);
  target.analysis = {};
  target.retirement = {reason_code: 'MERGED_INTO_LIVING_FILE'};
  assert.deepEqual(ids(query, catalog), []);
  target.retirement.reason_code = 'OTHER';
  assert.deepEqual(ids(query, catalog), ['target']);
});

test('current timestamps, identifiers and requested limits determine result ordering', () => {
  const query = story('query', 'Umspannwerk');
  const first = story('first', 'Umspannwerk', '', '2026-11-21T12:00:00Z');
  const second = story('second', 'Umspannwerk', '', '2026-11-21T13:00:00Z');
  const catalog = [query, first, second];
  assert.deepEqual(ids(query, catalog), ['second', 'first']);
  first.last_updated = '2026-11-21T14:00:00Z';
  assert.deepEqual(ids(query, catalog, 1), ['first']);
  assert.deepEqual(ids(query, catalog, 0), []);
  first.story_id = 'query';
  assert.deepEqual(ids(query, catalog), ['second']);
});

test('shared text does not replace record identity or mutate the input records', () => {
  const query = Object.freeze(story('query', 'Umspannwerk'));
  const first = Object.freeze(story('first', 'Umspannwerk'));
  const second = Object.freeze(story('second', 'Umspannwerk'));
  const catalog = Object.freeze([query, first, second]);
  const result = relatedStories(query, catalog);
  assert.deepEqual(result.map(({story}) => story.story_id), ['first', 'second']);
  assert.equal(result[0].story, first);
  assert.equal(result[1].story, second);
  assert.deepEqual(ids(query, [second]), ['second']);
});
