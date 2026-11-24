import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hash } from '../../scripts/news/bridge/contract.mjs';
import { berlinInstant } from '../../scripts/news/lage.mjs';
import { regeneratablePublicationPath } from '../../scripts/news/publish-git.mjs';
import { RSS_CHANNELS, RSS_SITE, SDG_JSON_FEED_PATH, SDG_RSS_CHANNEL, renderRssFeed, rssDiscoveryLinks, sdgFeedDiscoveryLinks } from '../../scripts/news/rss-channels.mjs';
import { buildSdgEditionPages } from '../../scripts/news/sdg/edition-pages.mjs';
import { writeSdgEditionCandidate } from '../../scripts/news/sdg/package-edition.mjs';
import { escape as escapeHtml } from '../../scripts/news/editorial-markdown.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'woek-sdg-edition-feed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map();
  const render = () => buildSdgEditionPages({
    root, site: RSS_SITE, includeFeeds: true, pageShell: page => page.body,
    write: (file, content) => files.set(path.relative(root, file), content), escapeHtml,
  });
  return { root, render, files };
}

function renderFeedDirectory(root) {
  for (const file of ['assets/data/navigation.json', 'templates/footer.html']) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(new URL('../../' + file, import.meta.url), destination);
  }
  const script = fileURLToPath(new URL('../../scripts/feeds/build-feeds-page.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { cwd: root });
  return fs.readFileSync(path.join(root, 'feeds/index.html'), 'utf8');
}

test('the feed projection preserves empty and nonempty registered windows without a top-N filter or invented dates', t => {
  const { root, files, render } = fixture(t);
  const store = path.join(root, 'data/news/sdg');
  fs.mkdirSync(store, { recursive: true });
  const releases = Array.from({ length: 125 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 10, 23 - i)).toISOString().slice(0, 10);
    const editionId = `${date}-morgenlage`;
    const time = berlinInstant(date, 6);
    const manifest = {
      schema_version: 1, kind: 'sdg_edition_candidate', edition_id: editionId, ledger_sha256: 'b'.repeat(64),
      scheduled_at: time, cutoff_at: time, sealed_at: time, published_at: null,
      items: i === 1 ? [{
        revision_id: 'a'.repeat(64), title: 'Nur im Ausgabenartikel', summary: 'Ausgabeninhalt aus dem Test.',
        domain: 'legal', stage: 'adopted', sources: [{ url: 'https://example.org/sdg-source' }],
        impact: { human: { label: 'Beobachtung' }, planet: { label: 'Offen' }, democracy: { label: 'Offen' } },
      }] : [],
    };
    const pack = { manifest, sha256: hash(manifest) };
    writeSdgEditionCandidate(path.join(store, 'editions'), pack);
    return { edition_id: editionId, sha256: pack.sha256 };
  });
  fs.writeFileSync(path.join(store, 'release-catalog.json'), JSON.stringify({ schema_version: 1, releases: releases.toReversed() }));
  const routes = render();
  const rss = files.get(SDG_RSS_CHANNEL.path.slice(1));
  const json = JSON.parse(files.get(SDG_JSON_FEED_PATH.slice(1)));
  const expectedLinks = releases.map(row => `${RSS_SITE}${SDG_RSS_CHANNEL.home}ausgabe/${row.edition_id}/`);
  const parsed = JSON.parse(execFileSync('python3', ['-c', `
import json, sys, xml.etree.ElementTree as ET
channel = ET.fromstring(sys.stdin.read()).find("channel")
print(json.dumps({
  "build": channel.findtext("lastBuildDate"),
  "home": channel.findtext("link"),
  "feed": channel.find("{http://www.w3.org/2005/Atom}link").get("href"),
  "items": [[x.findtext("link"),x.findtext("guid"),x.findtext("pubDate")] for x in channel.findall("item")],
}))
`], { input: rss, encoding: 'utf8' }));
  assert.equal(parsed.build, null);
  assert.equal(parsed.home, RSS_SITE + SDG_RSS_CHANNEL.home);
  assert.equal(parsed.feed, RSS_SITE + SDG_RSS_CHANNEL.path);
  assert.deepEqual(parsed.items, expectedLinks.map(url => [url, url, null]));
  assert.equal(json.feed_url, RSS_SITE + SDG_JSON_FEED_PATH);
  assert.deepEqual(json.items.map(item => item.id), expectedLinks);
  assert.equal(json.items[1]._woek_edition.checked_items, 1);
  assert.match(json.items[0].content_text, /keine geprüften Einträge/);
  assert.ok(json.items.every(item => !('date_published' in item) && !('date_modified' in item)));
  assert.ok(!JSON.stringify(json).includes('Nur im Ausgabenartikel'));
  assert.ok(!rss.includes('Nur im Ausgabenartikel'));
  const archive = files.get(SDG_RSS_CHANNEL.home.slice(1) + 'index.html');
  assert.ok(archive.includes(SDG_RSS_CHANNEL.path) && archive.includes(SDG_JSON_FEED_PATH));
  assert.equal(routes.length, 126);
  assert.equal(files.size, 128);
  assert.equal(render().length, routes.length);
  assert.equal(files.get(SDG_RSS_CHANNEL.path.slice(1)), rss);
  const registeredDirectory = renderFeedDirectory(root);
  assert.ok(registeredDirectory.includes(SDG_RSS_CHANNEL.path));
  assert.match(registeredDirectory, /Wirkungsticker - News/);
  fs.writeFileSync(path.join(store, 'ticker-mode.json'), JSON.stringify({
    schema_version: 1, mode: 'sdg', anchor: releases[1],
  }));
  const activeDirectory = renderFeedDirectory(root);
  assert.match(activeDirectory, /Wirkungsticker - Nachrichtenarchiv/);
  for (const { path: feedPath } of [...Object.values(RSS_CHANNELS), SDG_RSS_CHANNEL]) {
    assert.ok(activeDirectory.includes(feedPath));
  }
});

