import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseStore, createTitleImagePipeline, publicTitleImage} from '../../scripts/news/title-image/pipeline.mjs';

const suffix = 'releases/download/wirkungsticker-media-2026-11/wt-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
const legacy = `https://github.com/sustynats/wirkungsoekonomie.de/${suffix}`;
const privateRepo = `https://github.com/sustynats/wirkungsoekonomie-produktiv/${suffix}`;

test('public image projection retains legacy public images and excludes private repository URLs', () => {
  assert.equal(publicTitleImage({mode:'impact_card', og:{url:`${legacy}-og.png`}})?.og.url, `${legacy}-og.png`);
  assert.equal(publicTitleImage({mode:'impact_card', og:{url:`${privateRepo}-og.png`}}), null);
});

test('a private original is never exposed as an editorial background', () => {
  const result = publicTitleImage({mode:'editorial', og:{url:`${legacy}-og.png`}, source_visual:{url:`${privateRepo}-source.png`}});
  assert.ok(result?.og);
  assert.equal(result.background, undefined);
});

test('the default store stops before release operations when the data repository is private', async () => {
  let calls = 0;
  const publish = createReleaseStore({run:async () => {calls++; return '{"assets":[]}';}});
  await assert.rejects(publish(['/tmp/a.png'], {tag:'wirkungsticker-media-2026-11'}), {message:'PUBLIC_MEDIA_RELEASE_NOT_AUTHORIZED'});
  assert.equal(calls, 0);
});

test('the unavailable default destination stops before generation and preserves an existing public image', async () => {
  let generated = 0, rendered = 0;
  const old = {mode:'impact_card', og:{url:`${legacy}-og.png`}};
  const prepare = createTitleImagePipeline({generate:async () => {generated++;}, render:() => {rendered++;}});
  const result = await prepare({story_id:'wt-aaaaaaaaaaaaaaaa', title_image:old});
  assert.deepEqual(result.title_image, old);
  assert.equal(result.report.reason, 'PUBLIC_MEDIA_RELEASE_NOT_AUTHORIZED');
  assert.equal(generated, 0);
  assert.equal(rendered, 0);
});

test('the unavailable default destination replaces a private-only image with a local fallback', async () => {
  let generated = 0;
  const prepare = createTitleImagePipeline({generate:async () => {generated++;}});
  const result = await prepare({story_id:'wt-aaaaaaaaaaaaaaaa', title_image:{mode:'impact_card', og:{url:`${privateRepo}-og.png`}}});
  assert.equal(result.title_image.og.url, '/assets/img/generated/hero-systemgrafik-wirkungsoekonomie.png');
  assert.equal(result.report.higgsfield_called, false);
  assert.equal(generated, 0);
});
