import fs from 'node:fs';
import path from 'node:path';
import { renderSiteFooter, renderSiteHeader } from '../lib/site-shell.mjs';

const site = 'https://wirkungsoekonomie.de';
const langKeys = ['de', 'en'];
const roots = { de: '/verstehen/sdgs-sdgplus/', en: '/en/sdg-plus/' };
const dataRoot = '/api/v1/sdg-plus/';
const assetRoot = '/assets/sdgplus/v1/';
const matrixStates = { bezug: 'reviewed', offen: 'open', kein_begruendeter_bezug: 'no' };
const symbols = { bezug: '●', offen: '?', kein_begruendeter_bezug: '○' };
const legacyMap = [
  ['sdgplus-demokratie', 'Demokratie', ['demokratie']],
  ['sdgplus-medienqualitaet', 'Medienqualität', ['medien', 'technologie']],
  ['sdgplus-rechtsstaatlichkeit', 'Rechtsstaatlichkeit', ['rechtsstaat']],
  ['sdgplus-diskursfaehigkeit', 'Diskursfähigkeit', ['diskurs']],
  ['sdgplus-institutionelles-vertrauen', 'Institutionelles Vertrauen', ['demokratie', 'rechtsstaat', 'transparenz']],
  ['sdgplus-gesellschaftlicher-zusammenhalt', 'Gesellschaftlicher Zusammenhalt', ['resilienz', 'vielfalt', 'diskurs']],
  ['sdgplus-digitale-selbstbestimmung', 'Digitale Selbstbestimmung', ['technologie']],
];

const escape = text => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const link = (url, label, attrs = '') => `<a href="${escape(url)}"${attrs}>${escape(label)}</a>`;
const list = items => `<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>`;
const sources = items => list(items.map(item => link(item.url, item.label)));
const titleFor = (goal, lang) => `SDG+ ${goal.number} - ${goal[lang].title}`;
const detail = (lang, id) => lang === 'de' ? `${roots.de}ziele/${id}/` : `${roots.en}goals/${id}/`;
const glossary = (lang, id) => lang === 'de' ? `/begriffe/sdgplus-${id}/` : `${roots.en}glossary/${id}/`;
const json = data => JSON.stringify(data, null, 2) + '\n';

function write(root, url, contents) {
  const file = path.join(root, url, url.endsWith('/') ? 'index.html' : '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== contents) fs.writeFileSync(file, contents);
}

export function loadSdgPlus(root) {
  const input = JSON.parse(fs.readFileSync(path.join(root, 'content/sdgplus/v1/public-content.json'), 'utf8'));
  if (input.reference.version !== '1.0' || input.reference.status !== 'FACHLICH_FREIGEGEBEN') {
    throw new Error('Version 1.0 benötigt die dokumentierte fachliche Freigabe.');
  }
  const manifestPath = path.join(root, 'content/sdgplus/v1/downloads.json');
  const downloads = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];
  return { ...input, downloads };
}

function navigation(lang, otherUrl, locale) {
  const otherLang = lang === 'de' ? 'en' : 'de';
  return `<nav class="sdgplus-nav" aria-label="SDG+">
${link(roots[lang] + '#sdgplus', 'SDG+')}
${link(roots[lang] + 'glossary/', locale.glossary)}
${link(roots[lang] + 'matrix/', locale.matrix)}
${link(roots[lang] + 'toolkit/', locale.toolkit)}
${link(otherUrl, lang === 'de' ? 'English' : 'Deutsch', ` lang="${otherLang}" hreflang="${otherLang}"`)}
</nav>`;
}

