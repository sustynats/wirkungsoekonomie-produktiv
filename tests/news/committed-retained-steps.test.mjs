import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {committedPaidRunEvidence, COMMITTED_PAID_SOURCE} from '../../scripts/news/committed-paid-run-evidence.mjs';
import {verifyInterruptedPaidRuns, NEW_PAID_REPOSITORY, LEGACY_PAID_REPOSITORY} from '../../scripts/news/recover-failed-usage.mjs';
import {unresolvedProviderRequest} from '../../scripts/news/provider-outcome.mjs';
import {originalRun, originalJob} from '../fixtures/news/committed-paid-run-43093046835.mjs';

const originalUsage = JSON.parse(fs.readFileSync(new URL('../fixtures/news/committed-paid-run-43093046835.usage.json', import.meta.url), 'utf8'));
const archivedJobsSha = '75d85962d77176d13addc2b4c84d37a2b4d4f2f55f41758a2f8f0738e8305499';
const emptyJob = () => ({...structuredClone(originalJob), steps:[]});
const usage = () => ({runs:[structuredClone(originalUsage)]});
const current = {id:99000000001,run_attempt:1,status:'in_progress',conclusion:null,
  created_at:'2026-11-20T04:00:00Z',updated_at:'2026-11-20T04:00:01Z'};
function verify({run=structuredClone(originalRun),job=emptyJob(),rows=[structuredClone(originalUsage)],repository=NEW_PAID_REPOSITORY,documentedAttempts=()=>[]}={}) {
  const value={runs:rows}, requests=[];
  const before=JSON.stringify({run,job,rows});
  const gh=args=>{
    requests.push(args);
    if(args[0]==='api' && args[1].includes('/workflows/')) return JSON.stringify({total_count:2,workflow_runs:[current,run]});
    if(args[0]==='api' && args[1].endsWith(`/runs/${run.id}/jobs?per_page=100`)) return JSON.stringify({total_count:1,jobs:[job]});
    throw Error('UNEXPECTED_EXTERNAL_REQUEST');
  };
  const guard=verifyInterruptedPaidRuns({usage:value,runId:current.id,now:'2026-11-20T04:30:00Z',repository,documentedAttempts,gh});
  assert.equal(JSON.stringify({run,job,rows}),before,'live metadata and original usage must stay unchanged');
  assert.equal(guard.provider_called,false);
  assert.equal(guard.recovered_runs,0);
  assert.equal(requests.filter(args=>args[0]==='run').length,0,'no log request is permitted');
  assert.equal(requests.length,2,'only workflow-list and job metadata reads are permitted');
  return {guard,value,requests};
}

test('exact empty step array uses the original archived fields with explicit provenance',()=>{
  const job=emptyJob(), state=usage(), before=JSON.stringify({job,state});
  const receipt=committedPaidRunEvidence(originalRun,[job],state,NEW_PAID_REPOSITORY);
  assert.deepEqual(receipt.nativeStep,originalJob.steps[0]);
  assert.deepEqual(receipt.stepEvidence,{kind:'retained_original_job_steps',original_jobs_sha256:archivedJobsSha});
  assert.deepEqual(receipt.source,COMMITTED_PAID_SOURCE);
  assert.equal(Object.hasOwn(receipt,'providerEvents'),false);
  assert.equal(JSON.stringify({job,state}),before);
  receipt.nativeStep.conclusion='failure'; receipt.stepEvidence.original_jobs_sha256='f'.repeat(64);
  const again=committedPaidRunEvidence(originalRun,[job],state,NEW_PAID_REPOSITORY);
  assert.equal(again.nativeStep.conclusion,'success'); assert.equal(again.stepEvidence.original_jobs_sha256,archivedJobsSha);
});

test('fake-gh guard accepts the bound empty array without logs, rebilling, or releasing unknown inputs',()=>{
  // Synthetic input-state fixtures exercise the existing hold API; no answer
  // or provider-start event is reconstructed from the accounting receipt.
  const unknown={story_id:'synthetic-unknown',content_hash:'a'.repeat(64),pending_reason:'AI_PROVIDER_OUTCOME_UNKNOWN',
    provider_request_hold:{status:'unknown',run_id:String(originalRun.id),request_attempts:1,
      raw_response:'not_confirmed',recorded_pending_hash:'a'.repeat(64)}};
  const quality={story_id:'synthetic-quality',pending_reason:'QUALITY_GATE_FAILED',
    ai_retry_history:[{fingerprint:'b'.repeat(64),evidence_fingerprint:'c'.repeat(64),retry_count:1}]};
  const before=JSON.stringify({unknown,quality}); let receiptReads=0;
  assert.equal(unresolvedProviderRequest(unknown),unknown.provider_request_hold);
  const {guard}=verify({documentedAttempts:id=>{receiptReads++;return id===quality.story_id?quality.ai_retry_history:[];}});
  assert.equal(guard.status,'checked');assert.deepEqual(guard.unresolved_run_ids,[]);
  assert.ok(guard.checked_runs.some(row=>row.run_id===originalRun.id && row.attempt===1));
  assert.equal(receiptReads,0,'archival accounting must not invent or replay input attempts');
  assert.equal(JSON.stringify({unknown,quality}),before);
  assert.equal(unresolvedProviderRequest(unknown),unknown.provider_request_hold);
  const report=committedPaidRunEvidence(originalRun,[emptyJob()],usage(),NEW_PAID_REPOSITORY).report;
  assert.deepEqual([report.ai_calls,report.ai_request_attempts,report.ai_failed_calls,report.ai_repair_calls],[4,3,1,0]);
  assert.equal(report.estimated_cost_usd,originalUsage.ai.estimated_cost_usd);
});

