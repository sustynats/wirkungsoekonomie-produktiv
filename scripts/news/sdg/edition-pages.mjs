import path from 'node:path';
import { safeUrl } from '../bridge/contract.mjs';
import { impactTimeLabel, MAGNITUDE } from '../impact-assessment.mjs';
import { LAGEN, lageWindow } from '../lage.mjs';
import { berlinParts } from '../lib.mjs';
import { formatReferenceFramework } from '../reference-frameworks.mjs';
import { readSdgReleaseCatalog, SDG_HASH } from './release-catalog.mjs';
import { SDG_TRACKER_EVIDENCE, SDG_TRACKER_TITLE } from './presentation.mjs';
import { renderRssFeed, RSS_SITE, SDG_JSON_FEED_PATH, SDG_RSS_CHANNEL } from '../rss-channels.mjs';

const ROUTE = 'wirkungsticker/sdg/';
const MEASURE_ROUTE = `${ROUTE}massnahme/`;
const slotTitles = { morgenlage: 'SDG-Morgenupdate', mittagslage: 'SDG-Mittagsupdate', abendlage: 'SDG-Abendupdate' };
const dimensions = { human: 'Mensch', planet: 'Planet', democracy: 'Demokratie' };
const formatDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const formatCalendarDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium' });
const domains = {
  legal: ['Rechtsstand', { proposed: 'vorgeschlagen', adopted: 'beschlossen', in_force: 'in Kraft', repealed: 'aufgehoben' }],
  implementation: ['Umsetzung', { announced: 'angekündigt', started: 'begonnen', implemented: 'umgesetzt', suspended: 'ausgesetzt' }],
  finance: ['Finanzierung', { pledged: 'zugesagt', approved: 'bewilligt', committed: 'gebunden', disbursed: 'ausgezahlt', spent: 'verausgabt' }],
  observations: ['Beobachtung', { reported: 'gemeldet', observed: 'beobachtet' }],
};
const dateLabel = value => value && Number.isFinite(Date.parse(value)) ? formatCalendarDate.format(new Date(value)) : null;
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function lateEventDate(eventAt, previousSlotAt) {
  const timestamp = Date.parse(eventAt ?? '');
  if (!previousSlotAt || !Number.isFinite(timestamp)) return null;
  const calendarOnly = calendarDatePattern.test(eventAt);
  if (new Date(timestamp).toISOString() !== (calendarOnly ? `${eventAt}T00:00:00.000Z` : eventAt)) return null;
  // Compare to the prior scheduled Berlin slot even if it never ran. A civil
  // date on the cutoff day gives no hour, and the slot gives no delivery time.
  const earlier = calendarOnly
    ? eventAt < berlinParts(new Date(previousSlotAt)).isoDate
    : timestamp < Date.parse(previousSlotAt);
  return earlier ? dateLabel(eventAt) : null;
}

function loadCatalog({ releases }) {
  return releases.map(({ manifest, sha256 }) => {
    if (!SDG_HASH.test(sha256 ?? '')) throw Error('SDG_RELEASE_PACKAGE_MISMATCH');
    const rows = new Set();
    for (const item of manifest.items) {
      if (!SDG_HASH.test(item.revision_id ?? '') || rows.has(item.revision_id) ||
          typeof item.title !== 'string' || typeof item.summary !== 'string' || !item.title.trim() || !item.summary.trim() ||
          !Array.isArray(item.sources) || !item.sources.length ||
          !Object.hasOwn(domains, item.domain) || !Object.hasOwn(domains[item.domain][1], item.stage) ||
          !Object.keys(dimensions).every(key => typeof item.impact?.[key]?.label === 'string')) {
        throw Error('SDG_RELEASE_ITEM_INVALID');
      }
      rows.add(item.revision_id);
      item.sources.forEach(source => safeUrl(source.url));
    }
    return { ...manifest, sha256 };
  }).sort((left, right) => right.scheduled_at.localeCompare(left.scheduled_at));
}

export function sdgEditionTitle(edition) {
  const slot = LAGEN.find(item => edition.edition_id.endsWith(item.slot));
  return `${slotTitles[slot.slot]} · ${formatDate.format(new Date(edition.scheduled_at))}`;
}

