import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordWebhookRejection, publishRss } from "../../scripts/discord/rss-publication.mjs";

const existing = { guid: "old", title: "Published earlier", link: "https://example.org/old" };
const latest = { guid: "new", title: "Latest article", link: "https://example.org/new" };
const items = [latest, existing];
const report = () => {};

test("initialises the live feed without announcing any existing entries", async () => {
  let state;
  await publishRss({ items, state: null, save: async (value) => { state = value; }, send: () => assert.fail("Unexpected Discord post"), report });
  assert.deepEqual(state, { seen: ["new", "old"] });
});

test("a storage quota failure stops the post before Discord receives it", async () => {
  await assert.rejects(publishRss({
    items,
    state: { seen: ["old"] },
    save: async () => { throw new Error("Repository is above its size quota"); },
    send: () => assert.fail("A post must not precede the successful state write"),
    report,
  }), /above its size quota/);
});

test("a repeated feed and duplicate rows only announce a newly reserved entry once", async () => {
  let state = { seen: ["old"] };
  const posts = [];
  const save = async (value) => { state = value; };
  const send = async (item) => {
    assert(state.seen.includes(item.guid));
    posts.push(item.guid);
  };
  await publishRss({ items: [latest, ...items], state, save, send, report });
  await publishRss({ items, state, save, send, report });
  assert.deepEqual(posts, ["new"]);
});

test("a lost webhook response retains the reservation even after restarting", async () => {
  let state = { seen: ["old"] };
  const save = async (value) => { state = value; };
  const delivered = [];
  await assert.rejects(publishRss({
    items, state, save, report,
    send: async (item) => { delivered.push(item.guid); throw new Error("Connection lost after delivery"); },
  }), /delivery is unconfirmed/);
  await publishRss({ items, state, save, send: () => assert.fail("Retry would duplicate delivery"), report });
  assert.deepEqual(delivered, ["new"]);
});

test("a definite Discord rejection releases the reservation for a later attempt", async () => {
  let state = { seen: ["old"] };
  const save = async (value) => { state = value; };
  await assert.rejects(publishRss({
    items, state, save, report,
    send: async () => { throw new DiscordWebhookRejection(429); },
  }), /HTTP 429/);
  assert.deepEqual(state, { seen: ["old"] });
  await publishRss({ items, state, save, send: async () => {}, report });
  assert.deepEqual(state, { seen: ["old", "new"] });
});

test("damaged state never falls back to republishing the feed", async () => {
  await assert.rejects(publishRss({
    items, state: {}, report,
    save: () => assert.fail("Damaged state must not be replaced"),
    send: () => assert.fail("Damaged state must not trigger posts"),
  }), /Invalid Discord publication state/);
});
