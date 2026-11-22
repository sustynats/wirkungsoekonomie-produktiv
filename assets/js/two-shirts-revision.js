import { chainScenario, retailScenario } from './woek-product-scenario.js';

const root = document.querySelector('#shirt-example');
const data = JSON.parse(document.querySelector('#example-data').textContent);
const euro = cents => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const tariffA = root.querySelector('#tariff-a');
const tariffB = root.querySelector('#tariff-b');
const vatBasis = root.querySelector('#vat-basis');
const passThrough = root.querySelector('#pass-through');
const result = root.querySelector('#scenario-result');
const announcement = root.querySelector('#scenario-announcement');
const prices = ['a', 'b'].map(id => root.querySelector(`#price-after-${id}`));

function renderPrice() {
  const rateA = data.working_scale[tariffA.value];
  const rateB = data.working_scale[tariffB.value];
  if (rateA === undefined || rateB === undefined) {
    result.textContent = 'Wähle für beide Shirts eine hypothetische Klasse.';
    for (const price of prices) price.textContent = 'OFFEN';
    announcement.textContent = result.textContent;
    return;
  }

  const rows = [rateA, rateB].map((rate, index) => retailScenario(data.products[index], {
    rate,
    vatRate: data.vat_rate,
    vatBasis: vatBasis.value,
    passThrough: Number(passThrough.value),
  }));
  const lines = [
    ['Fixe Nettobasis der Abgabe', row => row.base.net],
    ['Fiktive Wirkungsabgabe', row => row.levy],
    ['Davon im Preis weitergegeben (vor USt)', row => row.passedOn],
    ['Umsatzsteuerbasis im Szenario', row => row.taxable],
    ['Umsatzsteuer im Szenario', row => row.vat],
    ['Hypothetischer Zahlbetrag', row => row.gross],
    ['Stücküberschuss vor Ertragsteuer', row => row.contribution],
    ['Wirkungsabgabe für 100 Verkäufe', row => row.levy * 100],
  ];
  const table = document.createElement('table');
  table.createCaption().textContent = 'Rechenweg für die gewählten Annahmen';
  const header = table.createTHead().insertRow();
  for (const label of ['Rechengröße', 'A', 'B']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    header.append(cell);
  }
  const body = table.createTBody();
  for (const [label, amount] of lines) {
    const row = body.insertRow();
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    row.append(heading);
    for (const product of rows) row.insertCell().textContent = euro(amount(product));
  }
  result.replaceChildren(table);
  rows.forEach((row, index) => {
    prices[index].textContent = euro(row.gross);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      prices[index].animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 180 });
    }
  });
  announcement.textContent = `Hypothetische Zahlbeträge A ${euro(rows[0].gross)}, B ${euro(rows[1].gross)}.`;
}

for (const select of [tariffA, tariffB, vatBasis, passThrough]) select.addEventListener('change', renderPrice);
const credits = root.querySelectorAll('input[name="credit"]');
for (const radio of credits) {
  radio.addEventListener('change', () => {
    const { net_cents, rate, credit } = data.chain;
    const next = chainScenario(net_cents, rate, credit[radio.value]);
    next.stages.forEach((stage, index) => {
      root.querySelector(`[data-chain-payment="${index}"]`).textContent = euro(stage.payment);
      root.querySelector(`[data-chain-credit="${index}"]`).textContent = `Anrechnung ${euro(stage.credited)}`;
    });
    root.querySelector('#chain-total').textContent = euro(next.total);
    root.querySelector('#chain-status').textContent = `Gesamtabführung ${euro(next.total)}.`;
  });
}

const technicalDetails = root.querySelectorAll('details[data-evidence]');
const short = root.querySelector('#short-mode');
const deep = root.querySelector('#deep-mode');
for (const button of [short, deep]) {
  button.addEventListener('click', () => {
    const expanded = button === deep;
    for (const detail of technicalDetails) detail.open = expanded;
    short.setAttribute('aria-pressed', String(!expanded));
    deep.setAttribute('aria-pressed', String(expanded));
  });
}

const menu = root.querySelector('.chapter-menu');
const links = Array.from(menu.querySelectorAll('a'));
const chapters = links.map(link => document.querySelector(link.hash));
const progress = root.querySelector('#story-progress');
const current = root.querySelector('#story-current');
progress.hidden = false;
for (const link of links) {
  link.addEventListener('click', () => {
    menu.open = false;
    const heading = document.querySelector(link.hash)?.querySelector('h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  });
}
menu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

function updateChapter() {
  const marker = root.querySelector('.story-nav').getBoundingClientRect().bottom + 50;
  const chapter = chapters.findLastIndex(section => section.getBoundingClientRect().top <= marker);
  progress.value = chapter + 1;
  current.textContent = links[chapter]?.textContent ?? 'Überblick';
  links.forEach((link, index) => {
    if (chapter === index) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

let scheduled = false;
function scheduleChapter() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    updateChapter();
  });
}

window.addEventListener('scroll', scheduleChapter, { passive: true });
window.addEventListener('resize', scheduleChapter);
updateChapter();

function revealSource() {
  const source = document.getElementById(location.hash.slice(1));
  const details = source?.closest('details');
  if (details && !details.open) {
    details.open = true;
    requestAnimationFrame(() => source.scrollIntoView({ block: 'start' }));
  }
}
window.addEventListener('hashchange', revealSource);
revealSource();
