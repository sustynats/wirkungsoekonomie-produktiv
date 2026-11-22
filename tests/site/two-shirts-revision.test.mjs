import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { basePrice, chainScenario, createDraftProductPass, retailScenario, tradeStatus } from '../../assets/js/woek-product-scenario.js';

const read = url => fs.readFileSync(new URL(url, import.meta.url), 'utf8');
const data = JSON.parse(read('../../content/examples/two-shirts-revision.json'));
const [a, b] = data.products;
const options = { vatRate: data.vat_rate, vatBasis: 'excludes', passThrough: 100 };
const pass = input => createDraftProductPass({ subject: { type: 'product', id: 'example' }, ...input }, data.source_version);
const simulate = (product, rate, overrides) => retailScenario(product, { ...options, rate, ...overrides });

test('missing evidence and NACE alone leave the classification open', () => {
  const result = pass({ nace: [{ code: '14.10', revision: '2.1' }] });
  for (const key of ['counterfactual', 'attribution', 'data_quality', 'hard_boundary_status', 'rmo_result', 'final_score_status', 'tariff_class_status']) {
    assert.equal(result[key], 'OFFEN');
  }
  assert.deepEqual(result.indicator_evidence, []);
});

test('a hard boundary cannot be compensated by positive evidence', () => {
  const result = pass({ hard_boundary_status: 'VIOLATED', indicator_evidence: [{ value: 90 }], final_score_status: 'POSITIVE' });
  assert.equal(result.hard_boundary_status, 'VIOLATED');
  assert.equal(result.final_score_status, 'BLOCKED');
  assert.equal(result.tariff_class_status, 'OFFEN');
});

test('product pass rejects person identifiers as evaluation subjects', () => {
  assert.throws(() => pass({ subject: { type: 'person', id: 'example' } }), TypeError);
});

test('source and method versions remain traceable even when a user supplies an activation ID', () => {
  const draft = pass({ legal_module_id: 'provided-but-unverified', legal_effect_status: 'IN_FORCE' });
  assert.equal(draft.review_status, 'DRAFT');
  assert.equal(draft.legal_module_id, null);
  assert.equal(draft.legal_effect_status, 'NOT_IN_FORCE');
  const nextSources = { ...data.source_version, register: 'v1.5 test', benchmark: 'benchmark-revision test' };
  const next = createDraftProductPass({ subject: draft.subject }, nextSources);
  assert.deepEqual(draft.source_version, data.source_version);
  assert.deepEqual(next.source_version, nextSources);
  assert.notEqual(next.source_version, nextSources);
});

test('tariff and VAT variants can reverse or preserve price order without generating a real liability', () => {
  assert.deepEqual([a, b].map(product => basePrice(product, 19).gross), [1428, 1666]);
  assert.deepEqual([simulate(a, 25).gross, simulate(b, 0).gross], [1728, 1666]);
  assert.deepEqual([simulate(a, 20).gross, simulate(b, 5).gross], [1668, 1736]);
  assert.deepEqual([simulate(a, 20, { vatBasis: 'includes' }).gross, simulate(b, 5, { vatBasis: 'includes' }).gross], [1714, 1749]);
  assert.equal(simulate(a, 25, { vatBasis: 'includes' }).gross, 1785);
  assert.equal(simulate(a, 25, { passThrough: 50 }).contribution, 250);
  assert.equal(simulate(a, 25, { passThrough: 0 }).contribution, 100);
  assert.equal(simulate(a, 25).legalEffectStatus, 'NOT_IN_FORCE');
  assert.equal(simulate({ net_cents: 10, cost_cents: 1 }, 5).levy, 1);
  assert.throws(() => simulate(a, undefined), RangeError);
});

