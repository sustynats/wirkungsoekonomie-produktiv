import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(process.env.NEWS_PWA_SOURCE || new URL("../../assets/js/news-pwa.js", import.meta.url), "utf8");
const initialNow = Date.parse("2026-11-21T21:30:00Z");
const oldDate = "2026-11-20T10:00:00Z";

function surface() {
  const events = new Map();
  return {
    events, dataset: {}, hidden: false, textContent: "", children: [],
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    classList: { add() {} },
  };
}

function harness({ route = "/wirkungsticker/", readerKind = "list", tools = false, changed = true, pageRevision = "old-revision", cardCount = 1, offline = false, failedFetch = false, pending = false, cooldown = 0 } = {}) {
  let now = initialNow, reloads = 0, badges = 0, requests = [], nextTimer = 0;
  const timers = new Map(), intervals = new Map(), pendingReplies = [];
  const reader = surface(); reader.dataset.newsReader = readerKind;
  const toolNode = tools ? surface() : null, button = surface(), status = surface();
  const card = surface(); card.dataset.newsUpdatedAt = oldDate; card.dataset.newsReleasedAt = oldDate;
  let renderedCards = cardCount ? [card] : [];
  const privateReadState = new Map([
    ["woek_ticker_notifications", "disabled"], ["woek_ticker_last_seen", oldDate],
    ["woek_ticker_last_notified", oldDate], ["unrelated-setting", "retain"],
  ]);
  const originalReadState = [...privateReadState], writes = [], session = new Map();
  if (cooldown) session.set("woek_ticker_last_auto_reload", String(cooldown));
  const document = Object.assign(surface(), {
    body: surface(), documentElement: surface(), visibilityState: "visible",
    querySelector(selector) {
      if (selector === "[data-news-app-tools]") return toolNode;
      if (selector === "main[data-news-reader]") return reader;
      if (selector === 'meta[name="woek-news-revision"]') return pageRevision ? { content: pageRevision } : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-news-card]") return renderedCards;
      if (selector === "[data-news-refresh-button]") return readerKind === "detail" ? [button] : [];
      if (selector === "[data-news-refresh-status]") return [status];
      return [];
    },
  });
  const navigator = {
    userAgent: "Desktop", maxTouchPoints: 0, onLine: !offline,
    setAppBadge: async () => { badges++; }, clearAppBadge: async () => { badges++; },
  };
  const window = Object.assign(surface(), {
    navigator, matchMedia: () => ({ matches: false }),
    location: { protocol: "https:", hostname: "wirkungsoekonomie.de", pathname: route, reload() { reloads++; } },
    setTimeout(fn, milliseconds) { const id = ++nextTimer; timers.set(id, { fn, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, milliseconds) { const id = ++nextTimer; intervals.set(id, { fn, milliseconds }); return id; },
    localStorage: {
      getItem: key => privateReadState.get(key) || null,
      setItem(key, value) { writes.push([key, value]); privateReadState.set(key, value); },
    },
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value) },
  });
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, {
    window, document, navigator, Date: Clock, Intl, AbortController,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (failedFetch) throw Error("offline");
      if (pending) await new Promise(resolve => pendingReplies.push(resolve));
      return { ok: true, json: async () => ({ _woek_revision: changed ? "new-revision" : "old-revision", items: [{ date_published: oldDate, _woek_released_at: oldDate }] }) };
    },
  });
  const settle = () => new Promise(setImmediate);
  return {
    document, window, button, status, timers, intervals, requests, writes, privateReadState, originalReadState,
    reloads: () => reloads, badges: () => badges, advance(ms) { now += ms; }, settle,
    hydrateCards() { renderedCards = [card]; },
    async fire(target, name) { for (const fn of target.events.get(name) || []) fn({}); await settle(); },
    async respond() { pendingReplies.splice(0).forEach(resolve => resolve()); await settle(); },
  };
}

function assertReadStateUntouched(h) {
  assert.deepEqual([...h.privateReadState], h.originalReadState);
  assert.equal(h.writes.length, 0);
  assert.equal(h.badges(), 0);
}

