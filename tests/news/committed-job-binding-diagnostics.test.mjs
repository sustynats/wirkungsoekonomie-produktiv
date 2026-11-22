import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {committedPaidRunEvidence} from '../../scripts/news/committed-paid-run-evidence.mjs';
import {paidPreflightDiagnostic, observePaidPreflightFailure} from '../../scripts/news/paid-preflight-diagnostics.mjs';
import {originalRun, originalJob} from '../fixtures/news/committed-paid-run-43093046835.mjs';

const row=JSON.parse(fs.readFileSync(new URL('../fixtures/news/committed-paid-run-43093046835.usage.json',import.meta.url),'utf8'));
const repository='sustynats/wirkungsoekonomie-produktiv';
const context={repository,operation:'interrupted_run',phase:'guard',run_id:43093046835};
const secret='DO_NOT_LEAK_PRIVATE_TOKEN_OR_PAID_TEXT';
const assertPrivate=value=>assert.ok(!JSON.stringify(value).includes(secret));
function reject(jobs,{run=originalRun,usage={runs:[structuredClone(row)]}}={}) {
  let error;
  try { committedPaidRunEvidence(run,jobs,usage,repository); } catch(caught) {error=caught;}
  assert.ok(error instanceof Error);
  const diagnostic=paidPreflightDiagnostic(error,context);
  assertPrivate(diagnostic);
  return {error,diagnostic};
}
const mismatch=(diagnostic,field)=>diagnostic.committed_job_binding.mismatches.find(item=>item.field===field);

test('unchanged source-bound metadata still accepts exactly the same committed receipt',()=>{
  const usage={runs:[structuredClone(row)]}; const before=JSON.stringify(usage);
  const result=committedPaidRunEvidence(originalRun,[originalJob],usage,repository);
  assert.equal(result.report.run_id,'43093046835'); assert.equal(result.report.ai_calls,4);
  assert.equal(result.report.ai_request_attempts,3); assert.equal(result.report.ai_failed_calls,1);
  assert.equal(Object.hasOwn(result,'committed_job_binding'),false);
  assert.equal(JSON.stringify(usage),before);
});

test('type, omission and equivalent timestamp spelling remain rejected with precise safe values',()=>{
  for(const [key,value,expectedType] of [['run_attempt','1','string'],['run_attempt',undefined,'undefined'],
    ['started_at','2026-11-11T20:04:28.000Z','string'],['completed_at','2026-11-11T20:49:29Z','string']]){
    const job=structuredClone(originalJob); if(value===undefined)delete job[key]; else job[key]=value;
    const {error,diagnostic}=reject([job]);
    assert.equal(error.message,'PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID');
    assert.equal(diagnostic.category,'GUARD_VALIDATION'); assert.equal(diagnostic.error_code,error.message);
    const detail=mismatch(diagnostic,`job.${key}`); assert.ok(detail);assert.equal(detail.observed.type,expectedType);
    if(value!==undefined)assert.equal(detail.observed.value,value);
    assert.equal(detail.expected.value,originalJob[key]);
  }
});

test('job counts and exact step bindings remain fail-closed; unexpected names expose only hashes',()=>{
  const empty=reject([]).diagnostic;
  assert.equal(mismatch(empty,'jobs.count').observed.value,0);
  assert.equal(mismatch(empty,'job.present').observed.value,false);
  const duplicate=reject([structuredClone(originalJob),structuredClone(originalJob)]).diagnostic;
  assert.equal(mismatch(duplicate,'jobs.count').observed.value,2);
  const job=structuredClone(originalJob);job.steps[0].name=secret;
  const named=reject([job]).diagnostic;assert.equal(mismatch(named,'native.matches').observed.value,0);
  const name=mismatch(named,'native.name');assert.equal(name.observed.sha256,createHash('sha256').update(secret).digest('hex'));
  assert.equal(name.observed.length,secret.length);assert.equal(Object.hasOwn(name.observed,'value'),false);
  const changed=structuredClone(originalJob);changed.steps[1].completed_at='2026-11-11T20:35:31Z';
  assert.equal(mismatch(reject([changed]).diagnostic,'commit.completed_at').observed.value,'2026-11-11T20:35:31Z');
});