export function renderSdgPlusOverview(input, lang = 'de') {
  const { reference, locale: locales } = input;
  const l = locales[lang];
  const cards = reference.goals.map(goal => {
    const label = titleFor(goal, lang);
    return `<article class="sdgplus-card" data-sdgplus-number="${goal.number}">
<img src="${assetRoot}${lang}/${escape(goal.id)}.svg" width="430" height="185" alt="" loading="lazy">
<h3>${link(detail(lang, goal.id), label)}</h3>
<p>${escape(goal[lang].summary)}</p><p>${escape(goal[lang].why)}</p></article>`;
  }).join('\n');
  const idText = lang === 'de' ? 'MasterItems-Register' : 'MasterItems registry';
  const indicatorText = lang === 'de' ? 'Wirkindikatorenregister' : 'Impact indicator registry';
  const relationshipHeading = lang === 'de' ? 'Neun SDG+-Ziele' : 'Nine SDG+ goals';
  return `<section id="sdgplus" class="section sdgplus-v1" data-sdgplus-reference="${escape(reference.version)}" aria-labelledby="why-sdgplus">
<div class="section-header"><h2 id="why-sdgplus">${escape(l.title)}</h2><p class="sdgplus-status">${escape(l.status)}</p>
<p class="sdgplus-lead">${escape(l.definition)}</p><p>${escape(l.intro)}</p></div>
${navigation(lang, roots[lang === 'de' ? 'en' : 'de'], l)}
<h3>${escape(l.whyTitle)}</h3><p class="sdgplus-narrow">${escape(l.why)}</p>
<h2 id="sdgplus-detail">${relationshipHeading}</h2><p>${escape(l.number)}</p>
<div class="sdgplus-cards">${cards}</div>
<h2>${escape(l.links)}</h2><div class="sdgplus-cards">${l.connections.map(item => `<p class="sdgplus-card">${escape(item)}</p>`).join('')}</div>
<p>${link(roots[lang] + 'matrix/', l.matrix)}</p>
<div class="sdgplus-narrow"><h2>${escape(l.measure)}</h2><p>${escape(l.method)}</p><p>${escape(l.protect)}</p>
${list([link(reference.registerSource.publicUrl, idText), link('https://parlament.wirkungsoekonomie.de/pruefstandard/wirkindikatoren/', indicatorText), link('/werkzeuge/scorecards/', 'Scorecards')])}
<h2>${escape(l.toolkit)}</h2><p>${link(roots[lang] + 'toolkit/', l.toolkit)}</p>
<h2>${escape(l.sources)}</h2>${sources(reference.sources)}</div></section>`;
}

export function renderSdgPlusLegacy(input) {
  const byId = new Map(input.reference.goals.map(goal => [goal.id, goal]));
  return `<section class="section sdgplus-v1" aria-labelledby="sdgplus-archive">
<h2 id="sdgplus-archive">Frühere Web-Gliederung und historische Quellen</h2>
<p>Die frühere Website beschrieb sieben Dimensionen. Die folgenden Zuordnungen erhalten ihre fachlichen Teilaspekte und bisherigen Links. Mehrere Bezüge bilden unterschiedliche Prüffragen ab.</p>
${legacyMap.map(([id, label, targetIds]) => `<section id="${id}" data-sdgplus-legacy><h3>${label}</h3>
<p>${targetIds.map(targetId => link(detail('de', targetId), titleFor(byId.get(targetId), 'de'))).join(' · ')}</p></section>`).join('\n')}
<p id="sdgplus-publications">${link('/bibliothek/sdgs-sdgplus-risiko-resilienzregister-systemresilienz/', 'Risiko- und Resilienzdossier v0.1, historische Arbeitsfassung')}</p>
<section id="sdgplus-dossier"><h3>Früheres SDG+-Detailkonzept</h3><p id="sdgplus-download">${link('/verstehen/sdgs-sdgplus/sdgplus/', 'Historische Onlinefassung')}</p></section>
</section>`;
}

function openPage(root, lang, title, description, url, alternative, content) {
  const base = '../'.repeat(url.split('/').filter(Boolean).length);
  const english = lang === 'en';
  const header = renderSiteHeader(base, 'de');
  const alternates = english ? { de: alternative, en: url } : { de: url, en: alternative };
  write(root, url, `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} | Wirkungsökonomie</title>
<meta name="description" content="${escape(description)}">
<meta name="search_title" content="${escape(title)}"><meta name="search_description" content="${escape(description)}">
<meta name="search_section" content="${english ? 'Understand' : 'Verstehen'}"><meta name="search_type" content="${english ? 'Reference' : 'Referenz'}">
<link rel="canonical" href="${site}${url}">
${langKeys.map(key => `<link rel="alternate" hreflang="${key}" href="${site}${alternates[key]}">`).join('\n')}
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${site}${url}">
<link rel="icon" href="${base}assets/img/brand/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}assets/css/style.css"><link rel="stylesheet" href="${base}assets/css/sdgplus-reference.css">
</head><body>${header}<main class="sdgplus-v1 sdgplus-page">${content}</main>
${renderSiteFooter(base)}<script src="${base}assets/js/main.js" defer></script></body></html>
`);
}

