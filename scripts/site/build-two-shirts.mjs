import fs from 'node:fs';
import * as scenario from '../../assets/js/woek-product-scenario.js';
import { writeContentPage } from '../lib/content-page.mjs';
import { escapeHtml as esc } from '../lib/explainer-components.mjs';

const data = JSON.parse(fs.readFileSync('content/examples/two-shirts-revision.json', 'utf8'));
const euro = cents => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const number = (value, decimals = 0) => value.toLocaleString('de-DE', { minimumFractionDigits: decimals });
const tariffClasses = [-3, -2, -1, 0, 1, 2, 3];
const classLabel = value => value > 0 ? `+${value}` : String(value);
const stages = data.journey_stages;
const products = data.products.map(product => ({
  ...product,
  base: scenario.basePrice(product, data.vat_rate),
  pass: scenario.createDraftProductPass({
    subject: { type: 'product', id: product.source_id },
    system_boundary: { unit: '1 Kurzarmshirt mit 200 g Baumwollfasern', stages: 'Faser bis Marktbereitstellung', use_and_disposal: 'OFFEN' },
    nace: data.stages.map(stage => ({ activity: stage.name, code: stage.nace, revision: '2.1' })),
    sdg_mapping: ['1.2', '6.3', '8.5', '12.2', '12.5', '13'],
    indicator_evidence: data.measurements.map(m => ({
      indicator: m.key === 'wage_coverage_pct' ? 'WOK-S-101 / R27' : m.title,
      value: product[m.key], unit: m.unit, status: product.data_status, scope: m.scope,
    })).concat({ indicator: 'Abwassergrenzwert', value: null, status: 'OFFEN' }),
    baseline: { prices: 'Verkauf ohne Wirkungssteuer', evidence: 'MODELLIERT' },
    uncertainty: ['Haltbarkeit', 'Grenzwertanwendbarkeit', 'vor- und nachgelagerte Wirkungen'],
    data_quality: 'FIKTIVE_TEILDATEN',
  }, data.source_version),
}));