test('an empty catalogue adds no feeds and the original discovery and rebase scopes stay distinct', t => {
  const { root, files, render } = fixture(t);
  assert.deepEqual(render(), []);
  assert.equal(files.size, 0);
  assert.ok(!renderFeedDirectory(root).includes(SDG_RSS_CHANNEL.path));
  assert.ok(!rssDiscoveryLinks().includes(SDG_RSS_CHANNEL.path));
  assert.ok(rssDiscoveryLinks().includes(RSS_CHANNELS.analyses.path));
  assert.ok(rssDiscoveryLinks([SDG_RSS_CHANNEL]).includes(SDG_RSS_CHANNEL.path));
  assert.equal(sdgFeedDiscoveryLinks(`${RSS_SITE}/wirkungsticker/`), '');
  const activeDiscovery = sdgFeedDiscoveryLinks(`${RSS_SITE}/wirkungsticker/`, { sdgActive: true });
  assert.ok(activeDiscovery.includes(SDG_RSS_CHANNEL.path) && activeDiscovery.includes(SDG_JSON_FEED_PATH));
  assert.ok(sdgFeedDiscoveryLinks(RSS_SITE + SDG_RSS_CHANNEL.home).includes(SDG_RSS_CHANNEL.path));
  assert.equal(sdgFeedDiscoveryLinks(`${RSS_SITE}/wirkungsticker/analysen/`, { sdgActive: true }), '');
  const legacy = renderRssFeed([{ title: 'Editorial fixture', url: `${RSS_SITE}/example/`,
    summary: 'Archive', published_at: '2026-10-01T00:00:00Z' }], RSS_CHANNELS.analyses);
  assert.match(legacy, /<lastBuildDate>Thu, 01 Oct 2026 00:00:00 GMT<\/lastBuildDate>/);
  assert.ok(!legacy.includes(SDG_RSS_CHANNEL.path));
  assert.equal(regeneratablePublicationPath(SDG_RSS_CHANNEL.path.slice(1)), true);
  assert.equal(regeneratablePublicationPath(SDG_JSON_FEED_PATH.slice(1)), true);
  assert.equal(regeneratablePublicationPath('data/news/sdg/release-catalog.json'), false);
});
