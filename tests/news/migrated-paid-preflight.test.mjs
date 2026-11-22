import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyMigratedPaidRuns, verifyInterruptedPaidRuns, interruptedPaidWorkBlocked,
  LEGACY_PAID_REPOSITORY as old, NEW_PAID_REPOSITORY as modern} from '../../scripts/news/recover-failed-usage.mjs';
import {runInterruptedPaidPreflight} from '../../scripts/news/retained-failed-paid-work.mjs';

const now='2026-11-06T02:00:00Z';
const current={id:20,run_attempt:1,status:'in_progress',conclusion:null,created_at:'2026-11-06T01:58:00Z',updated_at:'2026-11-06T01:58:00Z'};
const queued={id:5,run_attempt:1,status:'queued',conclusion:null,created_at:'2026-09-13T08:50:00Z',updated_at:'2026-09-13T08:50:00Z'};
const complete={id:9,run_attempt:1,status:'completed',conclusion:'success',created_at:'2026-11-05T22:00:00Z',updated_at:'2026-11-05T22:10:00Z'};
function harness({oldRows=[],newRows=[current],active=[],deny=null,omitCurrent=false,truncate=false}={}) {
  const calls=[];
  const gh=args=>{
    calls.push(args);
    if(args[0]!=='api') throw Error('unexpected log request');
    const url=new URL(`https://api.github.com/${args[1]}`);
    if(deny && url.pathname.includes(deny)) throw Error('private network detail');
    const repo=url.pathname.includes('/wirkungsoekonomie-produktiv/') ? modern : old;
    const rows=repo===old ? oldRows : newRows;
    const status=url.searchParams.get('status');
    if(status){
      const list=[...active.filter(a=>a.repo===repo&&url.pathname.includes(a.workflow)&&a.row.status===status).map(a=>a.row),
        ...(repo===modern && url.pathname.includes('wirkungsticker.yml/') && status==='in_progress' && !omitCurrent ? [current] : [])];
      return JSON.stringify({total_count:truncate ? list.length+1:list.length,workflow_runs:list});
    }
    if(url.pathname.includes('/actions/workflows/'))return JSON.stringify({total_count:rows.length,workflow_runs:rows});
    const id=Number(url.pathname.split('/').at(-1));
    const found=rows.find(row=>row.id===id);
    if(!found)throw Error('not found');
    return JSON.stringify(found);
  };
  return {gh,calls};
}
const run=(usage,h)=>verifyMigratedPaidRuns({usage,now,runId:20,runAttempt:1,gh:h.gh});
const blocked=guard=>interruptedPaidWorkBlocked(guard,{requireCurrentRun:true,runId:20,runAttempt:1,repository:modern});

