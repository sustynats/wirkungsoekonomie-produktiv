import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {repositoryStorageState,assertReleasedManifest,assertStagedStorage,stagedEntries,stagedTransportBytes,checkStagedGitSize} from '../../scripts/news/check-git-size.mjs';
const oid='a'.repeat(40),h='b'.repeat(64);
const manifest=()=>({storage_format:'woek-newsroom-parts-2',parts_storage:'github-release-parts-1',fields:[{key:'stories',kind:'array',count:1,parts:[{sha256:h,bytes:2000,release:{storage_format:'woek-release-part-gzip-1',tag:'wirkungsticker-data-2026-11',asset:h+'.json.gz',sha256:'c'.repeat(64),bytes:1000}}]}]});
test('internal total-size boundaries reject invalid measurements',()=>{
 assert.equal(repositoryStorageState(5*1024**3-1),'ok');assert.equal(repositoryStorageState(5*1024**3),'warning');assert.equal(repositoryStorageState(8*1024**3),'stop');for(const n of [-1,NaN,Infinity,null])assert.throws(()=>repositoryStorageState(n));
});
test('released manifests retain pinned immutable references; raw and malformed stores fail closed',()=>{
 assert.equal(assertReleasedManifest(manifest()),true);assert.throws(()=>assertReleasedManifest({stories:[]}));let x=manifest();delete x.fields[0].parts[0].release;assert.throws(()=>assertReleasedManifest(x));x=manifest();x.fields[0].parts[0].release.asset='../other';assert.throws(()=>assertReleasedManifest(x));
});
test('even a tiny raw part is forbidden while deletions need no re-archiving',()=>{
 assert.throws(()=>assertStagedStorage([{file:'data/news/stories.json.parts/'+h+'.json',oid,bytes:2}],()=>''),/RAW_PART/);assertStagedStorage([],()=>{throw Error('deleted payload must not be read')});assert.throws(()=>assertStagedStorage([{file:'data/news/newsroom.json',oid,bytes:2}],()=>'{bad}'));
});
function repo(t){const root=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const g=(...a)=>execFileSync('git',a,{cwd:root,stdio:'pipe',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});g('init','-q');g('config','user.name','Storage test');g('config','user.email','storage@example.invalid');fs.writeFileSync(path.join(root,'index.json'),'x'.repeat(2*1024**2));g('add','.');g('commit','-qm','baseline');return {root,g};}
test('NUL-delimited paths survive newlines and a small edit of a large existing file stays small',t=>{
 const {root,g}=repo(t);fs.writeFileSync(path.join(root,'index.json'),'x'.repeat(2*1024**2-20)+'updated index data!');fs.writeFileSync(path.join(root,'line\nbreak.json'),'{}');g('add','.');assert.ok(stagedEntries(root).some(x=>x.file==='line\nbreak.json'));assert.ok(stagedTransportBytes(root,32768)<32768);
});
test('thin-pack measurement uses the unchanged blob as a delta base without changing HEAD or index',t=>{
 const {root,g}=repo(t);const initial=randomBytes(2*1024**2);const filename=path.join(root,'large-random.bin');
 fs.writeFileSync(filename,initial);g('add','large-random.bin');g('commit','-qm','random baseline');
 const before=g('rev-parse','HEAD').toString();const edited=Buffer.from(initial);edited.write('changed-16-bytes',1024*1024);fs.writeFileSync(filename,edited);g('add','large-random.bin');
 const tree=g('write-tree').toString();assert.ok(stagedTransportBytes(root,32768)<32768);
 assert.equal(g('rev-parse','HEAD').toString(),before);assert.equal(g('write-tree').toString(),tree);assert.equal(g('remote').toString(),'');
});
test('new incompressible transport exceeds its budget before commit or remote writes',t=>{
 const {root,g}=repo(t);const before=g('rev-parse','HEAD').toString();fs.writeFileSync(path.join(root,'random.bin'),randomBytes(256*1024));g('add','.');assert.throws(()=>stagedTransportBytes(root,32768),/TRANSPORT_BUDGET/);assert.equal(g('rev-parse','HEAD').toString(),before);assert.equal(g('remote').toString(),'');
});

test('an unreadable automatic repository measurement fails closed without contacting GitHub',t=>{
 const {root,g}=repo(t);fs.writeFileSync(path.join(root,'new.txt'),'new');g('add','.');
 const bin=path.join(root,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'gh'),'#!/bin/sh\nprintf not-a-number\n',{mode:0o700});
 const prior=process.env.PATH;process.env.PATH=bin+':'+prior;t.after(()=>{process.env.PATH=prior;});
 assert.throws(()=>checkStagedGitSize({root,automatic:true}),/REPOSITORY_SIZE_INVALID/);
});

test('an existing v2 logical record keeps every bounded released chunk',()=>{
 const x=manifest(),leaf=x.fields[0].parts[0];x.fields[0].parts=[{kind:'record',sha256:'d'.repeat(64),bytes:8534238,parts:[leaf,{...leaf,sha256:'e'.repeat(64),release:{...leaf.release,asset:'e'.repeat(64)+'.json.gz'}}]}];
 assert.equal(assertReleasedManifest(x),true);delete x.fields[0].parts[0].parts[1].release;assert.throws(()=>assertReleasedManifest(x));
});
test('record containers never hide unbounded, malformed or unpinned leaves',()=>{
 for(const change of [x=>{x.fields[0].parts[0].bytes=129*1024**2;},x=>{x.fields[0].parts[0].parts=[];},x=>{x.fields[0].parts[0].parts[0].bytes=9*1024**2;},x=>{x.fields[0].parts[0].parts[0].release.asset='../escape';}]){
  const x=manifest(),leaf=x.fields[0].parts[0];x.fields[0].parts=[{kind:'record',sha256:'d'.repeat(64),bytes:8534238,parts:[leaf]}];change(x);assert.throws(()=>assertReleasedManifest(x));
 }
});
