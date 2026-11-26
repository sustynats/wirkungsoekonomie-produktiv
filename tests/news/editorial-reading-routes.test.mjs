import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { findSearchIds } from '../../assets/js/ticker-search.js';
import { appNavigation, buildAppPages } from '../../scripts/news/app-pages.mjs';
import { retiredStoryPage } from '../../scripts/news/build.mjs';
import { RSS_CHANNELS } from '../../scripts/news/rss-channels.mjs';
import { buildSourcePages } from '../../scripts/news/source-pages.mjs';

test('the reading partition retains every reading and keeps the other public formats separate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'woek-reading-app-'));
  const publishedAt = '2026-11-24T01:00:00Z';
  const publicAnalyses = ['opinion_analysis', 'book_review', 'listened', 'watched', ...Array(23).fill('read')].map((subtype, index) => ({
    format: 'approved_editorial', subtype, analysis_id: `fixture-${index}`, slug: `fixture-${index}`,
    title: `Beispiel ${index}`, teaser: 'Rein fiktiver Test',
    published_at: publishedAt,
    ...(subtype === 'read' ? { source_document: { title: 'Dokumentwort', reading_status: 'excerpt' } } : {}),
  }));
  const news = [{ story_id: 'fixture-news', slug: 'fixture-news', title: 'Testmeldung', published_at: publishedAt }];
  const write = (file, html) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  };
  const json = (file) => JSON.parse(gunzipSync(readFileSync(join(root, 'wirkungsticker/data/app', file))));
  try {
    const pageInputs = {
      root, stories: news, analyses: publicAnalyses, storiesById: new Map(),
      storyCard: () => '<article data-news-card>Fiktive Meldung</article>',
      editorialCard: () => '<article data-news-card>Fiktiver Redaktionsbeitrag</article>',
      pageShell: ({ canonical, sdgActive, body }) => appNavigation(canonical, { sdgActive }) + body, write, updatedAt: publishedAt,
    };
    buildAppPages(pageInputs);
    const manifest = json('manifest.json.gz');
    const lookup = new Map(Object.values(manifest.lookup).map((record) => [record.id, record]));
    assert.deepEqual(manifest.feeds['analysen-read'], { count: 23, pages: 2 });
    const first = json('feeds/analysen-read-0.json.gz');
    const second = json('feeds/analysen-read-1.json.gz');
    assert.equal(first.revision, manifest.revision);
    assert.equal(second.revision, manifest.revision);
    const records = [...first.items, ...second.items];
    const ids = records.map(({ id }) => id);
    assert.equal(new Set(ids).size, 23);
    assert.ok(records.every((item) => item.type === 'read' && item.label === 'Nachgelesen'
      && item.date === '2026-11-24T01:00:00.000Z' && !('episode_date' in item)));
    assert.deepEqual(new Set(records.map((item) => item.url)), new Set(publicAnalyses.filter((item) => item.subtype === 'read')
      .map((item) => `/wirkungsticker/analyse/${item.slug}/`)));
    for (const type of ['analysis', 'book', 'listened', 'watched']) {
      assert.deepEqual(manifest.feeds[`analysen-${type}`], { count: 1, pages: 1 });
    }
    assert.deepEqual(manifest.feeds['analysen-alle'], { count: 27, pages: 2 });
    assert.deepEqual(manifest.feeds['news-alle'], { count: 1, pages: 1 });
    assert.deepEqual(await findSearchIds({
      term: 'Dokumentwort', lookup, type: 'read', topic: 'alle', mode: 'suche', sort: 'neueste',
      loadBucket: (key) => json(`search/${key}.json.gz`),
    }), ids);
    const readPage = (route) => readFileSync(join(root, 'wirkungsticker', route, 'index.html'), 'utf8');
    assert.match(readPage(''), /<h2>Nachgelesen<\/h2><a href="\/wirkungsticker\/analysen\/\?typ=read">/);
    assert.match(readPage('analysen'), /<option value="read">Nachgelesen<\/option>/);
    assert.match(readPage('suche'), /<option value="read">Nachgelesen<\/option>/);
    assert.match(readPage(''), /class="ticker-app-search" href="\/wirkungsticker\/suche\/"/);
    assert.doesNotMatch(readPage('suche'), /bereich=SDG-Tracker/);
    assert.match(readPage('mehr'), /href="\/wirkungsticker\/analysen\/\?typ=read">Nachgelesen</);
    assert.doesNotMatch(readPage('news'), /<option value="read">/);
    assert.match(RSS_CHANNELS.analyses.description, /Nachgelesen/);
    assert.equal(RSS_CHANNELS.analyses.path, '/wirkungsticker/analyse/feed.xml');
    buildAppPages({ ...pageInputs, sdgTicker: { releases: [{
      manifest: { edition_id: '2026-11-24-morgenlage', scheduled_at: '2026-11-24T05:00:00Z', items: [] },
    }] } });
    assert.match(readPage(''), /<h1>Global SDG Impact Tracker<\/h1>/);
    assert.match(readPage(''), /wie Nachhaltigkeitsmaßnahmen umgesetzt werden/);
    const editorialNav = readPage('').match(/<nav aria-labelledby="ticker-redaktion-title">([\s\S]*?)<\/nav>/)?.[1];
    assert.ok(editorialNav);
    for (const type of ['analysis', 'listened', 'watched', 'read', 'book']) {
      assert.ok(editorialNav.includes(`/wirkungsticker/analysen/?typ=${type}"`));
    }
    assert.match(readPage(''), /<h2>Nachgelesen<\/h2><a href="\/wirkungsticker\/analysen\/\?typ=read">/);
    assert.doesNotMatch(readPage(''), /Fiktive Meldung/);
    assert.match(readPage('news'), /Fiktive Meldung/);
    assert.match(readPage(''), /class="ticker-app-search" href="\/suche\.html\?bereich=SDG-Tracker"/);
    assert.match(readPage('suche'), /<h1>Suche in Nachrichtenarchiv und Redaktion<\/h1>/);
    assert.match(readPage('mehr'), /href="\/wirkungsticker\/suche\/">Nachrichtenarchiv und Redaktion durchsuchen/);
    assert.deepEqual(json('manifest.json.gz'), manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archived article and source permalinks use tracker navigation after the switch', () => {
  const story = { slug: 'archiv-meldung', title: 'Frühere Meldung', analysis: { summary: 'Unveränderte Kurzfassung' }, sources: [] };
  const legacy = retiredStoryPage(story);
  const switched = retiredStoryPage(story, { sdgActive: true });
  assert.match(legacy, /href="\/wirkungsticker\/news\//);
  assert.match(switched, /href="\/wirkungsticker\/sdg\//);
  assert.match(switched, /rel="canonical" href="https:\/\/wirkungsoekonomie\.de\/wirkungsticker\/archiv-meldung\/"/);
  const main = html => html.match(/<main\b[\s\S]+?<\/main>/)?.[0];
  assert.ok(main(legacy));
  assert.equal(main(switched), main(legacy));

  const registry = { updated_at: '2026-11-24T12:00:00Z', sources: [{
    source_id: 'fixture', name: 'Beispielquelle', url: 'https://example.org', role: 'C',
    enabled: false, access: { status: 'public' },
  }] };
  const pages = new Map();
  buildSourcePages(registry, {}, {
    root: '/virtual', site: 'https://wirkungsoekonomie.de', sdgActive: true,
    write: (file, html) => pages.set(file, html), escapeHtml: String, formatDate: String,
    pageShell: ({ canonical, sdgActive, body }) => appNavigation(canonical, { sdgActive }) + body,
  });
  assert.deepEqual([...pages.keys()], [
    '/virtual/wirkungsticker/quellen/index.html', '/virtual/wirkungsticker/quellen/fixture/index.html',
  ]);
  for (const html of pages.values()) {
    assert.match(html, /href="\/wirkungsticker\/sdg\//);
    assert.match(html, /class="ticker-app-search" href="\/suche\.html\?bereich=SDG-Tracker"/);
  }
});