test('unknown status text, raw fields and hostile descriptors cannot enter diagnostics',()=>{
  const job=structuredClone(originalJob);job.status=secret;job.stderr=secret;
  const actual=reject([job]).diagnostic;const value=mismatch(actual,'job.status').observed;
  assert.equal(value.type,'string');assert.equal(value.length,secret.length);assert.equal(Object.hasOwn(value,'value'),false);
  const dangerous={toString:()=> 'a'.repeat(64),toJSON:()=>secret};
  const forged=Object.assign(Error('PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID'),{
    stderr:secret,raw:secret,committed_job_binding:{version:'committed-job-binding-1',mismatches:[
      {field:'token',expected:{type:'string',value:secret},observed:{type:'string',value:secret}},
      {field:'native.name',expected:{type:'string',value:secret},observed:{type:'string',sha256:dangerous,value:secret}},
      {field:'job.id',expected:{type:'number',value:130774763726},observed:{type:'number',value:dangerous}},
      {field:'job.status',expected:{type:'string',value:'completed'},observed:{type:'string',value:secret}},
    ]}});
  const diagnostic=paidPreflightDiagnostic(forged,context);assertPrivate(diagnostic);
  assert.equal(diagnostic.committed_job_binding.mismatches.length,3);
  assert.equal(Object.hasOwn(mismatch(diagnostic,'native.name').observed,'sha256'),false);
  assert.equal(Object.hasOwn(mismatch(diagnostic,'job.id').observed,'value'),false);
  assert.equal(Object.hasOwn(diagnostic,'stderr'),false);assert.equal(Object.hasOwn(diagnostic,'raw'),false);
});

test('malformed diagnostic access never replaces rejection and bounded details survive error wrapping',()=>{
  const bad=Error('PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID');
  Object.defineProperty(bad,'committed_job_binding',{get(){throw Error(secret);}});
  const diagnostic=paidPreflightDiagnostic(bad,context);
  assert.equal(diagnostic.category,'GUARD_VALIDATION');assert.equal(diagnostic.error_code,bad.message);
  assert.equal(Object.hasOwn(diagnostic,'committed_job_binding'),false);assertPrivate(diagnostic);
  const job=structuredClone(originalJob);job.run_attempt=2;let error;
  try{observePaidPreflightFailure(()=>committedPaidRunEvidence(originalRun,[job],{runs:[row]},repository),context);}catch(e){error=e;}
  const wrapped=paidPreflightDiagnostic(error,context);assert.equal(mismatch(wrapped,'job.run_attempt').observed.value,2);
  const many=Object.assign(Error('PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID'),{committed_job_binding:{version:'committed-job-binding-1',
    mismatches:Array.from({length:100},()=>({field:'job.id',expected:{type:'number',value:130774763726},observed:{type:'undefined'}}))}});
  assert.equal(paidPreflightDiagnostic(many,context).committed_job_binding.mismatches.length,32);
});

test('all three committed binding codes are classified; only the job code admits details',()=>{
  const run={...structuredClone(originalRun),head_sha:'f'.repeat(40)};
  const badUsage={runs:[]};
  const cases=[reject([originalJob],{run}),reject([]),reject([originalJob],{usage:badUsage})];
  for(const [index,{error,diagnostic}]of cases.entries()){
    assert.equal(diagnostic.category,'GUARD_VALIDATION');assert.equal(diagnostic.error_code,error.message);
    assert.equal(Object.hasOwn(diagnostic,'committed_job_binding'),index===1);
    error.committed_job_binding??={version:'committed-job-binding-1',mismatches:[]};
    assert.equal(Object.hasOwn(paidPreflightDiagnostic(error,context),'committed_job_binding'),index===1);
  }
});