function writeEditionFeeds(root, editions, write) {
  const items = editions.map(edition => {
    const count = edition.items.length;
    return {
      url: `${RSS_SITE}/${ROUTE}ausgabe/${edition.edition_id}/`,
      title: sdgEditionTitle(edition),
      summary: count === 0 ? 'Für diese Ausgabe liegen keine geprüften Einträge vor.'
        : count === 1 ? '1 geprüfter Eintrag in dieser Ausgabe.' : `${count} geprüfte Einträge in dieser Ausgabe.`,
      _woek_edition: { scheduled_at: edition.scheduled_at, cutoff_at: edition.cutoff_at, sealed_at: edition.sealed_at,
        checked_items: count },
    };
  });
  write(path.join(root, SDG_RSS_CHANNEL.path.slice(1)), renderRssFeed(items, SDG_RSS_CHANNEL, { withBuildDate: false }));
  write(path.join(root, SDG_JSON_FEED_PATH.slice(1)), JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: SDG_RSS_CHANNEL.title,
    description: SDG_RSS_CHANNEL.description,
    home_page_url: `${RSS_SITE}${SDG_RSS_CHANNEL.home}`,
    feed_url: `${RSS_SITE}${SDG_JSON_FEED_PATH}`,
    language: 'de-DE',
    items: items.map(({ url, title, summary, _woek_edition }) =>
      ({ id: url, url, title, content_text: summary, _woek_edition })),
  }, null, 2));
}

function renderItem(item, link, lateDate, esc) {
  const [domain, statuses] = domains[item.domain];
  const eventDate = dateLabel(item.event_at);
  const discoveryDate = dateLabel(item.discovered_at);
  const sources = item.sources.map(source => {
    const originalDate = dateLabel(source.source_published_at);
    return `<li><a href="${esc(safeUrl(source.url))}">${esc(source.title || source.publisher || new URL(source.url).hostname)}</a>${originalDate ? ` · Original vom ${esc(originalDate)}` : ''}</li>`;
  }).join('');
  const references = (item.reference_frameworks ?? []).map(reference => `<li>${esc(formatReferenceFramework(reference))}</li>`).join('');
  const impact = Object.entries(dimensions).map(([key, label]) => {
    const part = item.impact[key];
    const details = [];
    if (part.temporal_status) details.push(impactTimeLabel(part.temporal_status));
    if (Number.isInteger(part.magnitude) && MAGNITUDE[part.magnitude]) {
      details.push(`Tragweite ${MAGNITUDE[part.magnitude]}`);
    }
    if (part.evidence_label) details.push(`Evidenz ${part.evidence_label}`);
    return `<dt>${label}</dt><dd>${esc([part.label, ...details].join(' · '))}</dd>`;
  }).join('');
  return `
<article id="sdg-${esc(item.revision_id)}" class="news-story-section">
  <h2>${esc(item.title)}</h2>
  ${lateDate ? `<p class="news-method-note">Nachgereicht - Ereignis vom ${esc(lateDate)}</p>` : ''}
  <p>${esc(item.summary)}</p>
  <dl><dt>${domain}</dt><dd>${statuses[item.stage]}</dd><dt>Ereignisdatum</dt><dd>${eventDate ? esc(eventDate) : 'Offen'}</dd>${discoveryDate ? `<dt>Erfasst am</dt><dd>${esc(discoveryDate)}</dd>` : ''}</dl>
  ${references ? `<h3>Referenzrahmen</h3><ul>${references}</ul>` : ''}
  <h3>Wirkungsökonomische Analyse (MPD)</h3><dl>${impact}</dl>
  <h3>Quellen</h3><ul>${sources}</ul>
  ${link}
</article>`;
}

