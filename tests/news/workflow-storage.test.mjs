import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const workflow=name=>fs.readFileSync(path.join(root,'.github/workflows/'+name+'.yml'),'utf8');
function block(name,step){const value=workflow(name).split(/\n {6}- name: /).find(x=>x.startsWith(step+'\n'));assert.ok(value,'missing step '+step);return value;}
function shell(name,step){const lines=block(name,step).split('\n'),start=lines.indexOf('        run: |');assert.ok(start>=0);return lines.slice(start+1).filter(x=>x.startsWith('          ')).map(x=>x.slice(10)).join('\n');}
const steps={wirkungsticker:'Commit one atomic update','political-autopilot':'Commit a changed verified snapshot','quellenarchiv-sync':'PR öffnen, falls sich der Snapshot geändert hat','state-sustainability-sync':'Commit all deterministic outputs'};
function execute(t,name,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(), 'woek-workflow-storage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'woek-parlament-app'));
 const calls=path.join(dir,'calls'),output=path.join(dir,'output');
 const doubles=`
 task_head="$BASE_HEAD"
 task_staged=0
 task_pushes=0
 git() {
  printf '%s\\n' "git $*" >> "$CALLS"
  case "$1" in
   config|add|reset|checkout|fetch|rebase) return 0 ;;
   restore) [[ "$*" == "restore --source=HEAD --staged --worktree -- wirkungsticker/data/app" ]] || return 93; [[ "$TEST_RESTORE_FAIL" != true ]] || return 73; return 0 ;;
   diff) if [[ "$*" == *--name-only* ]]; then printf '%s\\n' 'news/index.html'; return 0; fi; [[ "$TEST_NO_CHANGE" == true ]] ;;
   commit) if [[ "$*" == *--amend* ]]; then task_head="$AMENDED_HEAD"; else task_head="$COMMITTED_HEAD"; fi; return 0 ;;
   rev-parse) printf '%s\\n' "$task_head" ;;
   push)
    task_pushes=$((task_pushes+1))
    if [[ "$TEST_PUSH_MODE" == quota ]]; then printf '%s\\n' 'remote: Repository is above its size quota' >&2; return 1; fi
    if [[ "$TEST_PUSH_MODE" == quota_race ]]; then printf '%s\\n' 'remote: Repository is above its size quota (fetch first)' >&2; return 1; fi
    if [[ "$TEST_PUSH_MODE" == uncertain ]]; then printf '%s\\n' 'connection lost after upload' >&2; return 1; fi
    if [[ "$TEST_PUSH_MODE" == race && "$task_pushes" == 1 ]]; then printf '%s\\n' '! [rejected] main -> main (fetch first)' >&2; return 1; fi
    return 0 ;;
   *) return 90 ;;
  esac
 }
 node() {
  if [[ "$1" == -e ]]; then printf '%s\\n' '1'; return 0; fi
  printf '%s\\n' "node $*" >> "$CALLS"
  if [[ "$1" == scripts/news/check-git-size.mjs ]]; then
   if [[ "$*" == *--base=* ]]; then [[ "$TEST_RANGE_FAIL" != true ]] || return 72;
   else task_staged=$((task_staged+1)); [[ "$task_staged" != "$TEST_STAGE_FAIL_AT" ]] || return 71; fi
   return 0
  fi
  [[ "$1" == scripts/news/publish-git.mjs ]] || return 91
 }
 npm() { printf '%s\\n' "npm $*" >> "$CALLS"; }
 npx() { printf '%s\\n' "npx $*" >> "$CALLS"; }
 gh() { printf '%s\\n' "gh $*" >> "$CALLS"; }
 `;
 const result=spawnSync('bash',['-c',doubles+'\n'+shell(name,steps[name])],{cwd:dir,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,CALLS:calls,GITHUB_OUTPUT:output,RUNNER_TEMP:dir,SLOT_NAME:'fixture',BASE_HEAD:'a'.repeat(40),COMMITTED_HEAD:'b'.repeat(40),AMENDED_HEAD:'c'.repeat(40),TEST_NO_CHANGE:'false',TEST_RANGE_FAIL:'false',TEST_STAGE_FAIL_AT:'0',TEST_RESTORE_FAIL:'false',TEST_PUSH_MODE:'success',SDG_EDITIONS_RECEIVED:'false',...extra}});
 return {...result,calls:fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n'):[]};
}
for(const name of Object.keys(steps))test(name+' blocks staged violations before a commit or publication',t=>{
 const result=execute(t,name,{TEST_STAGE_FAIL_AT:'1'});assert.equal(result.status,71,result.stderr);assert.ok(!result.calls.some(x=>x.startsWith('git commit')||x.startsWith('git push')||x.includes('publish-git.mjs')));
});
test('ticker stops before the size gate and commit if app projection restore fails',t=>{
 const result=execute(t,'wirkungsticker',{TEST_RESTORE_FAIL:'true'});assert.equal(result.status,73);assert.ok(!result.calls.some(x=>x.startsWith('node scripts/news/check-git-size.mjs')||x.startsWith('git commit')||x.includes('publish-git.mjs')));
});
for(const name of ['political-autopilot','quellenarchiv-sync','state-sustainability-sync'])test(name+' checks committed outgoing data even with an empty staging area',t=>{
 const result=execute(t,name,{TEST_RANGE_FAIL:'true'});assert.equal(result.status,72,result.stderr);assert.ok(result.calls.some(x=>x.startsWith('node scripts/news/check-git-size.mjs --base=')));assert.ok(!result.calls.some(x=>x.startsWith('git push')));
});
for(const name of ['political-autopilot','quellenarchiv-sync','state-sustainability-sync'])test(name+' pins the checked commit in its one successful push',t=>{
 const result=execute(t,name);assert.equal(result.status,0,result.stderr);const push=result.calls.find(x=>x.startsWith('git push'));assert.ok(push);assert.match(push,/git push origin [bc]{40}:refs\/heads\//);const pos=result.calls.indexOf(push);assert.match(result.calls[pos-1],/^node scripts\/news\/check-git-size\.mjs --base=/);
});
for(const mode of ['quota','quota_race','uncertain'])test('autopilot stops '+mode+' after the first provider outcome',t=>{
 const result=execute(t,'political-autopilot',{TEST_PUSH_MODE:mode});assert.equal(result.status,1,result.stderr);assert.equal(result.calls.filter(x=>x.startsWith('git push')).length,1);
});
test('an explicit concurrent-main rejection is integrated and gated once more',t=>{
 const result=execute(t,'political-autopilot',{TEST_PUSH_MODE:'race'});assert.equal(result.status,0,result.stderr);assert.equal(result.calls.filter(x=>x.startsWith('git push')).length,2);assert.equal(result.calls.filter(x=>x.startsWith('node scripts/news/check-git-size.mjs --base=')).length,2);
});
test('autopilot rechecks amended output before creating the amended commit',t=>{
 const result=execute(t,'political-autopilot',{TEST_STAGE_FAIL_AT:'2'});assert.equal(result.status,71);assert.equal(result.calls.filter(x=>x.startsWith('git commit')).length,1);assert.ok(!result.calls.some(x=>x.startsWith('git push')));
});
test('read-only storage preflight precedes the real paid/autopilot processing steps',()=>{
 for(const [name,later] of [['wirkungsticker','Set up pinned title-image rasterizer'],['political-autopilot','Process approvals and create new political deltas outside Vercel']]){
  const text=workflow(name);assert.ok(text.indexOf('name: Check repository storage before automatic processing')<text.indexOf('name: '+later));assert.match(block(name,'Check repository storage before automatic processing'),/GH_TOKEN:/);assert.match(block(name,'Check repository storage before automatic processing'),/--preflight/);
 }
});
const rssWorkflows = {
 'discord-journal-rss': {branch: 'discord-rss-state', path: '.github/discord-journal-state.json', feed: 'publish-journal-rss.mjs'},
 'discord-site-updates-rss': {branch: 'discord-site-updates-state', path: '.github/discord-site-updates-state.json', feed: 'publish-site-updates-rss.mjs'},
};
async function saveRss(t,name,{guid='fixture',size=104869655,missing=false}={}){
 const config=rssWorkflows[name],script=block(name,'Publish feed with durable state');
 // Bind these adapter checks to both workflows' actual module and state targets.
 assert.ok(script.includes('await import(moduleUrl("rss-publication.mjs"))'));
 assert.ok(script.includes('await import(moduleUrl("'+config.feed+'"))'));
 assert.match(script,/await publishGitHubRss\(\{/);
 assert.ok(script.includes('branch: "'+config.branch+'"'));
 assert.ok(script.includes('path: "'+config.path+'"'));
 const {publishGitHubRss}=await import('../../scripts/discord/rss-publication.mjs');
 const calls=[],request={repo:{owner:'sustynats',repo:'wirkungsoekonomie-produktiv'},sha:'a'.repeat(40)};
 const github={rest:{repos:{
  get:async()=>{calls.push('readRepo');return {data:{full_name:'sustynats/wirkungsoekonomie-produktiv',size}};},
  getContent:async body=>{assert.equal(body.path,config.path);assert.equal(body.ref,config.branch);calls.push('readContent');if(missing)throw {status:404};return {data:{type:'file',encoding:'base64',sha:'b'.repeat(40),content:Buffer.from('{"seen":[]}').toString('base64')}};},
  createOrUpdateFileContents:async body=>{calls.push({kind:'PUT',body});return {data:{content:{sha:'c'.repeat(40)}}};}
 },git:{
  getRef:async body=>{assert.equal(body.ref,'heads/'+config.branch);calls.push('readRef');throw {status:404};},
  createRef:async body=>{calls.push({kind:'REF',body});return {data:{}};}
 }}};
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(String(url),'https://discord.com/api/webhooks/123/fixture?wait=true');
  assert.equal(options.method,'POST');
  calls.push({kind:'POST'});return {ok:true};
 });
 let error=null;
 try{
  await publishGitHubRss({
   github,context:request,core:{info(){},notice(){}},branch:config.branch,path:config.path,
   loadFeed:async()=>[{guid}],payload:()=>({content:'fixture'}),
   webhookUrl:'https://discord.com/api/webhooks/123/fixture',stateOnly:false,
  });
 }catch(e){error=e;}
 return {calls,error,config};
}
for(const name of Object.keys(rssWorkflows)){
 test(name+' rejects an unreadable size before Contents, Ref or webhook writes',async t=>{
  const result=await saveRss(t,name,{size:null,missing:true});
  assert.match(result.error?.message||'',/REPOSITORY_SIZE_INVALID/);
  assert.deepEqual(result.calls,['readContent','readRepo']);
 });
 test(name+' rejects oversized exact state before repository admission or writes',async t=>{
  const result=await saveRss(t,name,{guid:'x'.repeat(524288),missing:true});
  assert.match(result.error?.message||'',/API_STATE_TOO_LARGE/);
  assert.deepEqual(result.calls,['readContent']);
 });
 test(name+' preserves one ordinary CAS update before its webhook',async t=>{
  const result=await saveRss(t,name);assert.equal(result.error,null);
  assert.deepEqual(result.calls.map(x=>typeof x==='string'?x:x.kind),['readContent','readRepo','PUT','POST']);
  const put=result.calls.find(x=>x?.kind==='PUT').body;
  assert.equal(put.sha,'b'.repeat(40));assert.equal(put.branch,result.config.branch);assert.equal(put.path,result.config.path);
  const saved=JSON.parse(Buffer.from(put.content,'base64'));
  assert.deepEqual(saved.seen,['fixture']);assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
 });
 test(name+' admits bootstrap content before creating a dedicated state ref',async t=>{
  const result=await saveRss(t,name,{missing:true});assert.equal(result.error,null);
  assert.deepEqual(result.calls.map(x=>typeof x==='string'?x:x.kind),['readContent','readRepo','readRef','REF','PUT']);
  const ref=result.calls.find(x=>x?.kind==='REF').body,put=result.calls.find(x=>x?.kind==='PUT').body;
  assert.equal(ref.ref,'refs/heads/'+result.config.branch);assert.equal(ref.sha,'a'.repeat(40));
  assert.equal(put.branch,result.config.branch);assert.equal(put.path,result.config.path);assert.equal(put.sha,undefined);
  assert.deepEqual(JSON.parse(Buffer.from(put.content,'base64')).seen,['fixture']);
 });
}
test('monitor sparse checkout includes all new policy and API guard imports',()=>{
 const text=workflow('ops-discord-monitor');for(const file of ['scripts/news/check-git-size.mjs','scripts/news/check-api-storage.mjs','docs/ops/GIT-STORAGE-POLICY.json'])assert.ok(text.includes(file));
});
