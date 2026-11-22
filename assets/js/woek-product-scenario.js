const OPEN = 'OFFEN';
const MODEL_VERSION = '0.1-draft';

export function createDraftProductPass(input, sourceVersion) {
  if (input.subject?.type !== 'product') throw new TypeError('Der Entwurf unterstützt Produktprüfungen.');
  if (!input.subject.id || !sourceVersion.register || !sourceVersion.tax_model) {
    throw new TypeError('Produkt-ID und Quellenfassungen sind erforderlich.');
  }

  const hardBoundaryStatus = input.hard_boundary_status ?? OPEN;
  if (![OPEN, 'VIOLATED', 'NOT_VIOLATED', 'NOT_APPLICABLE'].includes(hardBoundaryStatus)) {
    throw new RangeError('Unbekannter Schutzstatus.');
  }

  return {
    schema_version: MODEL_VERSION,
    subject: input.subject,
    system_boundary: input.system_boundary ?? OPEN,
    nace: input.nace ?? [],
    sdg_mapping: input.sdg_mapping ?? [],
    indicator_evidence: input.indicator_evidence ?? [],
    baseline: input.baseline ?? OPEN,
    counterfactual: input.counterfactual ?? OPEN,
    attribution: input.attribution ?? OPEN,
    uncertainty: input.uncertainty ?? OPEN,
    data_quality: input.data_quality ?? OPEN,
    hard_boundary_status: hardBoundaryStatus,
    rmo_result: OPEN,
    final_score_status: hardBoundaryStatus === 'VIOLATED' ? 'BLOCKED' : OPEN,
    tariff_class_status: OPEN,
    legal_module_id: null,
    legal_effect_status: 'NOT_IN_FORCE',
    review_status: 'DRAFT',
    source_version: { ...sourceVersion },
  };
}

function requireInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError('Ungültige Szenarioeingabe.');
  }
}

function percentage(cents, rate) {
  requireInteger(cents, 0, 1_000_000_000);
  requireInteger(rate, 0, 100);
  // Rechenschritt in Cent. Einen halben Cent kaufmännisch aufrunden.
  return Math.floor((cents * rate + 50) / 100);
}

export function basePrice(product, vatRate) {
  requireInteger(product.cost_cents, 0, 1_000_000_000);
  const net = product.net_cents;
  const vat = percentage(net, vatRate);
  return { net, vat, gross: net + vat, contribution: net - product.cost_cents };
}

export function retailScenario(product, { rate, vatRate, vatBasis, passThrough }) {
  if (!['excludes', 'includes'].includes(vatBasis)) throw new RangeError('Umsatzsteuerbasis offen.');
  const base = basePrice(product, vatRate);
  const levy = percentage(base.net, rate);
  const passedOn = percentage(levy, passThrough);
  const absorbed = levy - passedOn;
  const taxable = base.net + (vatBasis === 'includes' ? passedOn : 0);
  const vat = percentage(taxable, vatRate);
  return {
    base, levy, passedOn, taxable, vat,
    gross: base.net + passedOn + vat,
    contribution: base.contribution - absorbed,
    legalEffectStatus: 'NOT_IN_FORCE',
  };
}

export function chainScenario(stageNets, rate, creditShares) {
  if (stageNets.length !== creditShares.length || stageNets.length === 0) {
    throw new RangeError('Für jede Stufe ist eine Anrechnungsannahme erforderlich.');
  }

  let input = 0;
  let total = 0;
  const stages = stageNets.map((net, index) => {
    const output = percentage(net, rate);
    const credited = percentage(input, creditShares[index]);
    const payment = output - credited;
    const stage = { net, output, input, credited, payment };
    input = output;
    total += payment;
    return stage;
  });
  return { stages, total, legalEffectStatus: 'NOT_IN_FORCE' };
}

export function tradeStatus(route) {
  if (!['domestic', 'import-input', 'import-finished', 'export'].includes(route)) {
    throw new RangeError('Unbekannter Handelsfall.');
  }
  return { route, treatment: OPEN, legalEffectStatus: 'NOT_IN_FORCE' };
}
