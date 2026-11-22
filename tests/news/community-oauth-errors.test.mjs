import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const origin='https://wirkungsoekonomie.de';
const names=['assets/js/woek-community-auth.js','assets/js/woek-community-auth-v2.js'];
function element(tag='a') { return {tag, attrs:{}, children:[], dataset:{},
  setAttribute(k,v){this.attrs[k]=String(v)},removeAttribute(k){delete this.attrs[k]},
  append(...v){this.children.push(...v)},replaceChildren(...v){this.children=[...v]}}; }
async function run(file,{blocked=false,blockedWrite=false,silentWrite=false,silentRotation=false,loggedOut=false,failPost=false,failStatus=false,fragment=''}={}) {
  const saved=new Map([['woek_discord_oauth_state:good',`${origin}/werkzeuge/faktencheck/`]]), calls=[],redirects=[];
  const session={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const values=new Map();
  const local={getItem(k){if(blocked)throw Error('blocked');return values.get(k)??null},setItem(k,v){if(blockedWrite)throw Error('blocked');if(!silentWrite&&!(silentRotation&&values.has(k)))values.set(k,v)}};
  const actions=element('div'),panel={dataset:{},querySelector:(s)=>s==='[data-community-actions]'?actions:null};
  const document={querySelectorAll:s=>s==='[data-community-auth]'?[panel]:[],createElement:element,createTextNode:t=>({textContent:t})};
  const location={origin,href:`${origin}/app/${fragment}`,pathname:'/app/',search:'',hash:fragment,assign:u=>redirects.push(u)};
  const window={location,sessionStorage:session,localStorage:local,crypto:{getRandomValues:a=>a.fill(1)},history:{replaceState(){}}};
  const fetch=async(url,init={})=>{calls.push({url,method:init.method||'GET'});if ((init.method==='POST'&&failPost)||(!init.method&&failStatus)) throw Error('offline');return {ok:true,json:async()=>({ok:true,token:silentRotation&&!init.method?'rotated':'synthetic',loggedIn:!(loggedOut&&!init.method),member:!(loggedOut&&!init.method)})}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{window,document,fetch,URL,URLSearchParams,Uint8Array,Math,Date});
  await new Promise(r=>setTimeout(r,5));
  return {panel,actions,calls,redirects,window};
}
for(const name of names){
  test(`${name} preserves an exchange failure rather than showing public state`,async()=>{
    const r=await run(name,{failPost:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'error');assert.equal(r.calls.length,1);assert.deepEqual(r.redirects,[]);
  });
  test(`${name} handles unreadable local storage without offering an unusable login`,async()=>{
    const r=await run(name,{blocked:true});
    assert.equal(r.panel.dataset.communityState,'storage-error');assert.equal(r.calls.length,0);
    assert.equal(r.actions.children[0].disabled,true);assert.equal(r.window.WoekCommunityAuth.token(),'');
    assert.deepEqual(Object.keys(r.window.WoekCommunityAuth.authHeaders()),[]);
  });
  test(`${name} does not claim success or redirect on failed status refresh`,async()=>{
    const r=await run(name,{failStatus:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'error');assert.equal(r.calls.length,2);assert.deepEqual(r.redirects,[]);
  });
  test(`${name} surfaces failed persistence and prevents a pointless repeat login`,async()=>{
    const r=await run(name,{blockedWrite:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'storage-error');assert.equal(r.calls.length,1);assert.deepEqual(r.redirects,[]);
    assert.equal(r.actions.children[0].disabled,true);
  });
  test(`${name} rejects a successful HTTP status that reports logged out`,async()=>{
    const r=await run(name,{loggedOut:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'public');assert.equal(r.calls.length,2);assert.deepEqual(r.redirects,[]);
  });
  test(`${name} refuses success if browser silently discards saved token`,async()=>{
    const r=await run(name,{silentWrite:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'storage-error');assert.equal(r.calls.length,1);assert.deepEqual(r.redirects,[]);
  });
  test(`${name} refuses success if browser silently discards a rotated session`,async()=>{
    const r=await run(name,{silentRotation:true,fragment:'#access_token=fake&state=good'});
    assert.equal(r.panel.dataset.communityState,'storage-error');assert.equal(r.calls.length,2);assert.deepEqual(r.redirects,[]);
  });
}
