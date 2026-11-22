import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredHourlyQuota } from '../../scripts/news/stundenkontingent.mjs';
const night = '2026-11-07T22:21:59.126Z'; // 23:21 Berlin
const day = '2026-11-07T12:21:59.126Z';
const base = { WOEK_NEWS_MAX_AI_STORIES_PER_HOUR: '4' };
test('unset and blank night quota fall back to configured daily quota', () => {
  for (const value of [undefined, '', '   ', '\t']) {
    assert.equal(configuredHourlyQuota({ ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: value }, night), 4);
    assert.equal(configuredHourlyQuota({ ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: value }, day), 4);
  }
});
test('an explicit zero remains an intentional nighttime pause', () => {
  const env = { ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: '0' };
  assert.equal(configuredHourlyQuota(env, night), 0);
  assert.equal(configuredHourlyQuota(env, day), 4);
});
test('a configured nighttime quota remains bounded by the daily quota', () => {
  assert.equal(configuredHourlyQuota({ ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: '1' }, night), 1);
  assert.equal(configuredHourlyQuota({ ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: '4' }, night), 4);
  assert.equal(configuredHourlyQuota({ ...base, WOEK_NEWS_NIGHT_STORIES_PER_HOUR: '9' }, night), 4);
});
