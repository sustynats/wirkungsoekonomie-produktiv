import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {guardGitHubContentUpdate} from '../../scripts/news/check-api-storage.mjs';
import {checkStoragePreflight} from '../../scripts/news/check-git-size.mjs';
const repository=()=>({full_name:'sustynats/wirkungsoekonomie-produktiv',size:104869655});
test('API guard binds the exact UTF8 control payload before a provider write',async()=>{
 const content=Buffer.from('{"seen":["a"]}\n');let reads=0;const result=await guardGitHubContentUpdate({file:'.github/discord-journal-state.json',content,readRepository:async()=>{reads++;return repository();}});
 assert.equal(reads,1);assert.equal(result.bytes,content.length);assert.equal(result.sha256,createHash('sha256').update(content).digest('hex'));assert.equal(result.repository,'stop');assert.equal(result.totalStopActivated,false);
});
test('API state cannot exceed the explicit small-control-file budget',async()=>{
 let reads=0;await assert.rejects(guardGitHubContentUpdate({file:'monitor-state.json',content:JSON.stringify({seen:['x'.repeat(524288)]}),readRepository:async()=>{reads++;return repository();}}),/API_STATE_TOO_LARGE/);assert.equal(reads,0);
});
test('API paths and raw ticker parts are blocked before any provider access',async()=>{
 for(const file of ['/absolute.json','../state.json','a/../state.json','a//state.json','a\\state.json','nul\0file.json','data/news/stories.json.parts/'+'a'.repeat(64)+'.json']){
  let reads=0;await assert.rejects(guardGitHubContentUpdate({file,content:'{}',readRepository:async()=>{reads++;return repository();}}));assert.equal(reads,0,file);
 }
});
test('API raw stores, invalid JSON and invalid UTF8 are never submitted',async()=>{
 for(const [file,content] of [['data/news/stories.json','{"stories":[]}'],['state.json','{bad}'],['state.json',Buffer.from([0xff])]]){
  let reads=0;await assert.rejects(guardGitHubContentUpdate({file,content,readRepository:async()=>{reads++;return repository();}}));assert.equal(reads,0);
 }
});
test('missing, malformed or wrong-repository size measurements fail closed',async()=>{
 for(const value of [null,{}, {full_name:'sustynats/wirkungsoekonomie-produktiv',size:null},{full_name:'sustynats/wirkungsoekonomie-produktiv',size:-1},{full_name:'sustynats/wirkungsoekonomie-produktiv',size:NaN},{full_name:'other/repository',size:1}]){
  await assert.rejects(guardGitHubContentUpdate({file:'state.json',content:'{}',readRepository:async()=>value}),/REPOSITORY_SIZE_INVALID/);
 }
 await assert.rejects(guardGitHubContentUpdate({file:'state.json',content:'{}'}),/REPOSITORY_READ_REQUIRED/);
});
test('an unavailable provider read propagates without a mutation or retry',async()=>{
 let reads=0,writes=0;await assert.rejects((async()=>{await guardGitHubContentUpdate({file:'state.json',content:'{}',readRepository:async()=>{reads++;throw Error('READ_UNAVAILABLE');}});writes++;})(),/READ_UNAVAILABLE/);assert.equal(reads,1);assert.equal(writes,0);
});
test('preflight rejects inconsistent measurements and preserves recovery-mode activation semantics',()=>{
 const result=checkStoragePreflight({measure:()=>({bytes:9*1024**3,state:'stop'})});assert.equal(result.totalStopActivated,false);assert.equal(result.preflight,true);
 assert.throws(()=>checkStoragePreflight({measure:()=>({bytes:9*1024**3,state:'ok'})}),/REPOSITORY_SIZE_INVALID/);
});
test('after explicit cleaned-baseline activation both API admission and early preflight stop',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-active-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=new URL('../../',import.meta.url);for(const file of ['scripts/news/check-api-storage.mjs','scripts/news/check-git-size.mjs','docs/ops/GIT-STORAGE-POLICY.json']){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(new URL(file,source),target);}
 fs.symlinkSync(new URL('../../scripts/news/release-part.mjs',import.meta.url),path.join(root,'scripts/news/release-part.mjs'));
 fs.symlinkSync(new URL('../../scripts/news/newsroom-store.mjs',import.meta.url),path.join(root,'scripts/news/newsroom-store.mjs'));
 const policyPath=path.join(root,'docs/ops/GIT-STORAGE-POLICY.json'),policy=JSON.parse(fs.readFileSync(policyPath));policy.enforce_total_repository_after_cleanup=true;fs.writeFileSync(policyPath,JSON.stringify(policy));
 const api=await import(pathToFileURL(path.join(root,'scripts/news/check-api-storage.mjs')));const guard=await import(pathToFileURL(path.join(root,'scripts/news/check-git-size.mjs')));
 await assert.rejects(api.guardGitHubContentUpdate({file:'state.json',content:'{}',readRepository:async()=>repository()}),/REPOSITORY_STOP/);
 assert.throws(()=>guard.checkStoragePreflight({measure:()=>({bytes:9*1024**3,state:'stop'})}),/REPOSITORY_STOP/);
});

test('the actual early-preflight CLI reads size without a Git checkout or any writer',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-preflight-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bin=path.join(dir,'bin');fs.mkdirSync(bin);const gh=path.join(bin,'gh');fs.writeFileSync(gh,'#!/bin/sh\nprintf "104869655\\n"\n',{mode:0o700});
 const script=fileURLToPath(new URL('../../scripts/news/check-git-size.mjs',import.meta.url));
 const options={cwd:dir,encoding:'utf8',env:{PATH:bin+':/usr/bin:/bin'},timeout:15000};
 const good=spawnSync(process.execPath,[script,'--preflight'],options);assert.equal(good.status,0,good.stderr);const report=JSON.parse(good.stdout);assert.equal(report.preflight,true);assert.equal(report.state,'stop');assert.equal(report.totalStopActivated,false);assert.equal(fs.existsSync(path.join(dir,'.git')),false);
 fs.writeFileSync(gh,'#!/bin/sh\nprintf "unavailable\\n"\n',{mode:0o700});const bad=spawnSync(process.execPath,[script,'--preflight'],options);assert.notEqual(bad.status,0);assert.match(bad.stderr,/REPOSITORY_SIZE_INVALID/);
 const ambiguous=spawnSync(process.execPath,[script,'--preflight','--base=HEAD'],options);assert.notEqual(ambiguous.status,0);assert.match(ambiguous.stderr,/ARGUMENT_INVALID/);
});
