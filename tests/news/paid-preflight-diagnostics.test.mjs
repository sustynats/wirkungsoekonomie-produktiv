import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {paidPreflightDiagnostic, observePaidPreflightFailure, readPaidPreflightJson,
  readPaidPreflightText} from '../../scripts/news/paid-preflight-diagnostics.mjs';
import {verifyInterruptedPaidRuns, verifyMigratedPaidRuns, NEW_PAID_REPOSITORY,
  LEGACY_PAID_REPOSITORY} from '../../scripts/news/recover-failed-usage.mjs';
import {runInterruptedPaidPreflight} from '../../scripts/news/retained-failed-paid-work.mjs';

const secret = 'PRIVATE_TOKEN_AND_PAID_ANSWER_78217';
const current = {id:900, run_attempt:1, status:'in_progress', conclusion:null,
  created_at:'2026-11-19T13:59:00Z', updated_at:'2026-11-19T14:00:00Z'};
const failed = {id:800, run_attempt:1, status:'completed', conclusion:'failure',
  created_at:'2026-11-18T13:00:00Z', updated_at:'2026-11-18T13:30:00Z'};
const native = {name:'Import, analyze (one call per story) and build', conclusion:'failure',
  started_at:'2026-11-18T13:01:00Z', completed_at:'2026-11-18T13:29:00Z'};
const now='2026-11-19T14:00:00Z';
const context={repository:NEW_PAID_REPOSITORY, operation:'run_log', run_id:800};
const assertPrivate = value => assert.ok(!JSON.stringify(value).includes(secret));
function childError(http=403) {
  return Object.assign(new Error(secret), {status:1,
    stderr:`gh: ${secret} https://private.invalid/?token=${secret} (HTTP ${http})\n`});
}
function mockedRun(log) {
  return args => {
    if (args[0]==='api' && args[1].includes('/workflows/')) return JSON.stringify({total_count:2,workflow_runs:[current,failed]});
    if (args[0]==='api' && args[1].endsWith('/800/jobs?per_page=100'))
      return JSON.stringify({total_count:1,jobs:[{id:801,run_id:800,conclusion:'failure',steps:[native]}]});
    if (args[0]==='run') { if (log instanceof Error) throw log; return log; }
    throw Error('Unexpected mocked request');
  };
}
function checkFailedRun(log) {
  const usage={runs:[]};
  const guard=verifyInterruptedPaidRuns({usage, now, runId:900, repository:NEW_PAID_REPOSITORY, gh:mockedRun(log)});
  assert.equal(guard.status,'open');
  assert.deepEqual(guard.unresolved_run_ids,[800]);
  assert.equal(guard.unresolved_reasons[800],'PAID_PREFLIGHT_READ_UNAVAILABLE');
  assert.equal(guard.provider_called,false);
  assert.deepEqual(usage.runs,[]);
  assertPrivate(guard);
  return guard.diagnostics[0];
}
const logText = text => text.split('\n').map(line=>`worker\t${native.name}\t2026-11-18T13:10:00Z ${line}`).join('\n');
const report = {schema_version:'1.2', run_id:'800', started_at:'2026-11-18T13:02:00Z',
  completed_at:'2026-11-18T13:20:00Z', ai_calls:0,input_tokens:0,output_tokens:0,estimated_cost_usd:0};

