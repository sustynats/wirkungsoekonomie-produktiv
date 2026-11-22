import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {renderEinordnung,updateEinordnungPages} from '../scripts/site/build-wissenschaftliche-einordnung.mjs';
const read=p=>fs.readFileSync(p,'utf8');
const html=renderEinordnung({full:true});
test('public format labels never rewrite original source URLs',()=>{
  assert.match(execFileSync(process.execPath,['scripts/quality/sanitize-public-library-formats.mjs','--self-test']).toString(),/FORMAT_LABEL_URL_FIDELITY=PASS/);
});
test('four current lecture amendments are hash-bound and visible without replacing historical sources',()=>{
  const manifest=JSON.parse(read('content/studienskripte/v4/PUBLIC_MASTER_MANIFEST.json'));
  const changed=manifest.lectures.filter(r=>r.scientific_positioning_correction);
  assert.equal(changed.length,4);
  assert.equal(manifest.counts.study_lectures,120);
  assert.equal(manifest.counts.active_offering_lectures,58);
  for(const row of changed){
    const source=read('content/studienskripte/v4/'+row.public_path);
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'),row.public_sha256);
    const rendered=read('bibliothek/studienskripte/v4/'+row.lecture_id.toLowerCase()+'/index.html');
    assert.match(rendered,/Redaktionelle Ergänzung vom 10.11.2026/);
    assert.match(rendered,/Wirtschafts-, Gesellschafts- und Steuerungsmodell/);
    assert.match(rendered,/PDF-Ausgaben behalten ihren jeweiligen Editionsstand/);
  }
});
test('WÖk retains its model scope and explains scientific status without recognition claim',()=>{
  assert.match(html,/eigenständiges Wirtschafts-, Gesellschafts- und Steuerungsmodell/);
  assert.match(html,/BWL und VWL kennen bereits Wohlfahrtsökonomik/);
  assert.match(html,/belegt weder die universitäre Anerkennung/);
  assert.match(html,/vorgeschlagener inter- und transdisziplinärer Bezugsrahmen/i);
  assert.match(html,/WÖMM 2.0/);assert.match(html,/WÖMS 2.0/);
});
test('evolutionary economics coexists; it did not historically replace neoclassicism',()=>{
  assert.match(html,/koexistierende Strömungen/);
  assert.match(html,/hat die Neoklassik nicht historisch abgelöst/);
});
test('SGMM 5.0 remains an external working paper with Public Value history',()=>{
  assert.match(html,/31\.08\.2026 als Arbeitspapier/);
  assert.match(html,/keine Übernahme in WÖMM\/WÖMS/);
  assert.match(html,/kein Beleg für eine Kooperation oder Zustimmung der HSG/);
  assert.match(html,/Public-Value-Forschung untersucht bereits/);
});
test('sources retain summaries, verification scope, and reverse publication links',()=>{
  const records=JSON.parse(read('content/quellenarchiv/publication-supplements/wissenschaftliche-einordnung-20261110.json')).sources;
  assert.equal(records.length,6);assert.equal(new Set(records.map(r=>r.code)).size,6);
  for(const r of records){assert(r.summary);assert(r.verificationScope);assert.equal(r.checkedAt,'2026-11-10');assert.equal(r.relatedPublications.length,1);assert(html.includes(`/quellenarchiv/wok-q-${r.code.slice(-4)}/`));}
});
test('generated glossary preserves stable aliases and removes first-mover claim',()=>{
  const source=JSON.parse(read('assets/data/term-registry.json')).terms.find(t=>(t.termId||t.id)==='wirkungswissenschaften');
  assert.equal(source.long_definition,source.longDefinition);
  assert.equal(source.woek_einordnung,source.woekRelation);
  const j=JSON.parse(read('public/data/glossary.terms.json'));const term=j.terms.find(t=>(t.termId||t.id)==='wirkungswissenschaften');
  assert(term);assert(term.synonyms.includes("Wirkungswissenschaften im Weber'schen Sinn"));
  assert.match(term.shortDefinition,/vorgeschlagen/);
  assert.doesNotMatch(term.longDefinition,/Wirkung erstmals/);
});
test('explanatory section is idempotent and historical texts receive a dated notice',()=>{
  updateEinordnungPages();const before=read('index.html');updateEinordnungPages();assert.equal(read('index.html'),before);
  assert.equal((before.match(/id="wissenschaftliche-einordnung"/g)||[]).length,1);
  assert.match(renderEinordnung({historical:true}),/keine Neuausgabe/);
  const historical=read('blog/wirkungswissenschaften-wirkungsforschung-wirkungsoekonomie.html');
  assert(historical.indexOf('wissenschaftliche-einordnung-20261110:start')<historical.indexOf('<main'));
  assert.doesNotMatch(historical.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1],/wissenschaftliche-einordnung-20261110:start/);
});
