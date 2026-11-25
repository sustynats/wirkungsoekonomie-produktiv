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

test('registered SDG editions build stable case chronologies and retain original versions', t => {
  const { root, files, render } = fixture(t);
  const store = path.join(root, 'data/news/sdg');
  const caseId = '1'.repeat(64);
  const unrelatedCase = '2'.repeat(64);
  const earlierRevision = 'a'.repeat(64);
  const correctedRevision = 'b'.repeat(64);
  const caseEvent = '3'.repeat(64);
  const rows = [
    ['2026-11-22', [{
      title: 'Ursprünglicher Beschluss', revision_id: earlierRevision, event_id: caseEvent, event_at: '2026-11-21',
    }, {
      title: 'Unabhängige Maßnahme', case_id: unrelatedCase, revision_id: 'd'.repeat(64),
      event_id: caseEvent, supersedes: earlierRevision, event_at: '2026-11-20',
    }]],
    ['2026-11-23', [{
      title: 'Umsetzung begonnen', revision_id: 'c'.repeat(64), event_id: '4'.repeat(64), event_at: '2026-11-22',
      domain: 'implementation', stage: 'started',
    }]],
    ['2026-11-24', [{
      title: 'Korrigierter Beschluss', revision_id: correctedRevision, event_id: caseEvent,
      supersedes: earlierRevision, event_at: '2026-11-21',
      reference_frameworks: ['UN SDG 3.8', 'Deutsche Nachhaltigkeitsstrategie'],
    }, {
      title: 'Prüfbericht ohne Ereignisdatum', revision_id: 'e'.repeat(64), event_id: '5'.repeat(64),
      event_at: null, domain: 'observations', stage: 'reported',
    }]],
  ];
  const releases = rows.map(([date, items]) => {
    const id = `${date}-morgenlage`;
    const scheduledAt = berlinInstant(date, 6);
    const hasReferences = date === '2026-11-24';
    const manifest = {
      schema_version: hasReferences ? 2 : 1, kind: 'sdg_edition_candidate', edition_id: id, ledger_sha256: '0'.repeat(64),
      scheduled_at: scheduledAt, cutoff_at: scheduledAt, sealed_at: scheduledAt, published_at: null,
      items: items.map(item => ({
        case_id: caseId, domain: 'legal', stage: 'adopted', summary: 'Quellengebundener Testeintrag.',
        discovered_at: scheduledAt, sources: [{
          url: `https://example.org/source/${item.revision_id}`, title: 'Originalquelle', source_published_at: date,
        }],
        impact: {
          human: { label: '+ Potenzial', magnitude: 2, temporal_status: 'ex_ante', evidence_label: 'mittel' },
          planet: { label: '? Richtung offen', magnitude: null, temporal_status: 'ongoing', evidence_label: 'nicht bewertbar' },
          democracy: { label: 'Offen' },
        },
        ...(hasReferences ? { reference_frameworks: [] } : {}),
        ...item,
      })),
    };
    const pack = { manifest, sha256: hash(manifest) };
    writeSdgEditionCandidate(path.join(store, 'editions'), pack);
    return { edition_id: id, sha256: pack.sha256 };
  });
  const catalogFile = path.join(store, 'release-catalog.json');
  const catalog = JSON.stringify({ schema_version: 1, releases: releases.toReversed() });
  fs.writeFileSync(catalogFile, catalog);
  const routes = render();
  const caseRoute = `wirkungsticker/sdg/massnahme/${caseId}/`;
  const otherRoute = `wirkungsticker/sdg/massnahme/${unrelatedCase}/`;
  assert.ok(routes.includes(caseRoute) && routes.includes(otherRoute));
  assert.equal(regeneratablePublicationPath(caseRoute + 'index.html'), true);
  const chronology = files.get(caseRoute + 'index.html');
  const headings = [...chronology.matchAll(/<h2>([^<]+)<\/h2>/g)].map(([, heading]) => heading);
  assert.deepEqual(headings, ['Ursprünglicher Beschluss', 'Korrigierter Beschluss', 'Umsetzung begonnen', 'Prüfbericht ohne Ereignisdatum']);
  assert.ok(chronology.includes(`href="#sdg-${earlierRevision}">Frühere Fassung`));
  assert.ok(chronology.includes(`/wirkungsticker/sdg/ausgabe/2026-11-24-morgenlage/#sdg-${correctedRevision}`));
  assert.ok(chronology.includes(`https://example.org/source/${earlierRevision}`));
  assert.ok(chronology.includes('<dt>Umsetzung</dt><dd>begonnen</dd>'));
  assert.ok(chronology.includes('<dt>Ereignisdatum</dt><dd>Offen</dd>'));
  assert.ok(!files.get(otherRoute + 'index.html').includes('Frühere Fassung'));
  const originalEdition = files.get('wirkungsticker/sdg/ausgabe/2026-11-22-morgenlage/index.html');
  assert.ok(originalEdition.includes(`/${caseRoute}#sdg-${earlierRevision}`));
  assert.doesNotMatch(originalEdition, /<h3>Referenzrahmen<\/h3>/);
  const revisedEdition = files.get('wirkungsticker/sdg/ausgabe/2026-11-24-morgenlage/index.html');
  for (const page of [revisedEdition, chronology]) {
    assert.equal(page.match(/<h3>Referenzrahmen<\/h3>/g)?.length, 1);
    assert.ok(page.includes('<li>UN SDG 3.8</li><li>Deutsche Nachhaltigkeitsstrategie</li>'));
  }
  for (const page of [originalEdition, chronology]) {
    assert.ok(page.includes('Wirkungsökonomische Analyse (MPD)'));
    assert.ok(page.includes('<dt>Mensch</dt><dd>+ Potenzial · Ex ante · Tragweite begrenzt · Evidenz mittel</dd>'));
    assert.ok(page.includes('<dt>Planet</dt><dd>? Richtung offen · Laufende Prüfung · Evidenz nicht bewertbar</dd>'));
    assert.ok(page.includes('<dt>Demokratie</dt><dd>Offen</dd>'));
  }
  assert.ok(!files.get(SDG_JSON_FEED_PATH.slice(1)).includes(caseRoute));
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), catalog);
});

