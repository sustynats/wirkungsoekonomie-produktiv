import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {committedPaidRunEvidence, COMMITTED_PAID_SOURCE} from '../../scripts/news/committed-paid-run-evidence.mjs';
import {verifyInterruptedPaidRuns, NEW_PAID_REPOSITORY, LEGACY_PAID_REPOSITORY} from '../../scripts/news/recover-failed-usage.mjs';
import {originalRun, originalJob} from '../fixtures/news/committed-paid-run-43093046835.mjs';

const originalUsage = JSON.parse(fs.readFileSync(new URL('../fixtures/news/committed-paid-run-43093046835.usage.json', import.meta.url), 'utf8'));
const current = {id: 99000000001, run_attempt:1, status:'in_progress', conclusion:null,
  created_at:'2026-11-19T15:00:00Z', updated_at:'2026-11-19T15:00:01Z'};
const now = '2026-11-19T15:30:00Z';
function verify({run=structuredClone(originalRun), job=structuredClone(originalJob), rows=[structuredClone(originalUsage)], repository=NEW_PAID_REPOSITORY} = {}) {
  const usage={runs:rows}; const before=JSON.stringify(usage.runs); const requests=[];
  const gh=args=>{
    requests.push(args);
    if(args[0]==='api' && args[1].includes('/workflows/')) return JSON.stringify({total_count:2,workflow_runs:[current,run]});
    if(args[0]==='api' && args[1].endsWith(`/runs/${run.id}/jobs?per_page=100`)) return JSON.stringify({total_count:1,jobs:[job]});
    if(args[0]==='run') throw Object.assign(Error('Synthetic historical log transport unavailable'),{code:'ETIMEDOUT'});
    throw Error('Unexpected mocked request');
  };
  const guard=verifyInterruptedPaidRuns({usage,now,runId:current.id,repository,gh});
  assert.equal(JSON.stringify(usage.runs),before,'verification must neither rebill nor rewrite usage');
  assert.equal(guard.provider_called,false);
  return {guard,requests,usage};
}

test('exact committed receipt replaces unavailable log transport without changing charges',()=>{
  const {guard,requests}=verify();
  assert.equal(guard.status,'checked'); assert.deepEqual(guard.unresolved_run_ids,[]);
  assert.equal(guard.recovered_runs,0); assert.equal(requests.length,2);
  assert.ok(requests.every(args=>args[0]==='api'));
  assert.ok(guard.checked_runs.some(row=>row.run_id===originalRun.id && row.attempt===1));
});

test('original failure counters and deferred visuals survive; no provider-start events are invented',()=>{
  const usage={runs:[structuredClone(originalUsage)]};
  const receipt=committedPaidRunEvidence(originalRun,[originalJob],usage,NEW_PAID_REPOSITORY);
  assert.equal(receipt.report.ai_calls,4); assert.equal(receipt.report.ai_request_attempts,3);
  assert.equal(receipt.report.ai_failed_calls,1); assert.equal(receipt.report.ai_repair_calls,0);
  assert.equal(receipt.report.token_source,'includes_reported_output_failure_usage');
  assert.equal(receipt.report.estimated_cost_usd,0.441369);
  assert.deepEqual(receipt.report.title_images.map(x=>[x.status,x.higgsfield_called]),[['deferred',false],['deferred',false]]);
  assert.equal(Object.hasOwn(receipt,'providerEvents'),false);
  assert.equal(receipt.source.report_sha256,COMMITTED_PAID_SOURCE.report_sha256);
  receipt.report.title_images[0].higgsfield_called=true;
  assert.equal(committedPaidRunEvidence(originalRun,[originalJob],usage,NEW_PAID_REPOSITORY).report.title_images[0].higgsfield_called,false);
});

