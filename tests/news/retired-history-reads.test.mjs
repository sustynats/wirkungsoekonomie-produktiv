import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {retainedHistoryReader} from '../../scripts/news/retired-history-reads.mjs';

const production='sustynats/wirkungsoekonomie-produktiv';
const legacy='sustynats/wirkungsoekonomie.de';
const active='repos/'+legacy+'/actions/workflows/wirkungsticker.yml/runs?status=in_progress&per_page=100';
function fixture(t,modify=()=>{},identity=1467786104){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'woek-retired-history-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'.github'));
 const certificate={schema:1,generation:'2026-11-22-privacy-reviewed',repository:production,
  replacement_repository_id:1467786104,retired_legacy_repository_id:1241055331,
  retired_legacy_private_archived:true,retired_legacy_actions_disabled:true,
  retired_production_repository_id:1447217605,retired_production_private_archived:true,
  sealed_at:'2026-11-22T20:00:00Z',responses:{[active]:{total_count:0,workflow_runs:[]}}};
 modify(certificate);const raw=JSON.stringify(certificate);
 fs.writeFileSync(path.join(root,'.github/retired-news-history.json'),raw);
 fs.writeFileSync(path.join(root,'.github/public-source-baseline.json'),JSON.stringify({
  generation:certificate.generation,repository:production,retiredNewsHistorySha256:createHash('sha256').update(raw).digest('hex')}));
 const calls=[];const gh=args=>{calls.push(args);return JSON.stringify(args[1]==='repos/'+production ? {id:identity,archived:false} : {live:true});};
 return {root,gh,calls};
}
test('retired evidence answers only exact retained legacy reads; new runs remain live',t=>{
 const f=fixture(t);const gh=retainedHistoryReader(f);
 assert.equal(JSON.parse(gh(['api',active])).total_count,0);
 assert.equal(JSON.parse(gh(['api','repos/'+production+'/actions/runs/45056675363'])).live,true);
 assert.equal(f.calls.filter(a=>a[1]===active).length,0);
 assert.throws(()=>gh(['api','repos/'+legacy+'/actions/runs/999']),{message:'PAID_PREFLIGHT_RETIRED_READ_NOT_RETAINED'});
 assert.throws(()=>gh(['api',active,'--method','DELETE']),{message:'PAID_PREFLIGHT_RETIRED_READ_NOT_RETAINED'});
});
test('the reused repository name must resolve to the reviewed replacement identity',t=>{
 assert.throws(()=>retainedHistoryReader(fixture(t,()=>{},1447217605)),{message:'PAID_PREFLIGHT_REPLACEMENT_IDENTITY_CHANGED'});
});
test('changed or missing retained bytes stop before any live access',t=>{
 for(const change of ['modify','delete']){
  const f=fixture(t);const p=path.join(f.root,'.github/retired-news-history.json');
  if(change==='modify')fs.appendFileSync(p,' ');else fs.unlinkSync(p);
  assert.throws(()=>retainedHistoryReader(f),/PAID_PREFLIGHT_RETIRED_HISTORY_(CHANGED|MISSING)/);assert.deepEqual(f.calls,[]);
 }
});
test('an unarchived original, enabled original Actions or a contradictory active run fail closed',t=>{
 for(const field of ['retired_legacy_private_archived','retired_legacy_actions_disabled','retired_production_private_archived']){
  assert.throws(()=>retainedHistoryReader(fixture(t,c=>{c[field]=false})),{message:'PAID_PREFLIGHT_RETIRED_HISTORY_UNVERIFIED'});
 }
 const f=fixture(t,c=>{c.responses[active]={total_count:1,workflow_runs:[{id:10,status:'in_progress'}]}});
 assert.throws(()=>retainedHistoryReader(f)(['api',active]),{message:'PAID_PREFLIGHT_RETIRED_RUN_ACTIVE'});
});
test('unrelated preexisting checkouts preserve the original live reader',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'woek-history-original-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const gh=()=> 'original';assert.equal(retainedHistoryReader({root,gh}),gh);
});