test("list pages without install tools pick up a new release on foreground events", async () => {
  for (const route of ["/wirkungsticker/", "/wirkungsticker/news/", "/wirkungsticker/analysen/"]) {
    for (const event of ["focus", "pageshow", "online", "visibilitychange"]) {
      const h = harness({ route });
      await h.fire(event === "visibilitychange" ? h.document : h.window, event);
      assert.equal(h.requests.length, 1, `${route}: ${event} must check freshness`);
      assert.match(h.requests[0].url, /^\/wirkungsticker\/feed\.json\?check=\d+$/);
      assert.equal(h.requests[0].options.cache, "no-store");
      assert.equal(h.reloads(), 1, "revision changes must refresh even when event dates stay unchanged");
      assertReadStateUntouched(h);
    }
  }
});

test("list freshness runs after first render and at the established five-minute interval", async () => {
  for (const kind of ["startup", "interval"]) {
    const h = harness();
    const timer = [...(kind === "startup" ? h.timers : h.intervals).values()].find(t => t.milliseconds === (kind === "startup" ? 750 : 300000));
    assert.ok(timer, `${kind} check must exist without optional tools`);
    timer.fn(); await h.settle();
    assert.equal(h.reloads(), 1);
    assertReadStateUntouched(h);
  }
});

test("a changed public revision refreshes initially empty and later hydrated lists", async () => {
  for (const hydrate of [false, true]) {
    const h = harness({ cardCount: 0 });
    if (hydrate) h.hydrateCards();
    await h.fire(h.window, "pageshow");
    assert.equal(h.requests.length, 1);
    assert.equal(h.reloads(), 1);
    assertReadStateUntouched(h);
  }
});

test("empty lists do not reload for unchanged or unknown page revisions", async () => {
  for (const options of [{ changed: false }, { pageRevision: null }]) {
    const h = harness({ cardCount: 0, ...options });
    await h.fire(h.window, "focus");
    await h.fire(h.window, "pageshow");
    assert.equal(h.requests.length, 2);
    assert.equal(h.reloads(), 0);
    assertReadStateUntouched(h);
  }
});

test("unchanged or unavailable feed preserves list and all notification/read state", async () => {
  for (const options of [{ changed: false }, { offline: true }, { failedFetch: true }]) {
    const h = harness(options);
    await h.fire(h.window, "focus");
    assert.equal(h.requests.length, options.offline ? 0 : 1);
    assert.equal(h.reloads(), 0);
    assertReadStateUntouched(h);
  }
});

test("overlapping foreground events reload once and a hidden list never reloads", async () => {
  const h = harness({ pending: true });
  await h.fire(h.window, "focus"); await h.fire(h.window, "pageshow");
  assert.equal(h.reloads(), 0);
  await h.respond(); assert.equal(h.reloads(), 1);
  assertReadStateUntouched(h);
  const hidden = harness(); hidden.document.visibilityState = "hidden";
  await hidden.fire(hidden.window, "focus");
  assert.equal(hidden.requests.length, 0); assert.equal(hidden.reloads(), 0);
  assertReadStateUntouched(hidden);
});

test("automatic reload cooldown prevents a loop without suppressing the next later check", async () => {
  const h = harness({ cooldown: initialNow - 10000 });
  await h.fire(h.window, "pageshow"); assert.equal(h.reloads(), 0);
  h.advance(61000);
  await h.fire(h.window, "focus"); assert.equal(h.reloads(), 1);
  assertReadStateUntouched(h);
});

test("detail readers keep their position and still support deliberate refresh", async () => {
  const h = harness({ readerKind: "detail", route: "/wirkungsticker/example/" });
  assert.equal(h.intervals.size, 0);
  await h.fire(h.window, "focus"); await h.fire(h.window, "pageshow");
  assert.equal(h.requests.length, 0); assert.equal(h.reloads(), 0);
  await h.fire(h.button, "click");
  assert.equal(h.requests.length, 1); assert.equal(h.reloads(), 1);
  assertReadStateUntouched(h);
});

test("existing tools-based overview retains its foreground refresh", async () => {
  const h = harness({ tools: true });
  await h.fire(h.window, "focus");
  assert.equal(h.requests.length, 1); assert.equal(h.reloads(), 1);
});