function statusFor(locale, state) {
  return locale[matrixStates[state]];
}

function matrixMarkup(input, lang) {
  const locale = input.locale[lang];
  const goals = input.reference.goals;
  const goalMap = new Map(goals.map(goal => [goal.id, goal]));
  const targetRows = Array.isArray(input.matrix) ? input.matrix : input.matrix.pairs;
  const byPair = new Map(targetRows.map(pair => [`${pair.sdg}:${pair.goal}`, pair]));
  const names = input.sdgs[lang];
  const statuses = Object.keys(matrixStates);
  const pairAnchor = pair => `un-${pair.sdg}-${pair.goal}`;
  const legend = statuses.map(state => `${symbols[state]} ${statusFor(locale, state)}`).join(' · ');
  const grid = names.map((name, index) => `<tr><th scope="row">${index + 1} ${escape(name)}</th>${goals.map(goal => {
    const pair = byPair.get(`${index + 1}:${goal.id}`);
    const text = `SDG ${pair.sdg} / ${titleFor(goal, lang)}: ${statusFor(locale, pair.status)}`;
    return `<td>${link('#' + pairAnchor(pair), symbols[pair.status], ` data-matrix-jump aria-label="${escape(text)}"`)}</td>`;
  }).join('')}</tr>`).join('');
  const options = [
    ['sdg', locale.sdg, names.map((name, index) => [index + 1, `${index + 1} · ${name}`])],
    ['goal', locale.plus, goals.map(goal => [goal.id, titleFor(goal, lang)])],
    ['status', locale.statusLabel, statuses.map(state => [state, statusFor(locale, state)])],
  ];
  const controls = options.map(([key, label, choices]) => `<label>${escape(label)}
<select data-matrix-filter="${key}" disabled><option value="">${escape(locale.all)}</option>
${choices.map(([value, name]) => `<option value="${escape(value)}">${escape(name)}</option>`).join('')}</select></label>`).join('');
  const explanatory = [
    ['targets', 'UN-Unterziele', 'UN targets'], ['indicators', 'UN-Indikatoren', 'UN indicators'],
    ['indicator_scope', 'Reichweite der Indikatoren', 'Indicator scope'], ['direction', 'Richtung', 'Direction'],
    ['conditions', 'Bedingungen', 'Conditions'], ['woek', 'WÖk-Bezug', 'WÖk connection'], ['evidence', 'Evidenz', 'Evidence'],
  ];
  const rows = targetRows.map(pair => {
    const summary = lang === 'de' ? pair.reason : pair.reason_en;
    const relation = lang === 'de' ? pair.relation : pair.relation_en;
    const notes = explanatory.flatMap(([key, de, en]) => {
      const translated = pair[`${key}_en`];
      const val = lang === 'en' && translated ? translated : pair[key];
      if (!val || (Array.isArray(val) && val.length === 0)) return [];
      const fallback = lang === 'en' && typeof val === 'string' && !translated ? ' lang="de"' : '';
      return [`<strong>${lang === 'de' ? de : en}</strong> <span${fallback}>${escape(Array.isArray(val) ? val.join(', ') : val)}</span>`];
    });
    const info = notes.length || pair.sources.length
      ? `<details><summary>${escape(locale.notes)}</summary>${list(notes)}${pair.sources.length ? sources(pair.sources) : ''}</details>` : '';
    return `<tr id="${pairAnchor(pair)}" tabindex="-1" role="row" data-pair data-sdg="${pair.sdg}" data-goal="${escape(pair.goal)}" data-status="${escape(pair.status)}">
<th scope="row" role="rowheader">SDG ${pair.sdg} · ${escape(names[pair.sdg - 1])}</th>
<td role="cell">${link(detail(lang, pair.goal), titleFor(goalMap.get(pair.goal), lang))}</td>
<td role="cell">${escape(statusFor(locale, pair.status))}</td><td role="cell"><strong>${escape(relation)}</strong><p>${escape(summary)}</p>${info}</td></tr>`;
  }).join('');
  return `<p class="sdgplus-lead sdgplus-narrow">${escape(locale.matrixIntro)}</p>
<details class="sdgplus-grid"><summary>${lang === 'de' ? 'Rasteransicht und Legende' : 'Grid and legend'}</summary>
<p>${escape(legend)}</p><div class="sdgplus-tray"><table><thead><tr><th scope="col">SDG / SDG+</th>
${goals.map(goal => `<th scope="col" title="${escape(goal[lang].title)}">+${goal.number}</th>`).join('')}</tr></thead><tbody>${grid}</tbody></table></div></details>
<div class="sdgplus-toolbar">${controls}<output id="matrix-count" aria-live="polite" aria-label="${escape(locale.matrix)}">${targetRows.length} / ${targetRows.length}</output></div>
<div class="sdgplus-tray"><table class="sdgplus-matrix" role="table"><thead role="rowgroup"><tr role="row">
${[locale.sdg, locale.plus, locale.statusLabel, locale.notes].map(name => `<th scope="col" role="columnheader">${escape(name)}</th>`).join('')}</tr></thead>
<tbody role="rowgroup">${rows}</tbody></table></div><script src="/assets/js/sdgplus-matrix.js" defer></script>`;
}