test('different run identity, attempt, source or terminal metadata cannot borrow the receipt',()=>{
  for(const [key,value] of Object.entries({run_attempt:2,head_sha:'f'.repeat(40),head_branch:'other',path:'.github/workflows/other.yml',created_at:'2026-11-11T20:04:24Z',updated_at:'2026-11-11T21:01:49Z',conclusion:'failure'})) {
    const run={...structuredClone(originalRun),[key]:value};
    const {guard,requests}=verify({run});
    assert.equal(guard.status,'open',key); assert.deepEqual(guard.unresolved_run_ids,[originalRun.id]);
    assert.equal(requests.filter(args=>args[0]==='run').length,0,key);
  }
  const run={...structuredClone(originalRun),repository:{full_name:LEGACY_PAID_REPOSITORY}};
  assert.equal(verify({run}).guard.unresolved_reasons[run.id],'PAID_PREFLIGHT_COMMITTED_RUN_BINDING_INVALID');
});

test('successful native completion and atomic commit are mandatory, with exact boundaries',()=>{
  const variants=[job=>job.id++,job=>job.head_sha='f'.repeat(40),job=>job.run_attempt=2,
    job=>job.steps.pop(),job=>job.steps.push({...job.steps[1]}),job=>job.steps[0].conclusion='failure',
    job=>job.steps[1].conclusion='failure',job=>job.steps[1].completed_at='2026-11-11T20:35:29Z',
    job=>job.steps[0].started_at='2026-11-11T20:11:37Z'];
  for(const mutate of variants){const job=structuredClone(originalJob);mutate(job);const {guard,requests}=verify({job});
    assert.equal(guard.status,'open');assert.equal(guard.unresolved_reasons[originalRun.id],'PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID');
    assert.equal(requests.filter(args=>args[0]==='run').length,0);
  }
});

test('missing, ambiguous or altered canonical usage fails closed, including non-accounting fields',()=>{
  const variants=[[],[structuredClone(originalUsage),structuredClone(originalUsage)]];
  for(const mutate of [row=>row.ai.requests=3,row=>row.ai.estimated_cost_usd=0,row=>row.counts.ai_request_attempts=4,
    row=>row.counts.ai_failed_calls=0,row=>row.queue.status='changed',row=>row.recovery={publication_committed:true}]){
    const row=structuredClone(originalUsage);mutate(row);variants.push([row]);
  }
  for(const rows of variants){const {guard,requests}=verify({rows});assert.equal(guard.status,'open');
    assert.equal(guard.unresolved_reasons[originalRun.id],'PAID_PREFLIGHT_COMMITTED_USAGE_BINDING_INVALID');
    assert.equal(requests.filter(args=>args[0]==='run').length,0);
  }
});

test('unknown runs and the other repository keep their original fail-closed log path',()=>{
  const run={...structuredClone(originalRun),id:43093046836};
  const job={...structuredClone(originalJob),run_id:run.id};
  const result=verify({run,job});assert.equal(result.guard.status,'open');
  assert.equal(result.guard.unresolved_reasons[run.id],'PAID_PREFLIGHT_READ_UNAVAILABLE');
  assert.equal(result.requests.filter(args=>args[0]==='run').length,1);
  assert.equal(committedPaidRunEvidence(run,[job],{runs:[originalUsage]},NEW_PAID_REPOSITORY),null);
  const legacy=verify({repository:LEGACY_PAID_REPOSITORY});assert.equal(legacy.guard.status,'open');
  assert.equal(legacy.requests.filter(args=>args[0]==='run').length,1);
});

test('known paid run cannot fall through the generic never-started shortcut',()=>{
  for(const mutate of [job=>job.steps[0].conclusion='skipped',job=>job.conclusion='skipped']){
    const job=structuredClone(originalJob);mutate(job);const {guard,requests}=verify({job});
    assert.equal(guard.status,'open');assert.equal(guard.unresolved_reasons[originalRun.id],'PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID');
    assert.equal(requests.filter(args=>args[0]==='run').length,0);
  }
  const usage={runs:[structuredClone(originalUsage)]};
  assert.throws(()=>committedPaidRunEvidence(originalRun,[],usage,NEW_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID/);
});
