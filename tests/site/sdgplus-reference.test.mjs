import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const siteRoot = path.resolve(process.env.SDGPLUS_SITE_ROOT ?? process.cwd());
const sourceRoot = path.resolve(process.env.SDGPLUS_SOURCE_ROOT ?? process.cwd());
const origin = 'https://wirkungsoekonomie.de';
const productionBase = '2a5eeca39c754b5ec3119bc77b5b2e873178f42a';
const referencePath = 'api/v1/sdg-plus/reference-v1.json';
const matrixPath = 'api/v1/sdg-plus/matrix-v1.json';
const registerPath = 'assets/downloads/woek-register/v1.5/register-v1.5.json';
const legacyPath = 'api/v1/sdg-plus.json';
const legacyIds = [
  'sdgplus-demokratie', 'sdgplus-medienqualitaet', 'sdgplus-rechtsstaatlichkeit',
  'sdgplus-diskursfaehigkeit', 'sdgplus-institutionelles-vertrauen',
  'sdgplus-gesellschaftlicher-zusammenhalt', 'sdgplus-digitale-selbstbestimmung',
];
const goalCatalog = [
  ['demokratie', 'Demokratiequalität', 'Quality of democracy', 'Demokratie'],
  ['medien', 'Medienvielfalt und Medienunabhängigkeit', 'Media pluralism and independence', 'Medienvielfalt'],
  ['rechtsstaat', 'Rechtsstaatlichkeit', 'Rule of law', 'Rechtsstaatlichkeit'],
  ['diskurs', 'Diskurs- und Debattenkultur', 'Quality of public discourse and debate', 'Diskurskultur'],
  ['resilienz', 'Gesellschaftliche Resilienz', 'Societal resilience', 'Resilienz'],
  ['technologie', 'Technologie- und Digitalverantwortung', 'Technology and digital responsibility', 'Technologie-Verantwortung'],
  ['kooperation', 'Systemische Kooperation', 'Systemic cooperation', 'Kooperationen/Systemwandel'],
  ['vielfalt', 'Kulturelle Vielfalt und Inklusion', 'Cultural diversity and inclusion', 'Kultur'],
  ['transparenz', 'Öffentliche Transparenz und Rechenschaft', 'Public transparency and accountability', 'Transparenz/Open Data'],
];
const languageRoutes = { de: '/verstehen/sdgs-sdgplus/', en: '/en/sdg-plus/' };
const officialNumbers = Array.from({ length: 17 }, (_, index) => index + 1);
const langs = ['de', 'en'];

function contents(relative, root = siteRoot) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function json(relative, root = siteRoot) {
  return JSON.parse(contents(relative, root));
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

function semanticChecksum(value) {
  return checksum(JSON.stringify(value, (_, entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : Number(left > right)));
  }));
}

function embeddedStrings(html, attribute) {
  const expression = new RegExp('\\s' + attribute + '=["\']([^"\']+)["\']', 'g');
  return Array.from(html.matchAll(expression), (match) => match[1]);
}

function localUrl(value, from) {
  const url = new URL(value, origin + from);
  assert.equal(url.origin, origin, value);
  return url;
}

function localRoute(value, from) {
  const url = localUrl(value, from);
  return url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
}

function linkedPaths(html, from) {
  return new Set(embeddedStrings(html, 'href').map((value) => new URL(value, origin + from).pathname));
}

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, number) => String.fromCodePoint(Number(number.replace(/^x/i, '0x'))))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function contrastWithWhite(hex) {
  const digits = hex.slice(1);
  const components = [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16) / 255);
  const channels = components.map((component) => (
    component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
  ));
  const [red, green, blue] = channels;
  return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05);
}

function nonempty(value, label) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, label);
}