test('only the passed-on levy changes the pre-VAT customer payment in either VAT scenario', () => {
  const cases = [
    // product, tariff, pass-through, passed-on levy, margin, gross outside, VAT inside, gross inside
    [a, 25, 0, 0, 100, 1428, 228, 1428],
    [a, 25, 50, 150, 250, 1578, 257, 1607],
    [a, 25, 100, 300, 400, 1728, 285, 1785],
    [a, 20, 0, 0, 160, 1428, 228, 1428],
    [a, 20, 50, 120, 280, 1548, 251, 1571],
    [a, 20, 100, 240, 400, 1668, 274, 1714],
    [b, 5, 0, 0, 330, 1666, 266, 1666],
    [b, 5, 50, 35, 365, 1701, 273, 1708],
    [b, 5, 100, 70, 400, 1736, 279, 1749],
    [b, 0, 0, 0, 400, 1666, 266, 1666],
    [b, 0, 50, 0, 400, 1666, 266, 1666],
    [b, 0, 100, 0, 400, 1666, 266, 1666],
  ];
  for (const [product, rate, passThrough, passedOn, margin, grossOutside, vatInside, grossInside] of cases) {
    const label = `${product.id}, tariff ${rate}%, pass-through ${passThrough}%`;
    const outside = simulate(product, rate, { passThrough });
    const inside = simulate(product, rate, { passThrough, vatBasis: 'includes' });
    assert.deepEqual(
      [outside.passedOn, outside.taxable, outside.vat, outside.gross, outside.contribution],
      [passedOn, outside.base.net, outside.base.vat, grossOutside, margin],
      `${label}, levy outside VAT`,
    );
    assert.deepEqual(
      [inside.passedOn, inside.taxable, inside.vat, inside.gross, inside.contribution],
      [passedOn, inside.base.net + passedOn, vatInside, grossInside, margin],
      `${label}, levy inside VAT`,
    );
    assert.equal(outside.levy, inside.levy, label);
  }
});

test('a half-cent at levy and pass-through steps rounds up separately', () => {
  const product = { net_cents: 10, cost_cents: 1 };
  const rows = ['excludes', 'includes'].map(vatBasis => simulate(product, 5, { passThrough: 50, vatBasis }));
  assert.deepEqual(rows.map(({ levy, passedOn, taxable, vat, gross }) => [levy, passedOn, taxable, vat, gross]),
    [[1, 1, 10, 2, 13], [1, 1, 11, 2, 13]]);
});

test('partial denial and complete denial are visible across three stages', () => {
  const { net_cents, rate, credit } = data.chain;
  const full = chainScenario(net_cents, rate, credit.full);
  const limited = chainScenario(net_cents, rate, credit.limited);
  const none = chainScenario(net_cents, rate, credit.none);
  assert.deepEqual(full.stages.map(stage => stage.payment), [80, 60, 100]);
  assert.deepEqual(limited.stages.map(stage => stage.payment), [80, 140, 100]);
  assert.deepEqual(none.stages.map(stage => stage.payment), [80, 140, 240]);
  assert.equal(none.total - full.total, 220);
});

test('import and export stay open in the absence of a statute', () => {
  for (const route of ['domestic', 'import-input', 'import-finished', 'export']) {
    assert.deepEqual(tradeStatus(route), { route, treatment: 'OFFEN', legalEffectStatus: 'NOT_IN_FORCE' });
  }
});

test('generated explanation displays sources and epistemic status without the old levy or a T-SROI prerequisite', () => {
  const html = read('../../verstehen/zwei-t-shirts/index.html');
  assert.match(html, /Produkt-FinalScore<\/th><td>OFFEN<\/td><td>OFFEN/);
  assert.match(html, /04_Tarifmodell, B6:C12/);
  assert.match(html, /T-SROI<\/a> kann eine geeignete Investition prüfen/);
  assert.doesNotMatch(html, /Lernsatz je Kilogramm|Reservierter Anteil|Fonds zahlt für diesen Kauf|14,26|\{\{/);
});

test('the journey exposes every verified tariff class, complete stages and independent inputs', () => {
  const html = read('../../verstehen/zwei-t-shirts/index.html');
  assert.deepEqual(data.working_scale, { '-3': 25, '-2': 20, '-1': 15, 0: 10, 1: 5, 2: 0, 3: 0 });
  assert.equal(data.metadata.legal_status, 'NOT_IN_FORCE');
  assert.equal(data.metadata.author_approval_status, 'PENDING');
  assert.equal(data.journey_stages.length, 8);
  for (const stage of data.journey_stages) {
    assert.ok(stage.nace && stage.sdg && stage.evidence && stage.owner && stage.gap, stage.id);
    assert.ok(html.includes(`id="station-${stage.id}"`), stage.id);
  }
  for (const id of ['tariff-a', 'tariff-b', 'vat-basis', 'pass-through']) {
    assert.ok(html.includes(`<label for="${id}">`));
    assert.ok(html.includes(`<select id="${id}">`));
  }
  assert.equal((html.match(/<option value="">Bitte wählen<\/option>/g) ?? []).length, 2);
  assert.match(html, /<link rel="canonical" href="https:\/\/wirkungsoekonomie\.de\/verstehen\/zwei-t-shirts\/"/);
  assert.match(html, /id="trade"/);
});
