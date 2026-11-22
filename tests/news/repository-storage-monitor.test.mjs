import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {storageReport} from '../../scripts/ops/check-repository-storage.mjs';
import {repositoryStorageState} from '../../scripts/news/check-git-size.mjs';
test('size monitoring stays observable before the total writer stop is activated',()=>{
 const bytes=9*1024**3;const report=storageReport({measure:()=>({bytes,state:repositoryStorageState(bytes),totalStopActivated:false}),now:()=>new Date('2026-11-03T21:00:00Z')});
 assert.equal(report.exitCode,2);assert.equal(report.totalStopActivated,false);assert.equal(report.independentOfGitState,true);assert.equal(report.repositoryWrites,0);assert.equal(report.measuredAt,'2026-11-03T21:00:00.000Z');
});
test('a threshold warning is distinguishable without pretending the repository is blocked by GitHub',()=>{
 const bytes=6*1024**3;const report=storageReport({measure:()=>({bytes,state:repositoryStorageState(bytes),totalStopActivated:true})});assert.equal(report.state,'warning');assert.equal(report.exitCode,0);assert.equal(report.readOnly,true);
});
function fixture(t,response,code=0){
 const root=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-size-monitor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gh'),'#!/bin/sh\nprintf '+JSON.stringify(response)+'\nexit '+code+'\n',{mode:0o700});
 fs.writeFileSync(path.join(bin,'git'),'#!/bin/sh\ntouch '+JSON.stringify(path.join(root,'GIT_WAS_CALLED'))+'\nexit 99\n',{mode:0o700});
 const script=fileURLToPath(new URL('../../scripts/ops/check-repository-storage.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{PATH:bin+':/usr/bin:/bin',HOME:root},timeout:15000});
 assert.equal(fs.existsSync(path.join(root,'GIT_WAS_CALLED')),false);assert.equal(fs.existsSync(path.join(root,'.git')),false);return result;
}
test('the real monitor CLI works without a Git checkout or repository state commit',t=>{
 const result=fixture(t,'104869655');assert.equal(result.status,2,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.bytes,104869655*1024);assert.equal(report.state,'stop');assert.equal(report.totalStopActivated,false);
});
test('the real monitor CLI fails closed on an unavailable provider read without any Git call',t=>{
 const result=fixture(t,'unavailable',1);assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).state,'unknown');
});
test('the real monitor CLI rejects malformed size data instead of reporting a healthy empty repository',t=>{
 const result=fixture(t,'null');assert.equal(result.status,1);const report=JSON.parse(result.stderr);assert.equal(report.state,'unknown');assert.equal(report.error,'GIT_STORAGE_REPOSITORY_SIZE_INVALID');
});
