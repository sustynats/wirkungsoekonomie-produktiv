import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'content/editorial/wissenschaftliche-einordnung.json'), 'utf8'));
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const archive = (code, title) => `<a href="/quellenarchiv/wok-q-${code}/">${esc(title)}</a>`;
const target = '/wirkungswissenschaften/wirkungsoekonomie/#wissenschaftliche-einordnung';
export function renderEinordnung({full = false, historical = false} = {}) {
  if (historical) return `<aside class="section card" aria-label="Datierter redaktioneller Standhinweis"><p>${esc(data.historical_notice)}</p><p><a href="${target}">Zur aktuellen wissenschaftlichen Einordnung</a></p></aside>`;
  if (!full) return `<section class="section" id="wissenschaftliche-einordnung"><div class="section-header"><p class="hero-kicker">Wissenschaftliche Einordnung · 10.11.2026</p><h2>${esc(data.title)}</h2><p>${esc(data.compact)}</p><p><a href="${target}">Einordnung, Begriffe und externe Anschlussquellen</a></p></div></section>`;
  return `<section class="section" id="wissenschaftliche-einordnung"><div class="section-header"><p class="hero-kicker">Wissenschaftliche Einordnung · 10.11.2026</p><h2>${esc(data.title)}</h2><p>${esc(data.definition)}</p><p>${esc(data.science)}</p></div><div class="card-grid two">${data.hierarchy.map(x=>`<article class="card"><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></article>`).join('')}</div><div class="section-header"><h3>SGMM: eigenständige externe Tradition</h3><p>${esc(data.sgmm)}</p><p>${esc(data.public_value)}</p><p>Quellen: ${archive('9051','HSG: Aufgaben- und Praxisperspektive')}; ${archive('9052','Rüegg-Stürm / Grand: Publikationen')}; ${archive('9053','SGMM 5.0: Arbeitspapier 2026')}; ${archive('9054','Schwaninger: Entwicklung der systemischen Managementlehre')}; ${archive('9055','Meynhardt / Jasinenko: Public-Value-Skala')}; ${archive('9056','Meynhardt: Public Value in Public Management')}.</p><h3>Was als Nachweis gilt</h3><p>${esc(data.limits)}</p><p>Fachgrundlagen: <a href="/bibliothek/woek-begriffsleitfaden-fuehrend/">Begriffsleitfaden v1.8</a>, <a href="/bibliothek/eintraege/woemm-2-0/">WÖMM 2.0</a>, <a href="/bibliothek/eintraege/woems-2-0/">WÖMS 2.0</a>. Die Originaleditionen bleiben erhalten.</p></div></section>`;
}

export function updateEinordnungPages() {
  const pages = ['index.html','verstehen/index.html','methodik/index.html','methodenraum.html','bibliothek/index.html','referenz/aktualisierung/index.html'];
  const historical = ['blog/wirkungswissenschaften-wirkungsforschung-wirkungsoekonomie.html','dokumente/dossier-wirkungswissenschaften-wirkungsforschung-wirkungsoekonomie/index.html'];
  const start = '<!-- wissenschaftliche-einordnung-20261110:start -->';
  const end = '<!-- wissenschaftliche-einordnung-20261110:end -->';
  for (const rel of [...pages, ...historical]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) throw new Error(`Einordnungsziel fehlt: ${rel}`);
    let html = fs.readFileSync(file, 'utf8');
    const content = `${start}\n${renderEinordnung({historical:historical.includes(rel)})}\n${end}`;
    const isHistorical = historical.includes(rel);
    if (isHistorical && html.indexOf(start) > html.indexOf('<main') && html.includes(start)) {
      // Undo only the newline and marked context block inserted by this renderer.
      // The historical <main> remains byte-identical for its frozen PDF source hash.
      html = html.replace(new RegExp(`\n${start}[\\s\\S]*?${end}`), '');
    }
    if (html.includes(start)) html = html.replace(new RegExp(`${start}[\\s\\S]*?${end}`), content);
    else html = html.replace(isHistorical ? /(<main\b[^>]*>)/ : /(?=<\/main>)/, match => isHistorical ? `${content}\n${match}` : content);
    if (!html.includes(content)) throw new Error(`Einordnung nicht eingesetzt: ${rel}`);
    fs.writeFileSync(file, html);
  }
  console.log(`Einordnung: ${pages.length} dynamische Einstiege, ${historical.length} datierte Standhinweise`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) updateEinordnungPages();
