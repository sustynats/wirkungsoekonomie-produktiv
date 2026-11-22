import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {ladeAuftraege} from '../../scripts/news/meldungsauftraege-lauf.mjs';
import {recoverDiscoveryForRun,newsOnlyPriorWorkHold,titleImageIdsForRun} from '../../scripts/news/run.mjs';
import {assertAutomaticImpactTransport} from '../../scripts/news/processing-mode.mjs';
const workflow=fs.readFileSync(new URL('../../.github/workflows/wirkungsticker.yml',import.meta.url),'utf8');
const step=name=>{const marker=`      - name: ${name}\n`,i=workflow.indexOf(marker);assert.notEqual(i,-1);const j=workflow.indexOf('\n      - name:',i+marker.length);return workflow.slice(i,j<0?undefined:j);};
test('news-only isolates paid discovery while retaining approved editorial publication',()=>{
 assert.match(workflow,/if: vars\.WIRKUNGSTICKER_PROCESSING_MODE == 'api' \|\| vars\.WIRKUNGSTICKER_PROCESSING_MODE == ''/);
 for(const name of ["Fetch Natalie's news orders from the private editorial desk","Hand analysed news orders to Natalie's approval list",'Recover the verified retained St. Pauli answer without a provider call','Queue potential reassessments for the newest online stories','Synchronize public survey pages from Oracle']) assert.match(step(name),/^        if: \$\{\{ false && /m,name);
 for(const name of ['Take over editions approved in the private editorial desk','Acknowledge approved editions after the durable push']) {
  assert.match(step(name),/^        if: steps\.slot\.outputs\.should_run == 'true' && inputs\.dry_run != true$/m,name);
  assert.match(step(name),/WOEK_NEWS_BRIDGE_TOKEN: \$\{\{ secrets\.WOEK_NEWS_BRIDGE_TOKEN \}\}/);
  assert.doesNotMatch(step(name),/run-api\.mjs|OPENAI_API_KEY|redaktionsworker\.mjs/);
 }
 for(const name of ['Verify interrupted paid work before another provider request','Validate the existing archive encryption key before paid work','Seal paid originals for private recovery','Preserve failed-run work and usage for recovery']) assert.doesNotMatch(step(name),/^        if: \$\{\{ false && /m,name);
});
test('both workflows run the same isolated unit test script without changing news settings',()=>{
 const unit=fs.readFileSync(new URL('../../scripts/news/run-isolated-unit-tests.sh',import.meta.url),'utf8');
 assert.match(step('Unit and security tests'),/run: bash scripts\/news\/run-isolated-unit-tests\.sh/);
 const quality=fs.readFileSync(new URL('../../.github/workflows/pr-quality.yml',import.meta.url),'utf8');
 assert.match(quality,/run: bash scripts\/news\/run-isolated-unit-tests\.sh/);
 assert.match(unit, /\/usr\/bin\/unshare --net/);
 assert.match(unit, /ip link set lo up/);
 assert.match(unit, /runuser -u/);
 assert.match(unit, /\/usr\/bin\/env -i/);
 assert.match(unit, /WOEK_NEWS_ONLY=/);
 assert.match(unit, /VISUAL_GENERATION_PROVIDER=higgsfield/);
 assert.match(unit, /WOEK_HIGGSFIELD_BIN=\/usr\/bin\/false/);
 const run=step('Import, analyze (one call per story) and build');
 assert.doesNotMatch(run, /^\s+WOEK_NEWS_ONLY:/m);
 assert.doesNotMatch(run, /^\s+VISUAL_GENERATION_PROVIDER:/m);
});
test('news-only supplies no private order or image endpoint and never reintroduces historical discovery',()=>{
 for(const variable of ['WOEK_NEWS_ORDER_FILE','WOEK_NEWS_ORDER_RESULT_FILE','WOEK_NEWS_BRIDGE_URL','WOEK_NEWS_BRIDGE_TOKEN','WOEK_NEWS_ANALYSIS_TOKEN','WOEK_NEWS_VISUAL_API_URL'])assert.match(workflow,new RegExp(`^      ${variable}: ""$`,'m'));
 assert.match(workflow,/^      VISUAL_GENERATION_PROVIDER: disabled$/m);assert.match(workflow,/^      WOEK_NEWS_ONLY: "true"$/m);assert.deepEqual(ladeAuftraege(''),[]);
 let called=0;const args={synthetic:true},recover=actual=>{called++;assert.equal(actual,args);return 'retained';};assert.equal(recoverDiscoveryForRun(args,{env:{WOEK_NEWS_ONLY:'true'},recover}),null);assert.equal(called,0);assert.equal(recoverDiscoveryForRun(args,{env:{},recover}),'retained');assert.equal(called,1);
});

test('news-only holds published and reassessment work without changing the normal lane',()=>{
 const env={WOEK_NEWS_ONLY:'true'};
 for(const candidate of [{existing_story:{published:true}},{reassessment:true},{impact_reassessment:true}]){
   assert.equal(newsOnlyPriorWorkHold(candidate,env),true);
   assert.equal(newsOnlyPriorWorkHold(candidate,{}),false);
 }
 assert.equal(newsOnlyPriorWorkHold({story_id:'wt-test',existing_story:null},env),false);
 assert.equal(newsOnlyPriorWorkHold({story_id:'wt-test',existing_story:{published:false,ai_retry_history:[{version:'old',fingerprint:'old-input',retry_count:1}]}},env),true);
});

test('news-only selects images only for newly created stories and never queues old images',()=>{
 const changed=new Set(['old','new']);const existing=new Set(['old','pending']);let queueCalls=0;
 const queue=()=>{queueCalls++;return [{story_id:'pending'}];};
 assert.deepEqual(titleImageIdsForRun([], {now:'2026-11-07T00:00:00Z',changed,existing,mode:'api',env:{WOEK_NEWS_ONLY:'true'},queue}),['new']);
 assert.equal(queueCalls,0);
 assert.deepEqual(titleImageIdsForRun([], {now:'2026-11-07T00:00:00Z',changed,existing,mode:'api',env:{},queue}),['old','new','pending']);
 assert.equal(queueCalls,1);
});

test('news-only commit excludes the disabled survey synchronization paths',()=>{
 const line=workflow.split('\n').find(line=>line.trimStart().startsWith('git add -- data/news'));
 assert.ok(line);assert.doesNotMatch(line,/content\/polls\/public-catalog\.json|\bumfragen\b/);
});

test('news-only keeps the existing transport guard and does not mandate an additional review',()=>{
 assert.throws(()=>assertAutomaticImpactTransport(false),e=>e.message==='IMPACT_API_REVIEW_TRANSPORT_UNAVAILABLE' && e.requestAttempts===0 && e.providerNotCalled===true);
 assert.doesNotThrow(()=>assertAutomaticImpactTransport(true));
 const run=fs.readFileSync(new URL('../../scripts/news/run.mjs',import.meta.url),'utf8');
 assert.ok(run.includes("    assertAutomaticImpactTransport(typeof options.callAiImpl === 'function');"));
 assert.ok(run.includes('releaseDeterministicImpact('));
 assert.ok(!run.includes('NEWS_ONLY_INDEPENDENT_REVIEW_UNAVAILABLE'));
});