function fileLinks(input, lang) {
  const l = input.locale[lang];
  const apiLinks = new Set(['guide', 'matrix-csv', 'matrix-json', 'reference-json']);
  const listItems = input.downloads.filter(file => file.language === lang && !apiLinks.has(file.kind))
    .map(file => link(file.url, file.title));
  return list([
    ...listItems,
    link(dataRoot + 'matrix-v1.csv', l.matrix + ' (CSV)'),
    link(dataRoot + 'matrix-v1.json', l.matrix + ' (JSON)'),
    link(dataRoot + 'reference-v1.json', 'SDG+ (JSON)'),
  ]);
}

function csvText(rows) {
  const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + fields.join(',') + '\r\n' + rows.map(row => fields.map(field => cell(row[field])).join(',')).join('\r\n') + '\r\n';
}

export function publishSdgPlus(root, input) {
  const { reference, locale, content } = input;
  const publicReference = {
    ...reference,
    goals: reference.goals.map(goal => {
      const pub = { ...goal };
      for (const lang of langKeys) {
        const { readMoreSource: _source, ...terms } = goal[lang];
        pub[lang] = {
          ...terms, detail: detail(lang, goal.id), glossary: glossary(lang, goal.id),
          asset: `${assetRoot}${lang}/${goal.id}.svg`,
        };
      }
      return pub;
    }),
  };
  const pairs = Array.isArray(input.matrix) ? input.matrix : input.matrix.pairs;
  const publicMatrix = {
    version: reference.version, date: reference.date, status: reference.status,
    effectiveFrom: reference.effectiveFrom, currentReferenceUrl: reference.currentReferenceUrl,
    approval: reference.approval, pairs,
  };
  write(root, dataRoot + 'reference-v1.json', json(publicReference));
  write(root, dataRoot + 'matrix-v1.json', json(publicMatrix));
  write(root, dataRoot + 'matrix-v1.csv', csvText(pairs));

  const routes = [];
  const addendum = fs.readFileSync(path.join(root, 'content/sdgplus/v1/leitfaden/addendum.inc'), 'utf8')
    .replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, '');
  const guideRoute = '/bibliothek/woek-begriffsleitfaden-fuehrend-v1-9/';
  const guideDownloads = input.downloads.filter(file => file.kind === 'guide')
    .map(file => link(file.url, file.title));
  const oldGuideFile = path.join(root, 'content/documents/online/woek-begriffsleitfaden-fuehrend.inc');
  const oldGuide = fs.readFileSync(oldGuideFile, 'utf8');
  if (!oldGuide.includes('id="sdgplus-stand-v19"')) {
    const notice = `<aside id="sdgplus-stand-v19"><p><strong>Standhinweis zu SDG+.</strong> Der folgende Text dokumentiert Ausgabe v1.8. Für § 4.2 gilt seit 26. November 2026 das ${link(guideRoute, 'Addendum des Begriffsleitfadens v1.9')} mit der ${link(roots.de + '#sdgplus', 'öffentlichen SDG+-Referenz v1.0')}.</p></aside>\n`;
    fs.writeFileSync(oldGuideFile, notice + oldGuide);
  }
  const guideTitle = 'Führender Begriffsleitfaden v1.9 - SDG+';
  openPage(root, 'de', guideTitle, 'SDG+-Revision zu § 4.2 vom 26. November 2026.',
    guideRoute, roots.en, `<h1>${guideTitle}</h1>${addendum}${list(guideDownloads)}`);
  routes.push(guideRoute);
  const glossaryMain = '/begriffe/sdg-plus/';
  openPage(root, 'de', 'SDG+', locale.de.definition, glossaryMain, roots.en + 'glossary/',
    `<h1>SDG+</h1><p class="sdgplus-lead">${escape(locale.de.definition)}</p>
<p>${escape(locale.de.intro)}</p>${list(reference.goals.map(goal => link(glossary('de', goal.id), titleFor(goal, 'de'))))}
<p>${link(roots.de + '#sdgplus', 'SDG+-Referenz v1.0')} · ${link(guideRoute, 'Begriffsleitfaden v1.9')}</p>`);
  routes.push(glossaryMain);
  for (const lang of langKeys) {
    const other = lang === 'de' ? 'en' : 'de';
    const l = locale[lang];
    const index = roots[lang];
    const counterpart = roots[other];
    const add = (route, alternate, title, description, body) => {
      routes.push(route);
      openPage(root, lang, title, description, route, alternate,
        `${navigation(lang, alternate, l)}<h1>${escape(title)}</h1><p class="sdgplus-status">${escape(l.status)}</p>${body}`);
    };
    if (lang === 'en') {
      routes.push(index);
      openPage(root, lang, l.title, l.definition, index, counterpart,
        `<h1>${escape(l.title)}</h1>${renderSdgPlusOverview(input, lang)}`);
    }
    add(index + 'matrix/', counterpart + 'matrix/', l.matrix, l.matrixIntro, matrixMarkup(input, lang));
    add(index + 'toolkit/', counterpart + 'toolkit/', l.toolkit, l.definition,
      `${fileLinks(input, lang)}<h2>${escape(l.workshopTitle)}</h2><ol class="sdgplus-narrow">${l.exercise.map(step => `<li>${escape(step)}</li>`).join('')}</ol>
<h2>${escape(l.citation)}</h2><p>Natalie Weber. ${escape(l.title)}. Version ${escape(reference.version)}, ${escape(reference.date)}.
${link(site + index, site + index)}.</p><p class="sdgplus-narrow">${escape(l.rights)}</p>`);
    add(index + 'glossary/', counterpart + 'glossary/', l.glossary + ' SDG+', l.definition,
      `<p>${escape(l.definition)}</p>${list(reference.goals.map(goal => link(glossary(lang, goal.id), titleFor(goal, lang))))}${sources(reference.sources)}`);
    for (const goal of reference.goals) {
      const item = goal[lang];
      const copy = content[lang][goal.id];
      const metaLinks = `<p>${link(glossary(lang, goal.id), l.glossary)} · ${link(index + 'matrix/?goal=' + goal.id, l.matrix)}</p>`;
      add(detail(lang, goal.id), detail(other, goal.id), titleFor(goal, lang), item.summary,
        `<article class="sdgplus-narrow" data-sdgplus-goal="${escape(goal.id)}">
<p class="sdgplus-lead">${escape(item.summary)}</p><p>${escape(item.why)}</p>${metaLinks}
${copy.detailTocHtml}${copy.detailHtml}<h2>${escape(l.sources)}</h2>${sources(reference.sources)}</article>`);
      add(glossary(lang, goal.id), glossary(other, goal.id), titleFor(goal, lang), item.summary,
        `<article class="sdgplus-narrow" data-sdgplus-glossary="${escape(goal.id)}">
<p class="sdgplus-lead">${escape(item.summary)}</p>${copy.longDefinitionHtml}
<h2>${lang === 'de' ? 'Abgrenzung' : 'Scope'}</h2><p>${escape(item.scope)}</p><p>${escape(item.why)}</p>
<p>${link(detail(lang, goal.id), l.goTo)} · ${link(index + 'matrix/?goal=' + goal.id, l.matrix)}</p>
<h2>${escape(l.sources)}</h2>${sources(reference.sources)}</article>`);
    }
  }
  return routes;
}