test('an entry is marked as late only when its event precedes the previous Berlin slot', t => {
  const { root, files, render } = fixture(t);
  const store = path.join(root, 'data/news/sdg');
  const caseId = '1'.repeat(64);
  const editionId = '2026-10-25-morgenlage';
  const scheduledAt = berlinInstant('2026-10-25', 6);
  const previousSlotAt = berlinInstant('2026-10-24', 18);
  const rows = [
    ['a', '2026-10-23', '23.10.2026'],
    ['b', '2026-10-24T15:59:59.000Z', '24.10.2026'],
    ['c', previousSlotAt, null],
    ['d', '2026-10-24', null],
    ['e', null, null],
  ];
  assert.equal(scheduledAt, '2026-10-25T05:00:00.000Z');
  assert.equal(previousSlotAt, '2026-10-24T16:00:00.000Z');
  const manifest = {
    schema_version: 1, kind: 'sdg_edition_candidate', edition_id: editionId, ledger_sha256: '0'.repeat(64),
    scheduled_at: scheduledAt, cutoff_at: scheduledAt, sealed_at: '2026-10-25T05:12:00.000Z', published_at: null,
    items: rows.map(([id, event_at]) => ({
      case_id: caseId, revision_id: id.repeat(64), event_at, discovered_at: '2026-10-24T23:30:00.000Z',
      title: `Vorgang ${id}`, domain: 'legal', stage: 'adopted', summary: 'Quellengebundener Testeintrag.',
      sources: [{ url: 'https://example.org/legal-source', source_published_at: '2026-10-17' }],
      impact: { human: { label: 'Beobachtung' }, planet: { label: 'Offen' }, democracy: { label: 'Offen' } },
    })),
  };
  const pack = { manifest, sha256: hash(manifest) };
  writeSdgEditionCandidate(path.join(store, 'editions'), pack);
  fs.writeFileSync(path.join(store, 'release-catalog.json'), JSON.stringify({ schema_version: 1, releases: [
    { edition_id: editionId, sha256: pack.sha256 },
  ] }));
  render();

  for (const route of [`ausgabe/${editionId}/`, `massnahme/${caseId}/`]) {
    const html = files.get(`wirkungsticker/sdg/${route}index.html`);
    for (const [id, eventAt, lateDate] of rows) {
      const article = html.split(`<article id="sdg-${id.repeat(64)}"`)[1].split('</article>')[0];
      const marker = article.match(/Nachgereicht - Ereignis vom ([\d.]+)/)?.[1] ?? null;
      assert.equal(marker, lateDate);
      assert.match(article, /Original vom 17\.10\.2026/);
      assert.match(article, /<dt>Erfasst am<\/dt><dd>25\.10\.2026<\/dd>/);
      if (!eventAt) assert.match(article, /<dt>Ereignisdatum<\/dt><dd>Offen<\/dd>/);
    }
  }
  const feedItem = JSON.parse(files.get(SDG_JSON_FEED_PATH.slice(1))).items[0];
  assert.equal(feedItem._woek_edition.scheduled_at, scheduledAt);
  assert.equal(feedItem._woek_edition.sealed_at, manifest.sealed_at);
  assert.equal('date_published' in feedItem, false);
});

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
