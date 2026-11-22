import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {outgoingCommits,outgoingTreeEntries,outgoingTransportBytes,checkOutgoingGitSize,stagedEntries,readRepositoryStorage} from '../../scripts/news/check-git-size.mjs';
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-outgoing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'};
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','Storage fixture');git('config','user.email','storage@example.invalid');
 const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
 const commit=message=>{git('add','--all');git('commit','-qm',message);return git('rev-parse','HEAD');};
 write('index.json','x'.repeat(2*1024**2));const base=commit('base');return {root,git,write,commit,base};
}
test('a clean index still requires checking the complete outgoing commit range', t=>{
 const f=fixture(t);f.write('new.txt','new small source');const head=f.commit('change');
 assert.deepEqual(stagedEntries(f.root),[]);assert.equal(outgoingCommits(f.root,f.base).commits.length,1);
 const result=checkOutgoingGitSize({root:f.root,base:f.base});assert.equal(result.head,head);assert.equal(result.commits,1);assert.ok(result.transportBytes>0);assert.equal(f.git('remote'),'');
});
test('a raw part introduced and removed before HEAD is still blocked', t=>{
 const f=fixture(t),name='data/news/stories.json.parts/'+'a'.repeat(64)+'.json';f.write(name,'{}');f.commit('accidental raw');f.git('rm',name);f.commit('remove raw');
 assert.equal(f.git('diff','--name-only',f.base,'HEAD'),'');assert.throws(()=>checkOutgoingGitSize({root:f.root,base:f.base}),/RAW_PART_FORBIDDEN/);
});
test('intermediate raw store contents cannot hide behind a later valid manifest', t=>{
 const f=fixture(t);f.write('data/news/newsroom.json','{"raw":"must stay outside Git"}');f.commit('raw');
 f.write('data/news/newsroom.json',JSON.stringify({storage_format:'woek-newsroom-parts-2',parts_storage:'github-release-parts-1',fields:[]}));f.commit('manifest');
 assert.throws(()=>checkOutgoingGitSize({root:f.root,base:f.base}),/RAW_STORE_FORBIDDEN/);
});
test('new paths are inspected after rename and include newline characters', t=>{
 const f=fixture(t);f.write('safe.json','{}');const base=f.commit('safe');f.git('mv','safe.json','renamed\nfile.json');const head=f.commit('rename');
 assert.ok(outgoingTreeEntries(f.root,head).some(x=>x.file==='renamed\nfile.json'));
 const destination='data/news/newsroom.json.parts/'+'b'.repeat(64)+'.json';fs.mkdirSync(path.dirname(path.join(f.root,destination)),{recursive:true});f.git('mv','renamed\nfile.json',destination);f.commit('bad rename');
 assert.throws(()=>checkOutgoingGitSize({root:f.root,base}),/RAW_PART_FORBIDDEN/);
});
test('thin-pack measurement counts added and later deleted large blobs', t=>{
 const f=fixture(t);f.write('temporary.bin',randomBytes(256*1024));f.commit('add');f.git('rm','temporary.bin');f.commit('remove');
 assert.equal(f.git('diff','--name-only',f.base,'HEAD'),'');assert.throws(()=>outgoingTransportBytes(f.root,f.base,'HEAD',32768),/TRANSPORT_BUDGET/);
});
test('the normal outgoing gate enforces the unchanged eight-MiB transport budget', t=>{
 const f=fixture(t);f.write('bulk.bin',randomBytes(9*1024**2));f.commit('bulk');
 assert.throws(()=>checkOutgoingGitSize({root:f.root,base:f.base}),/TRANSPORT_BUDGET/);assert.equal(f.git('remote'),'');
});
test('a small committed edit of a large existing index is measured as a delta', t=>{
 const f=fixture(t);f.write('index.json','x'.repeat(2*1024**2-20)+'edited index value!');f.commit('small index update');
 assert.ok(outgoingTransportBytes(f.root,f.base,'HEAD',32768)<32768);assert.equal(checkOutgoingGitSize({root:f.root,base:f.base}).commits,1);
});
test('divergent branches and missing bases fail before a push can be approved', t=>{
 const f=fixture(t);f.write('left','left');const left=f.commit('left');f.git('checkout','--detach',f.base);f.write('right','right');const right=f.commit('right');
 assert.throws(()=>outgoingCommits(f.root,left,right),/NOT_FAST_FORWARD/);assert.throws(()=>outgoingCommits(f.root,'nonexistent'));assert.equal(f.git('remote'),'');
});
test('an unchanged HEAD is an empty outgoing range, without history traversal or provider calls', t=>{
 const f=fixture(t);assert.deepEqual(outgoingCommits(f.root,f.base),{base:f.base,head:f.base,commits:[]});assert.equal(outgoingTransportBytes(f.root,f.base),0);assert.equal(checkOutgoingGitSize({root:f.root,base:f.base,automatic:true}).commits,0);
});
test('the outgoing range has an explicit bounded commit count', t=>{
 const f=fixture(t);for(let i=0;i<65;i++)f.git('commit','--allow-empty','-qm','fixture '+i);
 assert.throws(()=>outgoingCommits(f.root,f.base),/OUTGOING_COMMIT_LIMIT/);
});
test('mode changes are inspected and symlink raw parts cannot bypass path policy', t=>{
 const f=fixture(t);f.write('executable.sh','#!/bin/sh\nexit 0\n');f.commit('script');fs.chmodSync(path.join(f.root,'executable.sh'),0o755);const head=f.commit('mode');assert.ok(outgoingTreeEntries(f.root,head).some(x=>x.file==='executable.sh'));
 const name='data/news/stories.json.parts/'+'c'.repeat(64)+'.json';fs.mkdirSync(path.dirname(path.join(f.root,name)),{recursive:true});fs.symlinkSync('../../../../index.json',path.join(f.root,name));f.commit('symlink');assert.throws(()=>checkOutgoingGitSize({root:f.root,base:f.base}),/RAW_PART_FORBIDDEN/);
});
test('read-only size reporting distinguishes thresholds from activation and rejects unreadable values',()=>{
 const calls=[];const size=readRepositoryStorage((command,args)=>{calls.push({command,args});return String(9*1024**2)+'\n';});
 assert.equal(size.state,'stop');assert.equal(size.totalStopActivated,false);assert.equal(calls[0].command,'gh');assert.deepEqual(calls[0].args,['api','repos/sustynats/wirkungsoekonomie-produktiv','--jq','.size']);
 for(const x of ['','null','-1','NaN','9007199254740992'])assert.throws(()=>readRepositoryStorage(()=>x),/REPOSITORY_SIZE_INVALID/);
});
test('CLI cannot silently fall back to a staged-only check for malformed outgoing arguments',t=>{
 const f=fixture(t),script=fileURLToPath(new URL('../../scripts/news/check-git-size.mjs',import.meta.url));
 for(const args of [['--base='],['--head=HEAD'],['--bogus'],['--base=HEAD','--base=HEAD'],['--base=HEAD','--head=']]){
  assert.throws(()=>execFileSync(process.execPath,[script,...args],{cwd:f.root,stdio:'pipe'}));
 }
});

test('a merge range includes both branches and validates the merge tree',t=>{
 const f=fixture(t);f.git('checkout','-b','feature');f.write('feature.txt','feature');f.commit('feature');f.git('checkout','-b','main-fixture',f.base);f.write('main.txt','main');f.commit('main');f.git('merge','--no-ff','feature','-m','merge');
 const head=f.git('rev-parse','HEAD'),entries=outgoingTreeEntries(f.root,head);assert.ok(entries.some(x=>x.file==='feature.txt'));assert.ok(entries.some(x=>x.file==='main.txt'));assert.equal(checkOutgoingGitSize({root:f.root,base:f.base}).commits,3);
});
test('a gitlink does not require reading or transferring submodule payloads',t=>{
 const f=fixture(t);f.git('update-index','--add','--cacheinfo','160000,'+'d'.repeat(40)+',vendor/example');f.git('commit','-qm','submodule pointer');
 const entries=outgoingTreeEntries(f.root,f.git('rev-parse','HEAD'));assert.deepEqual(entries.map(x=>({path:x.file,gitlink:x.gitlink,bytes:x.bytes})),[{path:'vendor/example',gitlink:true,bytes:0}]);assert.equal(checkOutgoingGitSize({root:f.root,base:f.base}).commits,1);
});
