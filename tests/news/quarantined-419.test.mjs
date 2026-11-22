import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {quarantined419, QUARANTINED_419_IDS, restored419Evidence} from '../../scripts/news/quarantined-419.mjs';
import {newsOnlyPriorWorkHold, titleImageIdsForRun, runWirkungsticker} from '../../scripts/news/run.mjs';
import {documentedFailedPaidAttempts, recoverDocumentedFailedPaidUsage, runInterruptedPaidPreflight} from '../../scripts/news/retained-failed-paid-work.mjs';
import {verifyInterruptedPaidRuns, verifyMigratedPaidRuns, interruptedPaidWorkBlocked} from '../../scripts/news/recover-failed-usage.mjs';

const news = {WOEK_NEWS_ONLY:'true', VISUAL_GENERATION_PROVIDER:'disabled'};
const original = {id:41913667334, status:'completed', conclusion:'failure', run_attempt:1,
  created_at:'2026-11-04T21:11:02Z', updated_at:'2026-11-04T21:30:08Z',
  html_url:'https://github.com/sustynats/wirkungsoekonomie.de/actions/runs/41913667334'};
const step = {name:'Import, analyze (one call per story) and build',conclusion:'success',
  started_at:'2026-11-04T21:14:50Z',completed_at:'2026-11-04T21:26:37Z'};
const urls = [
  'https://www.bayern.de/heimat-gestalten-zukunft-schaffen-ministerin-kaniber-foerdert-projekte-in-15-gemeinden-mit-563-millionen-euro',
  'https://www.tagesspiegel.de/berlin/dpa-auf-dem-gehweg-mann-in-berlin-wedding-durch-mehrere-schusse-verletzt-16243071.html',
];
function fakeGh({extra=[]}={}) {
  return args => {
    if (args[0] === 'run') throw Error('OLD_LOG_MUST_NOT_BE_READ');
    if (args[1].includes('/workflows/')) return JSON.stringify({total_count:1+extra.length,workflow_runs:[...extra,original]});
    if (args[1].includes('/41913667334/jobs?')) return JSON.stringify({total_count:1,jobs:[{id:1,run_id:41913667334,steps:[step]}]});
    throw Error('UNEXPECTED_SYNTHETIC_API');
  };
}
function check(usage, {allow=true, extra=[], documented=documentedFailedPaidAttempts}={}) {
  return verifyInterruptedPaidRuns({usage,now:'2026-11-07T13:00:00Z',runId:100,
    historicalOnly:true,repository:'sustynats/wirkungsoekonomie.de',allowQuarantined419:allow,
    documentedAttempts:documented,gh:fakeGh({extra})});
}

test('both IDs and same original path with tracking or arbitrary query stay held under new story IDs',()=>{
  for (let i=0; i<2; i++) {
    assert.equal(quarantined419({story_id:QUARANTINED_419_IDS[i]},news),true);
    for (const suffix of ['?utm_source=fixture#fragment','?newsletter=fixture&campaign=other']) {
      const candidate={story_id:'wt-new-identity',sources:[{url:urls[i]+suffix}]};
      assert.equal(quarantined419(candidate,news),true);
      assert.equal(newsOnlyPriorWorkHold(candidate,news),true);
      assert.deepEqual(titleImageIdsForRun([candidate],{now:'2026-11-07T13:00:00Z',
        changed:new Set(['wt-new-identity']),existing:new Set(),mode:'api',env:news}),[]);
    }
    for (const alias of [urls[i].replace('https://www.','https://'), urls[i].replace('https://www.','http://')]) {
      assert.equal(quarantined419({story_id:'new',sources:[{url:alias+'?ref=fixture'}]},news),true);
    }
  }
  assert.equal(quarantined419({story_id:'new',sources:[{url:'https://example.org/unrelated'}]},news),false);
  assert.equal(quarantined419({story_id:'new',sources:[{url:urls[0].replace('www.bayern.de','other.example.org')}]},news),false);
});