test('GH read preserves original exception and arguments; only safe HTTP fields are exposed',()=>{
  for (const code of [403,404]) {
    const error=childError(code); let calls=0; const args=['run','view','800','--log'];
    assert.throws(()=>readPaidPreflightText(actual=>{calls++;assert.equal(actual,args);throw error;},args,context),actual=>actual===error);
    assert.equal(calls,1);
    const d=paidPreflightDiagnostic(error);
    assert.equal(d.phase,'github_read'); assert.equal(d.operation,'run_log');
    assert.equal(d.category,`HTTP_${code}`); assert.equal(d.run_id,800); assertPrivate(d);
    assert.equal('message' in d,false); assert.equal('stderr' in d,false); assert.equal('cause' in d,false);
  }
});
test('native timeout, output limit, conflict and unknown fields remain bounded',()=>{
  const cases=[
    [Object.assign(new Error(secret),{code:'ETIMEDOUT',signal:'SIGTERM',killed:true}), 'TERMINATED_UNKNOWN','ETIMEDOUT'],
    [Object.assign(new Error(secret),{code:'ENOBUFS'}),'OUTPUT_LIMIT','ENOBUFS'],
    [Object.assign(new Error(secret),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),'OUTPUT_LIMIT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'],
    [Object.assign(new Error(secret),{code:'ENOENT'}),'CLIENT_MISSING','ENOENT'],
    [Object.assign(new Error(secret),{code:1,status:2,stderr:`gh: ${secret} (HTTP 403)`}),'UNKNOWN','NONE'],
    [Object.assign(new Error(secret),{code:secret,stderr:secret}),'UNKNOWN','OTHER'],
  ];
  for (const [error,category,nativeCode] of cases) {
    assert.throws(()=>readPaidPreflightText(()=>{throw error;},[],context));
    const d=paidPreflightDiagnostic(error); assert.equal(d.category,category); assert.equal(d.native_code,nativeCode); assertPrivate(d);
  }
});
test('JSON payloads and nested exception messages are never retained',()=>{
  let captured;
  try { readPaidPreflightJson(()=>`{${secret}`,[],{...context,operation:'jobs'}); } catch(e) {captured=e;}
  const d=paidPreflightDiagnostic(captured,{operation:'workflow_scan'});
  assert.equal(d.category,'JSON_INVALID'); assert.equal(d.phase,'json_decode'); assert.equal(d.operation,'jobs'); assertPrivate(d);
  assert.throws(()=>observePaidPreflightFailure(()=>{throw captured;},{operation:'preflight'}),e=>e===captured);
  assert.deepEqual(paidPreflightDiagnostic(captured),d);
});
test('known recovery codes and fields are distinct from unknown raw error messages',()=>{
  for (const [message,expected] of [['RECOVERY_REPORT_INVALID','RECOVERY_REPORT_INVALID'],
    ['RECOVERY_REPORT_INCOMPLETE','RECOVERY_REPORT_INCOMPLETE'],
    ['RECOVERY_USAGE_INVALID:ai_calls','RECOVERY_USAGE_INVALID']]) {
    const d=paidPreflightDiagnostic(new Error(message),{...context,operation:'recovery_report',phase:'recovery'});
    assert.equal(d.category,'RECOVERY_VALIDATION'); assert.equal(d.error_code,expected);
  }
  assert.equal(paidPreflightDiagnostic(new Error(`RECOVERY_USAGE_INVALID:${secret}`)).error_code,'UNCLASSIFIED');
  assertPrivate(paidPreflightDiagnostic(new Error(secret),{repository:secret,operation:secret,run_id:secret}));
});
test('hostile error getters and overlarge or ambiguous stderr cannot leak',()=>{
  const hostile={get message(){throw Error(secret);},get stderr(){throw Error(secret);}};
  assertPrivate(paidPreflightDiagnostic(hostile));
  for (const stderr of [secret.repeat(1000),`gh: ${secret} (HTTP 403)\ngh: ${secret} (HTTP 404)`]) {
    const error=Object.assign(new Error(secret),{status:1,stderr});
    assert.throws(()=>readPaidPreflightText(()=>{throw error;},[],context));
    const d=paidPreflightDiagnostic(error); assert.equal(d.category,'UNKNOWN'); assertPrivate(d);
  }
});
test('invalid workflow JSON still leaves the guard open with unchanged public failure code',()=>{
  const guard=verifyInterruptedPaidRuns({usage:{runs:[]},now,runId:900,repository:NEW_PAID_REPOSITORY,gh:()=>`{${secret}`});
  assert.equal(guard.status,'open'); assert.equal(guard.verification_error,'PAID_PREFLIGHT_READ_UNAVAILABLE');
  assert.equal(guard.diagnostics[0].operation,'workflow_runs'); assert.equal(guard.diagnostics[0].category,'JSON_INVALID'); assertPrivate(guard);
});
test('run log HTTP failure identifies the exact repo/run without clearing unknown paid work',()=>{
  const d=checkFailedRun(childError(404));
  assert.equal(d.operation,'run_log'); assert.equal(d.category,'HTTP_404'); assert.equal(d.repository,NEW_PAID_REPOSITORY); assert.equal(d.run_id,800);
});
test('invalid and malformed native reports have recovery and JSON diagnoses respectively',()=>{
  const invalid=checkFailedRun(logText(JSON.stringify({...report,schema_version:'wrong'},null,2)));
  assert.equal(invalid.operation,'recovery_report'); assert.equal(invalid.error_code,'RECOVERY_REPORT_INVALID');
  const malformed=checkFailedRun(logText(`{\n"private":${secret}\n}`));
  assert.equal(malformed.operation,'recovery_report'); assert.equal(malformed.category,'JSON_INVALID');
});
test('provider-event JSON errors remain distinct from native report errors',()=>{
  const d=checkFailedRun(logText(JSON.stringify(report,null,2))+ '\n'+logText(`{"news_import_progress":${secret}}`));
  assert.equal(d.operation,'provider_events'); assert.equal(d.category,'JSON_INVALID');
});
function migrationGh(args) {
  if (args[1].includes('?status=')) throw childError(403);
  if (args[1].startsWith(`repos/${LEGACY_PAID_REPOSITORY}/`)) return JSON.stringify({total_count:0,workflow_runs:[]});
  return JSON.stringify({total_count:1,workflow_runs:[current]});
}
test('cross-repository active-read errors remain blocking and retain their precise source',()=>{
  const guard=verifyMigratedPaidRuns({usage:{runs:[]},now,runId:900,gh:migrationGh});
  assert.equal(guard.status,'open'); assert.equal(guard.cross_repository_active_check,'uncertain');
  assert.equal(guard.verification_error,'PAID_PREFLIGHT_READ_UNAVAILABLE');
  const d=guard.diagnostics[0]; assert.equal(d.repository,LEGACY_PAID_REPOSITORY); assert.equal(d.operation,'active_runs');
  assert.equal(d.requested_status,'queued'); assert.equal(d.category,'HTTP_403'); assertPrivate(guard);
});
test('preflight result forwards redacted diagnostics without a write or provider call',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paid-preflight-diagnostic-'));
  try {
    fs.mkdirSync(path.join(root,'data/news'),{recursive:true}); const file=path.join(root,'data/news/usage.json');
    fs.writeFileSync(file,'{"runs":[]}'); const before=fs.readFileSync(file);
    const result=runInterruptedPaidPreflight({root,now,write:false,gh:migrationGh,
      env:{GITHUB_REPOSITORY:NEW_PAID_REPOSITORY,GITHUB_RUN_ID:'900',GITHUB_RUN_ATTEMPT:'1'}});
    assert.equal(result.status,'open'); assert.equal(result.provider_called,false); assert.equal(result.diagnostics[0].category,'HTTP_403');
    assert.deepEqual(fs.readFileSync(file),before); assertPrivate(result);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('CLI catches local JSON errors and prints only a redacted diagnostic with exit one',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'paid-preflight-cli-')));
  try {
    const source=fileURLToPath(new URL('../../scripts/news/',import.meta.url));
    const scripts=path.join(root,'scripts/news'); fs.mkdirSync(scripts,{recursive:true});
    for (const name of ['retained-failed-paid-work.mjs','recover-failed-usage.mjs','committed-paid-run-evidence.mjs','paid-preflight-diagnostics.mjs',
      'quarantined-419-evidence.mjs','newsroom-store.mjs','release-part.mjs']) fs.copyFileSync(path.join(source,name),path.join(scripts,name));
    fs.mkdirSync(path.join(root,'data/news'),{recursive:true}); fs.writeFileSync(path.join(root,'data/news/usage.json'),`{${secret}`);
    const result=spawnSync(process.execPath,[path.join(scripts,'retained-failed-paid-work.mjs'),'--preflight','--dry-run'],
      {encoding:'utf8',env:{GITHUB_REPOSITORY:NEW_PAID_REPOSITORY,GITHUB_RUN_ID:'900',GITHUB_RUN_ATTEMPT:'1'}});
    assert.equal(result.status,1); assert.equal(result.stdout,'');
    assert.ok(!result.stderr.includes(secret));
    assert.ok(result.stderr.trimStart().startsWith('{'),
      'CLI fixture exited before structured diagnostics; check its copied module dependencies');
    const record=JSON.parse(result.stderr);
    assert.equal(record.error,'PAID_PREFLIGHT_FAILED'); assert.equal(record.provider_called,false);
    assert.equal(record.diagnostics[0].category,'JSON_INVALID');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('an already clear synthetic guard retains checked state with no diagnostics',()=>{
  const guard=verifyInterruptedPaidRuns({usage:{runs:[]},now,runId:900,repository:NEW_PAID_REPOSITORY,
    gh:()=>JSON.stringify({total_count:1,workflow_runs:[current]})});
  assert.equal(guard.status,'checked'); assert.deepEqual(guard.diagnostics,[]); assert.equal(guard.provider_called,false);
});