test('both exact repositories and current active run are required for a migrated checked ledger',()=>{
  const usage={runs:[]},h=harness({oldRows:[complete]});
  const result=run(usage,h);
  assert.equal(result.status,'checked');assert.equal(blocked(result),false);
  assert.equal(result.repository_guards[old].checked_for_repository,old);
  assert.equal(result.repository_guards[modern].checked_for_repository,modern);
  assert.ok(h.calls.some(a=>a[1].includes(`repos/${old}/actions/workflows/`)));
  assert.ok(h.calls.some(a=>a[1].includes(`repos/${modern}/actions/workflows/`)));
  assert.equal(run(usage,h).status,'checked');
});
test('an old queued ticker or discovery run blocks even if it predates the scan window',()=>{
  for(const workflow of ['wirkungsticker.yml','wirkungsticker-discovery.yml']){
    const h=harness({active:[{repo:old,workflow,row:queued}]});
    const result=run({runs:[]},h);
    assert.equal(result.status,'open');assert.equal(result.verification_error,'PAID_PREFLIGHT_OTHER_RUN_ACTIVE');
    assert.equal(blocked(result),true);
  }
});
test('a new discovery run or another new ticker run blocks paid work',()=>{
  for(const workflow of ['wirkungsticker.yml','wirkungsticker-discovery.yml']){
    const h=harness({active:[{repo:modern,workflow,row:queued}]});
    assert.equal(blocked(run({runs:[]},h)),true);
  }
});
test('missing access, truncated active results or absent current run fail closed',()=>{
  for(const h of [harness({deny:`repos/${old}/`}),harness({truncate:true}),harness({omitCurrent:true})]){
    const result=run({runs:[]},h);assert.equal(result.status,'open');assert.equal(blocked(result),true);
    assert.doesNotMatch(JSON.stringify(result),/private network detail/);
  }
});
test('an invalid or incomplete migrated ledger cannot be treated as an old valid ledger',()=>{
  const h=harness();
  assert.throws(()=>run({runs:[],failed_run_recovery:{interrupted_guard:{repository_guards:{[old]:{}}}}},h),{message:'PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID'});
  assert.throws(()=>verifyInterruptedPaidRuns({usage:{runs:[]},now,runId:20,repository:'attacker/repo',gh:h.gh}),{message:'PAID_PREFLIGHT_REPOSITORY_INVALID'});
  assert.throws(()=>run({runs:[],failed_run_recovery:{interrupted_guard:{version:'unknown',status:'checked'}}},h),{message:'PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID'});
  assert.throws(()=>run({runs:[],failed_run_recovery:{interrupted_guard:{version:'interrupted-paid-1',status:'checked',checked_for_repository:modern}}},h),{message:'PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID'});
  assert.equal(interruptedPaidWorkBlocked({version:'interrupted-paid-1',status:'checked',checked_for_run_id:'20',checked_for_run_attempt:1},{requireCurrentRun:true,runId:20,runAttempt:1,repository:modern}),true);
});
test('old active run discovered in the historical ledger stays unresolved',()=>{
  const h=harness({oldRows:[{...queued,created_at:'2026-11-05T22:00:00Z',updated_at:'2026-11-05T22:00:00Z'}]});
  const result=run({runs:[]},h);
  assert.equal(result.repository_guards[old].status,'open');assert.ok(result.unresolved_run_ids.includes(5));
  assert.equal(blocked(result),true);
});
test('the real preflight entry point binds and persists both repository ledgers',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'woek-paid-scope-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'data/news');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'usage.json');fs.writeFileSync(file,JSON.stringify({runs:[]}));
  const h=harness();
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:modern,GITHUB_RUN_ID:'20',GITHUB_RUN_ATTEMPT:'1'};
  const result=runInterruptedPaidPreflight({root,now,env,gh:h.gh});
  assert.equal(result.status,'checked');
  const saved=JSON.parse(fs.readFileSync(file,'utf8')).failed_run_recovery.interrupted_guard;
  assert.equal(blocked(saved),false);
  assert.equal(saved.repository_guards[old].checked_for_repository,old);
  assert.equal(saved.repository_guards[modern].checked_for_repository,modern);
  assert.throws(()=>runInterruptedPaidPreflight({root,now,env:{...env,GITHUB_REPOSITORY:''},gh:h.gh}),{message:'PAID_PREFLIGHT_REPOSITORY_INVALID'});
});
test('a completed new-repository failure reads its own job and log without charging a zero-request report',()=>{
  const failed={...complete,conclusion:'failure'};
  const native='Import, analyze (one call per story) and build';
  const report={schema_version:'1.2',run_id:'9',started_at:'2026-11-05T22:01:00Z',completed_at:'2026-11-05T22:02:00Z',
    ai_calls:0,ai_request_attempts:0,input_tokens:0,output_tokens:0,estimated_cost_usd:0,title_images:[]};
  const log=JSON.stringify(report,null,2).split('\n').map(line=>`job\t${native}\t2026-11-05T22:02:00Z ${line}`).join('\n');
  const calls=[];
  const gh=args=>{calls.push(args);if(args[0]==='run')return log;
    if(args[1].includes('/jobs?'))return JSON.stringify({total_count:1,jobs:[{id:1,run_id:9,steps:[{name:native,conclusion:'success'}]}]});
    if(args[1].includes('/actions/workflows/'))return JSON.stringify({total_count:2,workflow_runs:[current,failed]});
    throw Error('unexpected');};
  const usage={runs:[]};
  const guard=verifyInterruptedPaidRuns({usage,now,runId:20,repository:modern,previousGuard:null,gh});
  assert.equal(guard.status,'checked');assert.deepEqual(usage.runs,[]);
  assert.ok(calls.some(a=>a[0]==='run'&&a[3]==='--repo'&&a[4]===modern));
  assert.ok(calls.some(a=>a[1]?.includes(`repos/${modern}/actions/runs/9/jobs`)));
});
test('the migrated preflight command exits nonzero before later workflow steps when reads fail',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'woek-paid-cli-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  fs.cpSync(path.join(source,'scripts/news'),path.join(root,'scripts/news'),{recursive:true});
  fs.cpSync(path.join(source,'scripts/lib'),path.join(root,'scripts/lib'),{recursive:true});
  fs.copyFileSync(path.join(source,'package.json'),path.join(root,'package.json'));
  const data=path.join(root,'data/news');fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'usage.json'),JSON.stringify({runs:[]}));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gh'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  const env={PATH:bin,GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:modern,GITHUB_RUN_ID:'20',GITHUB_RUN_ATTEMPT:'1'};
  const child=spawnSync(process.execPath,[path.join(root,'scripts/news/retained-failed-paid-work.mjs'),'--preflight'],{env,encoding:'utf8'});
  assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).status,'open');
  const saved=JSON.parse(fs.readFileSync(path.join(data,'usage.json'),'utf8')).failed_run_recovery.interrupted_guard;
  assert.equal(saved.status,'open');assert.equal(blocked(saved),true);
});