test('every exact run binding remains mandatory with an empty step array',()=>{
  const changes={run_attempt:2,status:'in_progress',conclusion:'failure',head_sha:'f'.repeat(40),
    head_branch:'other',path:'.github/workflows/other.yml',created_at:'2026-11-11T20:04:24Z',
    updated_at:'2026-11-11T21:01:49Z',repository:{full_name:LEGACY_PAID_REPOSITORY}};
  for(const [key,value] of Object.entries(changes)) {
    const run={...structuredClone(originalRun),[key]:value};
    assert.throws(()=>committedPaidRunEvidence(run,[emptyJob()],usage(),NEW_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_RUN_BINDING_INVALID/,key);
  }
  assert.throws(()=>committedPaidRunEvidence(originalRun,[emptyJob()],usage(),LEGACY_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_RUN_BINDING_INVALID/);
});

test('every exact live job binding remains mandatory before archived steps can be used',()=>{
  const changes={id:130774763727,run_id:43093046836,run_attempt:2,head_sha:'f'.repeat(40),status:'in_progress',
    conclusion:'skipped',started_at:'2026-11-11T20:04:29Z',completed_at:'2026-11-11T20:49:29Z'};
  for(const [key,value] of Object.entries(changes)) {
    const job={...emptyJob(),[key]:value};
    assert.throws(()=>committedPaidRunEvidence(originalRun,[job],usage(),NEW_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID/,key);
  }
  for(const jobs of [[],[emptyJob(),emptyJob()]]) assert.throws(()=>committedPaidRunEvidence(originalRun,jobs,usage(),NEW_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID/);
});

test('missing, duplicated, or altered usage cannot be repaired by archived steps',()=>{
  const variants=[[],[structuredClone(originalUsage),structuredClone(originalUsage)]];
  for(const mutate of [row=>row.ai.requests=3,row=>row.ai.estimated_cost_usd=0,row=>row.counts.ai_request_attempts=4,
    row=>row.counts.ai_failed_calls=0,row=>row.queue.status='changed',row=>row.recovery={publication_committed:true}]) {
    const row=structuredClone(originalUsage);mutate(row);variants.push([row]);
  }
  for(const rows of variants) {
    const {guard}=verify({rows}); assert.equal(guard.status,'open');
    assert.equal(guard.unresolved_reasons[originalRun.id],'PAID_PREFLIGHT_COMMITTED_USAGE_BINDING_INVALID');
  }
});

test('nonempty conflicting and malformed live steps are never replaced with archived steps',()=>{
  const variants=[null,undefined,{},'[]',[null],[{}],[structuredClone(originalJob.steps[0])],
    originalJob.steps.map(step=>({...step,name:'renamed'})),
    originalJob.steps.map(step=>({...step,conclusion:'failure'})),
    [...structuredClone(originalJob.steps),structuredClone(originalJob.steps[1])]];
  for(const steps of variants) {
    const job={...emptyJob(),steps};
    assert.throws(()=>committedPaidRunEvidence(originalRun,[job],usage(),NEW_PAID_REPOSITORY));
    assert.equal(verify({job}).guard.status,'open');
  }
  const job=emptyJob();delete job.steps;
  assert.throws(()=>committedPaidRunEvidence(originalRun,[job],usage(),NEW_PAID_REPOSITORY),/PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID/);
  assert.equal(verify({job}).guard.status,'open');
});

test('other runs and repositories cannot borrow archived steps from the bound run',()=>{
  const run={...structuredClone(originalRun),id:43093046836};
  const job={...emptyJob(),run_id:run.id};
  assert.equal(committedPaidRunEvidence(run,[job],usage(),NEW_PAID_REPOSITORY),null);
  const other=verify({run,job});assert.equal(other.guard.status,'open');
  assert.equal(other.guard.unresolved_reasons[run.id],'PAID_PREFLIGHT_NATIVE_STEP_UNKNOWN');
  const legacy=verify({repository:LEGACY_PAID_REPOSITORY});assert.equal(legacy.guard.status,'open');
  assert.equal(legacy.guard.unresolved_reasons[originalRun.id],'PAID_PREFLIGHT_NATIVE_STEP_UNKNOWN');
});

test('present original steps keep their original path and never acquire archival provenance',()=>{
  const job=structuredClone(originalJob);
  const receipt=committedPaidRunEvidence(originalRun,[job],usage(),NEW_PAID_REPOSITORY);
  assert.equal(Object.hasOwn(receipt,'nativeStep'),false);
  assert.equal(Object.hasOwn(receipt,'stepEvidence'),false);
  assert.equal(verify({job}).guard.status,'checked');
});