function eventTime(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export function buildSdgEditionPages({ root, site, pageShell, write, escapeHtml: esc, catalog, includeFeeds = false }) {
  const editions = loadCatalog(catalog ?? readSdgReleaseCatalog(root));
  if (editions.length === 0) return [];
  const routes = [];
  const tracker = SDG_TRACKER_TITLE;
  const page = (route, title, heading, description, body, base, editionHash) => {
    const canonical = `${site}/${route}`;
    const editionBinding = editionHash ? ` data-sdg-edition-sha256="${esc(editionHash)}"` : '';
    write(path.join(root, route, 'index.html'), pageShell({
      title, description, canonical, base,
      body: `<main id="main-content" data-search-content class="ticker-app-main"${editionBinding}><header class="ticker-app-title"><h1>${esc(heading)}</h1></header>${body}</main>`,
      jsonLd: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: canonical },
    }));
    routes.push(route);
  };
  const cases = new Map();
  for (const edition of editions) {
    const editionRoute = `${ROUTE}ausgabe/${edition.edition_id}/`;
    const previousSlotAt = lageWindow(edition.edition_id.slice(11), edition.scheduled_at)?.from;
    const items = edition.items.map(item => {
      const lateDate = lateEventDate(item.event_at, previousSlotAt);
      if (typeof item.case_id !== 'string' || !SDG_HASH.test(item.case_id)) return renderItem(item, '', lateDate, esc);
      if (!cases.has(item.case_id)) cases.set(item.case_id, []);
      cases.get(item.case_id).push({ item, edition, editionRoute, lateDate });
      const link = `<p><a href="/${MEASURE_ROUTE}${item.case_id}/#sdg-${item.revision_id}">Maßnahmenakte ansehen</a></p>`;
      return renderItem(item, link, lateDate, esc);
    }).join('\n');
    const cutoff = formatDate.format(new Date(edition.cutoff_at));
    const title = sdgEditionTitle(edition);
    page(editionRoute, `${title} | ${tracker}`, title,
      'Geprüfte Beschlüsse, Programme und Umsetzungsstände zu den UN-Nachhaltigkeitszielen mit Quellen und Wirkungseinordnung.',
      `<p><a href="/${ROUTE}">Alle SDG-Ausgaben</a></p><p>Prüfschluss ${esc(cutoff)} Uhr (Berlin)</p>${items || '<p>Für diese Ausgabe liegen keine geprüften Einträge vor.</p>'}`,
      '../../../../', edition.sha256);
  }
  for (const [caseId, versions] of cases) {
    const byRevision = new Map(versions.map(version => [version.item.revision_id, version.item]));
    if (byRevision.size !== versions.length) throw Error('SDG_RELEASE_DUPLICATE_CASE_REVISION');
    const previousVersion = item => {
      const previous = byRevision.get(item.supersedes);
      return previous && item.event_id && previous.revision_id !== item.revision_id && previous.event_id === item.event_id
        ? previous : null;
    };
    const superseded = new Set(versions.map(({ item }) => previousVersion(item)?.revision_id));
    const [latest] = versions.filter(({ item }) => !superseded.has(item.revision_id))
      .toSorted((left, right) => right.edition.scheduled_at.localeCompare(left.edition.scheduled_at)
        || String(right.item.discovered_at ?? '').localeCompare(String(left.item.discovered_at ?? '')));
    if (!latest) throw Error('SDG_RELEASE_CASE_HEAD_MISSING');
    const chronological = versions.toSorted((left, right) =>
      eventTime(left.item.event_at) - eventTime(right.item.event_at)
      || left.edition.scheduled_at.localeCompare(right.edition.scheduled_at));
    const history = chronological.map(({ item, edition, editionRoute, lateDate }) => {
      const previous = previousVersion(item);
      const correction = previous ? ` · <a href="#sdg-${previous.revision_id}">Frühere Fassung</a>` : '';
      const link = `<p>In Ausgabe <a href="/${editionRoute}#sdg-${item.revision_id}">${esc(sdgEditionTitle(edition))}</a>${correction}</p>`;
      return renderItem(item, link, lateDate, esc);
    }).join('\n');
    const { title, summary } = latest.item;
    page(`${MEASURE_ROUTE}${caseId}/`, `${title} – Maßnahmenakte | ${tracker}`, title,
      summary, `<p><a href="/${ROUTE}">Alle SDG-Ausgaben</a></p><p>Die Chronologie folgt dem Ereignisdatum. Einträge mit offenem Datum stehen am Ende.</p><section aria-label="Chronologie der Maßnahme">${history}</section>`, '../../../../');
  }
  page(ROUTE, `SDG-Ausgaben | ${tracker}`, 'SDG-Ausgaben des Global SDG Impact Trackers',
    'Die Ausgaben des Wirkungstickers verfolgen Maßnahmen und belegte Veränderungen zu den UN-Nachhaltigkeitszielen.',
    `<p>${esc(SDG_TRACKER_EVIDENCE)}</p><p><a href="/wirkungsticker/">Zum Wirkungsticker</a> · <a href="/wirkungsticker/methodik/">Zur Methodik</a></p>${includeFeeds ? `<p><a href="${SDG_RSS_CHANNEL.path}">${esc(SDG_RSS_CHANNEL.label)}</a> · <a href="${SDG_JSON_FEED_PATH}">JSON-Feed für SDG-Ausgaben</a></p>` : ''}<ol class="ticker-lagen-liste">${editions.map(edition =>
      `<li><a href="/${ROUTE}ausgabe/${edition.edition_id}/">${esc(sdgEditionTitle(edition))}</a> · ${edition.items.length} geprüft</li>`).join('')}</ol>`, '../../');
  if (includeFeeds) writeEditionFeeds(root, editions, write);
  return routes;
}
