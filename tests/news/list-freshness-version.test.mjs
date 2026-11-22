import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workerRoot = process.env.WORKER_SOURCE_ROOT || root;
const template = fs.readFileSync(path.join(root, "scripts/news/build.mjs"), "utf8");
const scriptQuery = template.match(/assets\/js\/news-pwa\.js\?v=\$\{PUBLIC_RELEASE\}([^"\s]*)/);
assert.ok(scriptQuery, "the shared page template must reference the freshness client");
assert.ok(scriptQuery[1], "the repaired client must have a new asset query");

for (const workerFile of ["wirkungsticker/sw.js", "sw.js"]) {
  test(`${workerFile}: new template query avoids the old exact cached freshness client`, async () => {
    const origin = "https://wirkungsoekonomie.de";
    const oldUrl = `${origin}/assets/js/news-pwa.js?v=20260912-news-freshness`;
    const newUrl = `${oldUrl}${scriptQuery[1]}`;
    const cache = new Map([[oldUrl, new Response("old client")]]);
    const handlers = new Map(), timers = new Set(), waits = [], requests = [];
    let releaseNetwork;
    const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
    const key = request => typeof request === "string" ? new URL(request, origin).href : request.url;
    const context = {
      URL, Response, AbortController,
      setTimeout(fn, delay) { const id = setTimeout(fn, delay); timers.add(id); return id; },
      clearTimeout(id) { clearTimeout(id); timers.delete(id); },
      self: { location: { origin }, addEventListener(name, fn) { handlers.set(name, fn); } },
      caches: { open: async () => ({
        async match(request, options = {}) {
          const url = key(request);
          if (!options.ignoreSearch) return cache.get(url)?.clone();
          for (const [cachedUrl, response] of cache) if (new URL(cachedUrl).pathname === new URL(url).pathname) return response.clone();
        },
        async put(request, response) { cache.set(key(request), response); },
      }) },
      fetch: async request => { requests.push(key(request)); await networkGate; return new Response("repaired client"); },
    };
    try {
      vm.runInNewContext(fs.readFileSync(path.join(workerRoot, workerFile), "utf8"), context);
      let response;
      handlers.get("fetch")({ request: new Request(newUrl), respondWith(value) { response = value; }, waitUntil(value) { waits.push(value); } });
      assert.ok(response, "the existing worker must handle this script request");
      let settled = false;
      response.then(() => { settled = true; });
      await new Promise(setImmediate);
      assert.equal(settled, false, "an old exact cached script must not win immediately for the new query");
      assert.deepEqual(requests, [newUrl]);
      releaseNetwork();
      assert.equal(await (await response).text(), "repaired client");
      await Promise.all(waits);
    } finally {
      releaseNetwork();
      for (const timer of timers) clearTimeout(timer);
    }
  });
}