test('actual news worker holds a new ID with the same original URL before any AI call',async t=>{
  for (const [key,value] of Object.entries({...news,WIRKUNGSTICKER_PROCESSING_MODE:'api',WOEK_NEWS_AI_ENABLED:'true'})) {
    const prior=process.env[key];process.env[key]=value;
    t.after(()=>prior===undefined ? delete process.env[key] : process.env[key]=prior);
  }
  const now='2026-11-07T13:00:00.000Z';
  const source={source_id:'test',publisher_id:'test',name:'Test',url:'https://example.org/',
    feed_url:'https://example.org/rss',enabled:true,source_type:'official_rss',primary_source:true,
    access:{status:'public',article:'metadata_only',cost_usd:0},frequency_class:'high_frequency'};
  const item={source_id:'test',publisher_id:'test',publisher:'Test',url:urls[0]+'?utm_source=fixture',
    title:'Bund beschließt synthetisches Klimagesetz zur Energieversorgung',
    summary:'Neue verbindliche Regeln verändern Investitionen in Energie und Infrastruktur. Die zuständige Behörde erläutert die geplanten Maßnahmen an öffentlichen Gebäuden und nennt die beteiligten Einrichtungen sowie den vorgesehenen Beginn im kommenden Jahr.',
    primary_source:true,published_at:now};
  const story={story_id:'wt-new-identity',slug:'fixture',title:item.title,published:false,listed:true,
    first_seen:now,last_updated:now,sources:[item],fresh:true,versions:[],pending_reason:'AI_BUDGET_OR_BATCH_LIMIT'};
  let calls=0,saved;
  const input={dryRun:true,now,registry:{schema_version:'1.0',sources:[source],policy:{}},
    state:{source_status:{},seen_items:{},pending_story_ids:[],relevance_filter_version:'4.0'},
    storyStore:{stories:[story]},usage:{runs:[]},newsroom:{source_items:{},events:{},event_sources:{},discovery_candidates:[],decisions:[]},
    budgetFx:{rate_date:'2026-11-07',rate_usd_per_eur:1.16},
    fetchFeedImpl:async()=>({not_modified:true,final_url:source.feed_url}),
    fetchArticleImpl:async()=>{throw Error('network forbidden');},aiBatchDelayImpl:async()=>{},
    callAiImpl:async()=>{calls++;throw Object.assign(Error('synthetic'),{requestAttempts:0});},captureState:value=>saved=value};
  const result=await runWirkungsticker(input);
  assert.equal(calls,0);assert.equal(result.ai_calls,0);assert.equal(result.published_stories,0);
  assert.deepEqual(saved.storyStore.stories.find(row=>row.story_id===story.story_id),story);
  const control=structuredClone(story);control.sources[0].url='https://example.org/klimagesetz';
  await runWirkungsticker({...input,storyStore:{stories:[control]}});
  assert.equal(calls,1,'the same synthetic candidate without the quarantined source reaches AI selection');
});

test('exact 419 visual remains explicitly unresolved and cannot become a durable checked run',()=>{
  const usage={runs:[]}; const guard=check(usage);
  assert.equal(guard.status,'checked');
  assert.deepEqual(guard.quarantined_visual_run_ids,[41913667334]);
  assert.deepEqual(guard.unresolved_run_ids,[41913667334]);
  assert.equal(guard.unresolved_reasons[41913667334],'PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING');
  assert.equal(guard.checked_runs.some(r=>r.run_id===41913667334),false);
  assert.equal(interruptedPaidWorkBlocked(guard,{allowQuarantined419:false}),true);
  assert.equal(interruptedPaidWorkBlocked(guard,{allowQuarantined419:true}),false);
  assert.equal(check(usage,{allow:false}).status,'open');
  assert.equal(usage.runs.filter(r=>r.recovery?.github_run_id===41913667334).length,1);
});