test('published SDG+ reference retains the approved numbering, bilingual titles and visual identifiers', () => {
  const reference = json(referencePath);
  assert.equal(reference.schemaVersion, 1);
  assert.equal(reference.version, '1.0');
  assert.equal(reference.currentReferenceUrl, origin + languageRoutes.de);
  assert.equal(reference.registerVersion, '1.5');
  assert.equal(reference.modelAuthor, 'Natalie Weber');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(reference.effectiveFrom), 'reference has no effective date');
  assert.equal(reference.status, 'FACHLICH_FREIGEGEBEN');
  assert.equal(reference.approval.version, reference.version);
  assert.equal(reference.approval.date, reference.effectiveFrom);
  assert.match(reference.approval.reviewPackageSha256, /^[a-f0-9]{64}$/);
  assert.equal(reference.goals.length, 9);

  const colors = new Set();
  const icons = new Set();
  for (const [index, [id, german, english, field]] of goalCatalog.entries()) {
    const goal = reference.goals[index];
    assert.deepEqual([goal.id, goal.number, goal.de.title, goal.en.title, goal.registerField],
      [id, index + 1, german, english, field]);
    assert.match(goal.color, /^#[0-9a-f]{6}$/i);
    assert.ok(contrastWithWhite(goal.color) >= 4.5, `${id}: insufficient contrast to white`);
    nonempty(goal.icon, `${id}: icon`);
    colors.add(goal.color.toLowerCase());
    icons.add(goal.icon);
    for (const lang of langs) {
      for (const field of ['summary', 'why', 'scope', 'alt', 'detail', 'glossary', 'asset']) {
        nonempty(goal[lang][field], `${id} ${lang} ${field}`);
      }
      assert.ok(goal[lang].alt.includes(`SDG+ ${goal.number}`));
      assert.ok(goal[lang].alt.includes(goal[lang].title));
      assert.ok(Array.isArray(goal[lang].aliases), `${id} ${lang} aliases`);
    }
  }
  assert.equal(colors.size, 9);
  assert.equal(icons.size, 9);
});

test('162 public placements trace back to the existing v1.5 MasterItems without activating measurement mapping', () => {
  const registerText = contents(registerPath, sourceRoot);
  // The versioned register is a historical artifact. A later revision requires a new version.
  assert.equal(checksum(registerText), '643eab0ad79fdc3c87e3abf97ba823c32ead4e831765a08150d2ee1095b0f665', productionBase);
  const register = JSON.parse(registerText);
  assert.equal(register.register_version, '1.5');
  assert.equal(register.items.length, 621);
  assert.equal(new Set(register.items.map((item) => item.WOK_ID)).size, 621);
  const { goals } = json(referencePath);
  const referenced = new Set();
  for (const goal of goals) {
    const sourceGroup = register.items.filter((item) => item.SDG_or_SDGplus === `SDG+ - ${goal.registerField}`);
    assert.equal(sourceGroup.length, 18, goal.id);
    assert.ok(sourceGroup.every((item) => item.Indicator_Mapping_Status === 'OPEN_REVIEW_REQUIRED'), goal.id);
    assert.equal(goal.indicatorMappingStatus, 'OPEN_REVIEW_REQUIRED', goal.id);
    assert.deepEqual([...goal.masterItems].sort(), sourceGroup.map((item) => item.WOK_ID).sort(), goal.id);
    for (const id of goal.masterItems) {
      assert.ok(!referenced.has(id), `duplicate public placement: ${id}`);
      referenced.add(id);
    }
  }
  assert.equal(referenced.size, 162);
});

test('matrix covers every pair once and retains open cases and bilingual explanations', () => {
  const matrix = json(matrixPath);
  const reference = json(referencePath);
  assert.equal(matrix.version, reference.version);
  assert.equal(matrix.date, reference.date);
  assert.equal(matrix.status, reference.status);
  const knownTargets = new Set(json('data/sdg_unterziele_global_europa_deutschland_matrix_v1_0.json', sourceRoot).map((row) => row.Target));
  const expectedPairs = officialNumbers.flatMap((sdg) => goalCatalog.map(([goal]) => `${sdg}/${goal}`));
  const statuses = { bezug: 0, kein_begruendeter_bezug: 0, offen: 0 };
  const pairs = new Set();
  assert.equal(matrix.pairs.length, 153);
  for (const entry of matrix.pairs) {
    const key = `${entry.sdg}/${entry.goal}`;
    assert.ok(!pairs.has(key), key);
    pairs.add(key);
    assert.ok(entry.status in statuses, key);
    statuses[entry.status]++;
    for (const field of ['relation', 'reason', 'relation_en', 'reason_en']) nonempty(entry[field], `${key} ${field}`);
    if (entry.status === 'offen') {
      assert.deepEqual(entry.targets, [], key);
      assert.deepEqual(entry.indicators, [], key);
      continue;
    }
    for (const field of ['indicator_scope', 'conditions', 'woek', 'indicator_scope_en', 'conditions_en', 'woek_en', 'evidence']) {
      nonempty(entry[field], `${key} ${field}`);
    }
    assert.ok(entry.targets.length && entry.indicators.length && entry.sources.length, key);
    assert.ok(entry.targets.every((code) => code.startsWith(`${entry.sdg}.`) && knownTargets.has(code)), key);
    assert.ok(entry.indicators.every((code) => entry.targets.includes(code.slice(0, code.lastIndexOf('.')))), key);
    for (const source of entry.sources) {
      assert.equal(new URL(source.url).protocol, 'https:', key);
      nonempty(source.label, key);
      nonempty(source.role, key);
    }
  }
  assert.deepEqual(pairs, new Set(expectedPairs));
  assert.deepEqual(statuses, { bezug: 69, kein_begruendeter_bezug: 1, offen: 83 });
});

