import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publishGitUpdate,enforcePublicationStorage,isStorageQuotaRejection} from '../../scripts/news/publish-git.mjs';
import {checkOutgoingGitSize} from '../../scripts/news/check-git-size.mjs';
test('every bounded push attempt is gated after integration of the current base',async()=>{
 const calls=[];let pushes=0;
 const result=await publishGitUpdate({sleep:async()=>{},storageGate:async options=>calls.push(['gate',options]),run:async args=>{calls.push(args);if(args[0]==='push'&&++pushes<3)throw Error('fetch first');return 'unchanged';}});
 assert.equal(result.attempts,3);assert.equal(calls.filter(x=>x[0]==='gate').length,3);
 for(let i=0;i<calls.length;i++)if(calls[i][0]==='push')assert.deepEqual(calls[i-1],['gate',{phase:'outgoing',base:'FETCH_HEAD'}]);
});
test('a failed outgoing gate stops before any push, retry or sleep',async()=>{
 let pushed=false,slept=false;
 await assert.rejects(publishGitUpdate({storageGate:async()=>{throw Error('TEST_STORAGE_GATE_STOP');},sleep:async()=>{slept=true;},run:async args=>{if(args[0]==='push')pushed=true;return 'unchanged';}}),/TEST_STORAGE_GATE_STOP/);
 assert.equal(pushed,false);assert.equal(slept,false);
});
test('a regenerated staged change is checked before another commit can be created',async()=>{
 const calls=[];let heads=0;
 await assert.rejects(publishGitUpdate({rebuild:async()=>{},storageGate:async options=>{calls.push(['gate',options]);if(options.phase==='staged')throw Error('STAGED_GATE_STOP');},run:async args=>{
  calls.push(args);if(args[0]==='rev-parse'&&args[1]==='HEAD')return ++heads===1?'before':'after';
  if(args[0]==='ls-files'||args[0]==='diff'&&args.includes('--cached'))return 'news/index.html\0';return '';
 }}),/STAGED_GATE_STOP/);
 assert.ok(calls.some(x=>x[0]==='gate'&&x[1].phase==='staged'));assert.ok(!calls.some(x=>x[0]==='commit'||x[0]==='push'));
});
test('rebase recovery aborts safely if the staged content fails storage validation',async()=>{
 const calls=[];
 await assert.rejects(publishGitUpdate({storageGate:async()=>{throw Error('RECOVERY_GATE_STOP');},run:async args=>{
  calls.push(args);if(args[0]==='rebase'&&args[1]==='FETCH_HEAD')throw Error('conflict');
  if(args[0]==='diff'&&args.includes('--diff-filter=U'))return 'reports/wirkungsticker-source-integrity.json\0';
  if(args[0]==='diff'&&args.includes('--cached'))return 'data/news/state.json\0';return '';
 }}),/RECOVERY_GATE_STOP/);
 assert.ok(calls.some(x=>x[0]==='rebase'&&x[1]==='--abort'));assert.ok(!calls.some(x=>x.includes('--continue')||x[0]==='push'));
});
test('known repository quota rejection is never repeated by the publication retry loop',async()=>{
 let pushes=0,sleeps=0;
 await assert.rejects(publishGitUpdate({storageGate:async()=>{},sleep:async()=>{sleeps++;},run:async args=>{
  if(args[0]==='push'){pushes++;throw Object.assign(Error('push failed'),{stderr:'remote: Repository is above its size quota'});}return 'unchanged';
 }}),/PUBLISH_REPOSITORY_SIZE_QUOTA/);
 assert.equal(pushes,1);assert.equal(sleeps,0);assert.equal(isStorageQuotaRejection(Error('fetch first')),false);
});
test('the real outgoing check prevents an intermediate raw part from reaching a push',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-publish-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const g=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 g('init','-q');g('config','user.name','Storage fixture');g('config','user.email','storage@example.invalid');fs.writeFileSync(path.join(root,'source'),'base');g('add','.');g('commit','-qm','base');const base=g('rev-parse','HEAD');
 const file='data/news/stories.json.parts/'+'a'.repeat(64)+'.json';fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'{}');g('add','.');g('commit','-qm','raw');g('rm',file);g('commit','-qm','remove');
 let pushed=false;
 await assert.rejects(publishGitUpdate({storageGate:async()=>checkOutgoingGitSize({root,base}),run:async args=>{if(args[0]==='push')pushed=true;if(args[0]==='rev-parse'&&args[1]==='HEAD')return g('rev-parse','HEAD');return '';}}),/RAW_PART_FORBIDDEN/);
 assert.equal(pushed,false);assert.equal(g('remote'),'');
});
test('production gate rejects unknown phases instead of accidentally skipping checks',()=>assert.throws(()=>enforcePublicationStorage({phase:'push-later'}),/STORAGE_PHASE_INVALID/));

test('the exact checked commit is pinned in the push refspec',async()=>{
 const head='a'.repeat(40);const calls=[];
 await publishGitUpdate({storageGate:async()=>({head,commits:1}),run:async args=>{calls.push(args);if(args[0]==='rev-parse'&&args[1]==='HEAD')return head;return '';}});
 assert.deepEqual(calls.find(x=>x[0]==='push'),['push','origin',head+':main']);
});
test('a head change after storage validation stops before publication',async()=>{
 const head='b'.repeat(40);let pushed=false;
 await assert.rejects(publishGitUpdate({storageGate:async()=>({head,commits:1}),run:async args=>{if(args[0]==='push')pushed=true;return args[0]==='rev-parse'&&args[1]==='HEAD'?'c'.repeat(40):'';}}),/STORAGE_HEAD_CHANGED/);
 assert.equal(pushed,false);
});
test('an exact commit already on freshly fetched main needs no write probe',async()=>{
 const head='d'.repeat(40);let pushed=false;
 const result=await publishGitUpdate({storageGate:async()=>({head,commits:0}),run:async args=>{if(args[0]==='push')pushed=true;return args[0]==='rev-parse'&&args[1]==='HEAD'?head:'';}});
 assert.equal(result.attempts,1);assert.equal(pushed,false);
});
