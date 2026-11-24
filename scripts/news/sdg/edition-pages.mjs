import path from 'node:path';
import { safeUrl } from '../bridge/contract.mjs';
import { LAGEN } from '../lage.mjs';
import { readSdgReleaseCatalog, SDG_HASH } from './release-catalog.mjs';
import { SDG_TRACKER_EVIDENCE, SDG_TRACKER_TITLE } from './presentation.mjs';

const ROUTE = 'wirkungsticker/sdg/';
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

export function buildSdgEditionPages({ root, site, pageShell, write, escapeHtml: esc, catalog }) {
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
  for (const edition of editions) {
    const items = edition.items.map(item => {
      const [domain, labels] = domains[item.domain];
      const eventDate = dateLabel(item.event_at);
      const discoveryDate = dateLabel(item.discovered_at);
      return `
<article id="sdg-${esc(item.revision_id)}" class="news-story-section">
  <h2>${esc(item.title)}</h2>
  <p>${esc(item.summary)}</p>
  <dl><dt>${domain}</dt><dd>${labels[item.stage]}</dd>${eventDate ? `<dt>Ereignisdatum</dt><dd>${esc(eventDate)}</dd>` : ''}${discoveryDate ? `<dt>Erfasst am</dt><dd>${esc(discoveryDate)}</dd>` : ''}</dl>
  <dl>${Object.entries(dimensions).map(([key, label]) => `<dt>${label}</dt><dd>${esc(item.impact[key].label)}</dd>`).join('')}</dl>
  <h3>Quellen</h3><ul>${item.sources.map(source => {
    const originalDate = dateLabel(source.source_published_at);
    return `<li><a href="${esc(safeUrl(source.url))}">${esc(source.title || source.publisher || new URL(source.url).hostname)}</a>${originalDate ? ` · Original vom ${esc(originalDate)}` : ''}</li>`;
  }).join('')}</ul>
</article>`;
    }).join('\n');
    const cutoff = formatDate.format(new Date(edition.cutoff_at));
    const title = sdgEditionTitle(edition);
    page(`${ROUTE}ausgabe/${edition.edition_id}/`, `${title} | ${tracker}`, title,
      'Geprüfte Beschlüsse, Programme und Umsetzungsstände zu den UN-Nachhaltigkeitszielen mit Quellen und Wirkungseinordnung.',
      `<p><a href="/${ROUTE}">Alle SDG-Ausgaben</a></p><p>Prüfschluss ${esc(cutoff)} Uhr (Berlin)</p>${items || '<p>Für diese Ausgabe liegen keine geprüften Einträge vor.</p>'}`,
      '../../../../', edition.sha256);
  }
  page(ROUTE, `SDG-Ausgaben | ${tracker}`, 'SDG-Ausgaben des Global SDG Impact Trackers',
    'Die Ausgaben des Wirkungstickers verfolgen Maßnahmen und belegte Veränderungen zu den UN-Nachhaltigkeitszielen.',
    `<p>${esc(SDG_TRACKER_EVIDENCE)}</p><p><a href="/wirkungsticker/">Zum Wirkungsticker</a> · <a href="/wirkungsticker/methodik/">Zur Methodik</a></p><ol class="ticker-lagen-liste">${editions.map(edition =>
      `<li><a href="/${ROUTE}ausgabe/${edition.edition_id}/">${esc(sdgEditionTitle(edition))}</a> · ${edition.items.length} geprüft</li>`).join('')}</ol>`, '../../');
  return routes;
}