test('legacy v1 keeps its payload, seven identifiers and 17 unchanged UN goals', () => {
  const legacy = json(legacyPath);
  const { generatedAt, ...payload } = legacy;
  assert.deepEqual(legacy, json('api/v1/sdg-plus/index.json'));
  assert.ok(Number.isFinite(Date.parse(generatedAt)));
  assert.equal(semanticChecksum(payload), 'e2e96a34e13bc99438518e207c503c4a23a9472104d30c4ff8aa2e4265cc6279', productionBase);
  assert.equal(legacy.version, 'v1');
  assert.equal(legacy.count, 24);
  assert.equal(legacy.items.length, 24);
  const sdgs = legacy.items.filter((item) => item.type === 'sdg');
  assert.deepEqual(sdgs.map((item) => item.number), officialNumbers);
  assert.ok(sdgs.every((item) => item.isOfficialUNGoal && item.id === `sdg-${item.number}`));
  const oldDimensions = legacy.items.filter((item) => item.type === 'sdgplus');
  assert.deepEqual(oldDimensions.map((item) => item.id), legacyIds);
  for (const direction of oldDimensions) {
    assert.equal(direction.number, null);
    assert.equal(direction.isOfficialUNGoal, false);
    assert.equal(direction.url, `${languageRoutes.de}#${direction.id}`);
  }
  const data = json('assets/data/sdg-reference.json');
  assert.equal(semanticChecksum(data.filter((item) => item.type === 'sdg')),
    '578a15a686133560139b67584b4c010b9d543f72e7d597a98c711066ac60070e', productionBase);
  assert.equal(checksum(contents('data/sdg_detail_matrix_v0_3.json', sourceRoot)),
    'ee2a7e27b55be321faf6925515a83c362a033157f0186a5c8414c6e5a7bc8d61', productionBase);
});

test('bilingual production pages expose the approved catalog and preserve every legacy anchor', () => {
  const { goals } = json(referencePath);
  for (const lang of langs) {
    const from = languageRoutes[lang];
    const overview = contents(localRoute(from, from));
    const newerCatalogs = embeddedStrings(overview, 'data-sdgplus-reference');
    assert.deepEqual(newerCatalogs, ['1.0'], `${lang}: one active catalog expected`);
    assert.deepEqual(embeddedStrings(overview, 'data-sdgplus-number'), goals.map((goal) => String(goal.number)));
    const text = visibleText(overview);
    const inlineLinks = linkedPaths(overview, from);
    assert.doesNotMatch(text, /\bSDG\+?\s+(?:1[89]|2[0-6])\b/i);
    assert.doesNotMatch(text, /Sieben Erweiterungsdimensionen|Seven extension dimensions/i);
    for (const goal of goals) {
      const localized = goal[lang];
      assert.ok(text.includes(localized.title), `${lang}: absent title ${localized.title}`);
      assert.ok(text.includes(localized.summary), `${lang}: absent summary ${goal.id}`);
      assert.ok(text.includes(localized.why), `${lang}: absent rationale ${goal.id}`);
      const detail = localUrl(localized.detail, from);
      const topicPath = lang === 'de' ? 'ziele' : 'goals';
      assert.equal(detail.pathname, `${from}${topicPath}/${goal.id}/`);
      assert.ok(inlineLinks.has(detail.pathname), `${lang}: overview does not link ${detail.pathname}`);
      const page = contents(localRoute(localized.detail, from));
      assert.deepEqual(embeddedStrings(page, 'data-sdgplus-goal'), [goal.id], `${lang}: detail ${goal.id}`);
      assert.ok(visibleText(page).includes(localized.title));
      const glossary = contents(localRoute(localized.glossary, from));
      assert.ok(visibleText(glossary).includes(localized.title));
      assert.ok(linkedPaths(glossary, localUrl(localized.glossary, from).pathname).has(detail.pathname), `${lang}: glossary link ${goal.id}`);
      const asset = localRoute(localized.asset, from);
      assert.ok(existsSync(path.join(siteRoot, asset)), `${lang}: missing asset ${asset}`);
      assert.match(contents(asset), /<svg\b[^>]*\bviewBox=/s);
    }
    if (lang === 'de') {
      for (const id of legacyIds) {
        assert.equal(embeddedStrings(overview, 'id').filter((anchor) => anchor === id).length, 1, id);
      }
    }
  }
});