test('migrated dual-repository guard retains the scoped hold and blocks when scope changes',t=>{
  const modern='sustynats/wirkungsoekonomie-produktiv';
  const current={id:200,status:'in_progress',conclusion:null,run_attempt:1,
    created_at:'2026-11-07T12:58:00Z',updated_at:'2026-11-07T12:58:00Z'};
  const gh=args=>{
    if(args[0]!=='api')throw Error('OLD_LOG_MUST_NOT_BE_READ');
    const url=new URL('https://api.github.com/'+args[1]);
    const isNew=url.pathname.includes('/wirkungsoekonomie-produktiv/');
    const status=url.searchParams.get('status');
    if(status){const rows=isNew&&url.pathname.includes('wirkungsticker.yml/')&&status==='in_progress'?[current]:[];
      return JSON.stringify({total_count:rows.length,workflow_runs:rows});}
    if(url.pathname.includes('/actions/workflows/')){const rows=isNew?[current]:[original];
      return JSON.stringify({total_count:rows.length,workflow_runs:rows});}
    if(url.pathname.includes('/41913667334/jobs'))return JSON.stringify({total_count:1,jobs:[{id:1,run_id:original.id,steps:[step]}]});
    if(url.pathname.endsWith('/actions/runs/41913667334'))return JSON.stringify(original);
    throw Error('UNEXPECTED_SYNTHETIC_API');
  };
  const usage={runs:[]};
  const opts={usage,now:'2026-11-07T13:00:00Z',runId:200,runAttempt:1,documentedAttempts:documentedFailedPaidAttempts,gh};
  const scoped=verifyMigratedPaidRuns({...opts,allowQuarantined419:true});
  assert.equal(scoped.status,'checked');assert.deepEqual(scoped.quarantined_visual_run_ids,[41913667334]);
  assert.equal(interruptedPaidWorkBlocked(scoped,{requireCurrentRun:true,runId:200,runAttempt:1,repository:modern,allowQuarantined419:true}),false);
  assert.equal(interruptedPaidWorkBlocked(scoped,{requireCurrentRun:true,runId:200,runAttempt:1,repository:modern}),true);
  const other=verifyMigratedPaidRuns({...opts,allowQuarantined419:false});
  assert.equal(other.status,'open');assert.equal(other.unresolved_reasons[41913667334],'PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'woek-419-report-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data/news'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/news/usage.json'),JSON.stringify({runs:[]}));
  const output=runInterruptedPaidPreflight({root,now:opts.now,gh,write:false,
    env:{...news,GITHUB_REPOSITORY:modern,GITHUB_RUN_ID:'200',GITHUB_RUN_ATTEMPT:'1'}});
  assert.deepEqual(output.quarantined_visual_run_ids,[41913667334]);
  assert.equal(output.unresolved_reasons[41913667334],'PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING');
});

test('missing one input receipt, other active runs, and changed native binding remain globally blocked',()=>{
  assert.equal(check({runs:[]},{documented:id=>id===QUARANTINED_419_IDS[0]?[]:documentedFailedPaidAttempts(id)}).unresolved_reasons[41913667334], 'PAID_PREFLIGHT_INPUT_RECEIPT_MISSING');
  const other={id:999, status:'in_progress',conclusion:null,run_attempt:1,
    created_at:'2026-11-06T00:00:00Z',updated_at:'2026-11-06T00:00:01Z'};
  const g=check({runs:[]},{extra:[other]});
  assert.equal(g.status,'open');assert.equal(g.unresolved_reasons[999],'PAID_PREFLIGHT_HISTORICAL_RUN_ACTIVE');
  assert.throws(()=>restored419Evidence({...original,updated_at:'2026-11-04T21:30:09Z'},step),/BINDING_INVALID/);
});

test('recovered 419 cost is retained once without claiming publication or guessing an image',()=>{
  const usage={runs:[]};recoverDocumentedFailedPaidUsage(usage,'2026-11-07T13:00:00Z');
  recoverDocumentedFailedPaidUsage(usage,'2026-11-07T13:00:01Z');
  const rows=usage.runs.filter(r=>r.recovery?.github_run_id===41913667334);
  assert.equal(rows.length,1);assert.equal(rows[0].ai.estimated_cost_usd,0.024027);
  assert.equal(rows[0].recovery.publication_committed,false);
  assert.equal(documentedFailedPaidAttempts(QUARANTINED_419_IDS[0])[0].recovery.retained_visual_source_sha256,undefined);
});