const tr = (label, values) => `<tr><th scope="row">${esc(label)}</th>${values.map(value => `<td>${esc(value)}</td>`).join('')}</tr>`;
const taxRows = tariffClasses.map(value => tr(classLabel(value), [`${data.working_scale[value]} %`])).join('');
const classOptions = tariffClasses.map(value => `<option value="${value}">${classLabel(value)} · ${data.working_scale[value]} %</option>`).join('');
const creditCases = Object.fromEntries(Object.entries(data.chain.credit).map(([key, shares]) => [
  key, scenario.chainScenario(data.chain.net_cents, data.chain.rate, shares),
]));
const values = {
  reading_time: '3 Minuten für den Überblick',
  baseline_prices: products.map(p => `<figure class="shirt-product shirt-${p.id.toLowerCase()}">
    <img src="/assets/visuals/examples/woek-shirt-${p.id.toLowerCase()}.svg" width="320" height="345" alt="" decoding="async">
    <figcaption><span>Shirt ${p.id}</span><strong>${euro(p.base.gross)}</strong></figcaption>
  </figure>`).join(''),
  material_figures: products.map(p => `<div class="material-line shirt-${p.id.toLowerCase()}">
      <strong>Shirt ${p.id}</strong><div class="material-bar" aria-hidden="true">
      <span style="--share:${p.primary_fibre_g / 2}%"></span><span class="recovered" style="--share:${p.recovered_fibre_g / 2}%"></span></div>
      <p>${p.primary_fibre_g} g Primärbaumwolle · ${p.recovered_fibre_g} g zurückgewonnene Fasern</p>
    </div>`).join(''),
  stage_details: stages.map((s, i) => `<details class="station" id="station-${esc(s.id)}"${i === 0 ? ' open' : ''}>
    <summary><span aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>${esc(s.name)}</summary>
    <div class="detail"><p>${esc(s.process)}</p><dl>
    <div><dt>SDG und SDG+</dt><dd>${esc(s.sdg)}</dd></div>
    <div><dt>Aktivität und NACE</dt><dd>${esc(s.nace)}</dd></div>
    <div><dt>Rohdaten und Nachweis</dt><dd>${esc(s.evidence)}</dd></div>
    <div><dt>Wer liefert und prüft?</dt><dd>${esc(s.owner)}</dd></div>
    <div><dt>Offene Frage</dt><dd>${esc(s.gap)}</dd></div></dl></div>
  </details>`).join(''),
  mapping_rows: stages.map(s => tr(s.name, [s.sdg, s.gap])).join(''),
  measurements: data.measurements.map(m => `<div class="measurement"><h3>${esc(m.title)}</h3>
    <div class="measurement-amounts">${products.map(p => `<span class="shirt-${p.id.toLowerCase()}">${p.id} <strong>${number(p[m.key], m.key === 'emissions_kg' ? 1 : 0)} ${esc(m.unit)}</strong></span>`).join('')}</div>
    <p>${esc(m.scope)} · fiktiv</p></div>`).join(''),
  measurement_rows: data.measurements.map(m => `<tr><th scope="row">${esc(m.title)}</th><td>${esc(m.scope)}</td><td>${esc(m.owner)} · <a href="#s-${esc(m.source)}">${esc(m.source)}</a></td><td>${esc(m.gap)}</td></tr>`).join(''),
  profile_table: [
    tr('Systemgrenze', products.map(p => p.pass.system_boundary.stages)),
    tr('Gegenfaktum und Attribution', products.map(p => `${p.pass.counterfactual} / ${p.pass.attribution}`)),
    tr('Datenqualität', products.map(() => 'Fiktive Teildaten')),
    tr('Harte Schutzgrenzen', products.map(p => p.pass.hard_boundary_status)),
    tr('Reverse Merit Order', products.map(p => p.pass.rmo_result)),
    tr('Produkt-FinalScore', products.map(p => p.pass.final_score_status)),
    tr('Produkt-Tarifklasse', products.map(p => p.pass.tariff_class_status)),
    tr('Gesetzesmodul', products.map(() => 'Kein aktiviertes Modul')),
  ].join('\n'),
  tariff_rows: taxRows,
  class_options: classOptions,
  price_a: euro(products[0].base.gross),
  price_b: euro(products[1].base.gross),
  baseline_nets: products.map(p => euro(p.base.net)).join(' bzw. '),
  base_vat_rate: String(data.vat_rate),
  chain_rate: String(data.chain.rate),
  chain_stage_cards: creditCases.full.stages.map((s, i) => `<li><span>${['Faser', 'Färberei', 'Verkauf'][i]}</span><strong data-chain-payment="${i}">${euro(s.payment)}</strong>
    <small>Netto ${euro(s.net)} · Ausgang ${euro(s.output)}</small>
    <small data-chain-credit="${i}">Anrechnung ${euro(s.credited)}</small></li>`).join(''),
  chain_full_total: euro(creditCases.full.total),
  chain_none_total: euro(creditCases.none.total),
  chain_difference: euro(creditCases.none.total - creditCases.full.total),
  chain_table: creditCases.full.stages.map((s, i) => tr(['Faser', 'Färberei', 'Verkauf'][i],
    [s.net, s.output, s.input, s.payment, creditCases.limited.stages[i].payment, creditCases.none.stages[i].payment].map(euro))).join('')
    + tr('Summe Zahllast', ['-', '-', '-', ...['full', 'limited', 'none'].map(key => euro(creditCases[key].total))]),
  effects: data.effects.map((e, i) => `<details class="effect"${i === 0 ? ' open' : ''}><summary><span>${esc(e.label)}</span>${esc(e.title)}</summary>
    <div class="detail"><p class="eyebrow">${esc(e.status)}</p><p>${esc(e.text)}</p><p><strong>Prüfen:</strong> ${esc(e.check)}</p></div></details>`).join(''),
  sources: data.sources.map(s => `<li id="s-${esc(s.id)}"><strong>${esc(s.id)} · <a href="${esc(s.url)}">${esc(s.title)}</a></strong><p>${esc(s.role)}</p></li>`).join('\n'),
  trade_status: scenario.tradeStatus('import-finished').treatment,
};

const lesson = fs.readFileSync('templates/examples/two-shirts.html', 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => {
  if (!Object.hasOwn(values, key)) throw new Error(`Unresolved shirt token ${key}`);
  return values[key];
}).replace(/[\u2011\u2013\u2014]/g, '-');
const serialized = JSON.stringify({ ...data, products }).replaceAll('<', '\\u003c');
const head = `<link rel="preload" href="/assets/fonts/playfair-display-600.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/source-sans-3-400.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/assets/css/two-shirts.css">
`;
const body = `<article id="shirt-example" data-glossary-ignore data-no-auto-toc>${lesson}</article>
<script id="example-data" type="application/json">${serialized}</script>
<script type="module" src="/assets/js/two-shirts-revision.js"></script>`;

writeContentPage({
  file: 'verstehen/zwei-t-shirts/index.html',
  title: 'Zwei T-Shirts: Lieferkette, Wirkung und Preise',
  description: 'Folge zwei fiktiven T-Shirts durch ihre Lieferketten. Prüfe Daten und Schutzgrenzen und rechne hypothetische Preise und Steuerkaskaden durch.',
  section: 'Verstehen',
  type: 'Erklärung',
  head,
  body,
});
