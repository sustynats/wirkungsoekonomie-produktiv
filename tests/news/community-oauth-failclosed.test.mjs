import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const scripts = ['assets/js/woek-community-auth.js', 'assets/js/woek-community-auth-v2.js'];
const origin = 'https://wirkungsoekonomie.de';
function element(tag='a') {
  return {tag, attrs: {}, children: [], dataset: {}, className: '', textContent: '',
    setAttribute(k,v) { this.attrs[k]=String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children=[...nodes]; }};
}
async function execute(script, { crypto, storageBlocked = false, fragment = '' } = {}) {
  const entries = new Map(), calls = [], replacements = [];
  const session = { getItem(k) { if (storageBlocked) throw Error('blocked'); return entries.get(k) ?? null; },
    setItem(k,v) { if (storageBlocked) throw Error('blocked'); entries.set(k,v); },
    removeItem(k) { if (storageBlocked) throw Error('blocked'); entries.delete(k); } };
  const actions = element('div'), existing = element(), panel = { dataset: {},
    querySelector: (s) => s === '[data-community-actions]' ? actions : null };
  const document = { querySelectorAll: (s) => s === '[data-community-auth]' ? [panel] :
      s === '[data-community-login]' ? [existing] : [],
    createElement: (tag) => element(tag), createTextNode: (text) => ({text}) };
  const location = { origin, href: `${origin}/app/${fragment}`, pathname:'/app/', search:'', hash:fragment, assign() {} };
  const window = { location, crypto, sessionStorage:session,
    localStorage: {getItem:()=>null, setItem() {}}, history: {replaceState:(...a)=>replacements.push(a)} };
  const fetch = async (...a) => { calls.push(a); throw Error('unexpected'); };
  vm.runInNewContext(fs.readFileSync(script,'utf8'), {window,document,fetch,URL,URLSearchParams,Uint8Array,Math,Date});
  await new Promise(resolve=>setTimeout(resolve,5));
  return {entries,calls,replacements,actions,existing};
}
for (const script of scripts) {
  for (const [name,crypto,storageBlocked] of [
    ['missing crypto',undefined,false],
    ['failing crypto',{getRandomValues(){throw Error('unavailable')}},false],
    ['blocked session storage',{getRandomValues(a){a.fill(7)}},true]
  ]) test(`${script}: ${name} disables OAuth rather than generating an unsafe state`, async () => {
    const r=await execute(script,{crypto,storageBlocked});
    assert.equal(r.entries.size,0);
    assert.equal(r.calls.length,0);
    assert.equal(r.actions.children[0].tag,'button');
    assert.equal(r.actions.children[0].disabled,true);
    assert.equal(r.existing.attrs['aria-disabled'],'true');
    assert.equal(r.existing.attrs.href,undefined);
  });
  test(`${script}: functioning crypto produces a state-bound Discord link`,async()=>{
    const r=await execute(script,{crypto:{getRandomValues(a){a.fill(7)}}});
    const u=new URL(r.actions.children[0].href);
    assert.equal(u.hostname,'discord.com');
    assert.equal(u.searchParams.get('state'),'07'.repeat(16));
    assert.equal(r.entries.get('woek_discord_oauth_state:'+u.searchParams.get('state')),origin+'/app/');
  });
  test(`${script}: blocked storage still removes OAuth token fragment before stopping`,async()=>{
    const r=await execute(script,{crypto:{getRandomValues(a){a.fill(7)}},storageBlocked:true,fragment:'#access_token=fake&state=fake'});
    assert.equal(r.replacements.length,1);
    assert.equal(r.calls.length,0);
  });
}
