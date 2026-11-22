import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('production pruner keeps the public booking JS and still removes mjs', () => {
  const source=fs.readFileSync('scripts/quality/build-public-artifact.mjs','utf8');
  const start=source.indexOf('function prunePublicArtifact() {');
  // Isolate the function, not unrelated initialization added before the build.
  // Nested blocks are indented; the first column-zero closing brace ends it.
  const end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0 && end>start,'exact production pruner function is available');
  const code=source.slice(start,end);
  assert.match(code,/const forbiddenExtensions = new Set\(\["\.env", "\.mjs"/);
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'booking-pruner-fixture-'));
  try {
    const asset=path.join(folder,'assets/js/telephone-booking.js');
    const rejected=path.join(folder,'assets/js/telephone-booking.mjs');
    const html=path.join(folder,'w/natalie-weber/index.html');
    fs.mkdirSync(path.dirname(asset),{recursive:true});fs.mkdirSync(path.dirname(html),{recursive:true});
    const data=fs.readFileSync('assets/js/telephone-booking.js');
    const page=fs.readFileSync('w/natalie-weber/index.html','utf8');
    fs.writeFileSync(asset,data);fs.writeFileSync(rejected,data);fs.writeFileSync(html,page);
    assert.match(page,/src="\.\.\/\.\.\/assets\/js\/telephone-booking\.js"/);
    assert.match(page,/Bei einer ungeklärten Kalenderübertragung bleiben die betroffenen Daten vorerst zur Klärung gespeichert\./);
    const dest=new URL('../../assets/js/telephone-booking.js','https://wirkungsoekonomie.de/w/natalie-weber/');
    assert.equal(dest.pathname,'/assets/js/telephone-booking.js');
    const walkFiles=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walkFiles(path.join(dir,e.name)):[path.join(dir,e.name)]);
    const ctx={fs,path,artifactDir:folder,publicReleaseAssets:new Map(),console:{log:()=>{}},
      walkFiles,toPosixRelative:(f)=>path.relative(folder,f).split(path.sep).join('/'),
      collectArtifactReferences:()=>new Set(['assets/js/telephone-booking.js']),
      removeFile:(f)=>fs.unlinkSync(f)};
    vm.runInNewContext(code+'\nprunePublicArtifact();',ctx,{timeout:5000});
    assert.deepEqual(fs.readFileSync(asset),data);
    assert.equal(fs.existsSync(rejected),false);
    assert.equal(fs.readFileSync(html,'utf8'),page);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

// Execute the actual public script with a small DOM and fake fetch only.
function bookingChannelFixture(responses) {
  const calls=[];
  function element(value='') {
    const events=new Map();
    return { value, textContent:'', disabled:false, required:false, hidden:false, checked:false, children:[],
      addEventListener(name,fn) {events.set(name,fn);},
      fire(name,event={}) {return events.get(name)?.(event);},
      setAttribute() {}, focus() {}, append(...nodes) {this.children.push(...nodes);},
      replaceChildren(...nodes) {this.children=[...nodes];},
      querySelectorAll() {return this.children;}, reportValidity() {return true;} };
  }
  const channel=element('phone'),replyVia=element('email'),discordOption=element('discord'),replyDiscord=element('discord');
  discordOption.textContent='Discord-Sprachanruf (nur Audio)';replyDiscord.disabled=true;
  channel.querySelector=()=>discordOption;replyVia.querySelector=()=>replyDiscord;
  const fields={channel,replyVia,phone:element('+4915100000000'),discord:element('synthetic'),
    name:element('Synthetic User'),email:element('synthetic@example.invalid'),topic:element('praxis'),
    background:element('Synthetic context'),questions:element('Synthetic question'),outcome:element('Synthetic outcome'),acknowledged:element('on')};
  fields.phone.required=true;fields.discord.disabled=true;fields.acknowledged.checked=true;
  const form=element();form.elements=fields;
  const nodes=new Map([['form',form],...['status','result','retry','submit','days','slots','selection'].map(name=>[`[data-booking-${name}]`,element()]),['[data-phone-label]',element()],['[data-discord-label]',element()]]);
  const root={dataset:{endpoint:'https://booking.example.invalid/api/telephone-booking'},querySelector:selector=>nodes.get(selector)};
  const slot={date:'2026-11-12',start:'2026-11-12T09:00:00Z',end:'2026-11-12T09:30:00Z'};
  let responseIndex=0;
  const context=vm.createContext({document:{querySelector:()=>root,createElement:()=>element()},Intl,Date,Map,
    crypto:{randomUUID:()=> 'synthetic-request-id'},AbortSignal:{timeout:()=>({})},
    FormData:class {constructor(){this.values=Object.entries(fields).filter(([,node])=>!node.disabled).map(([name,node])=>[name,node.value]);}*[Symbol.iterator](){yield* this.values;}},
    fetch:async(url,options)=>{
      calls.push({url,options});
      if(url.endsWith('/slots'))return {ok:true,status:200,json:async()=>({slots:[slot],...(responses[Math.min(responseIndex++,responses.length-1)]||{})})};
      if(url.endsWith('/requests'))return {ok:true,status:202,json:async()=>({status:'unverified',verification:'email',reference:'synthetic-only'})};
      throw new Error('Unexpected fake URL');
    }});
  vm.runInContext(fs.readFileSync('assets/js/telephone-booking.js','utf8'),context,{timeout:1000});
  return {form,fields,nodes,discordOption,replyDiscord,calls,slot,
    ready:()=>new Promise(resolve=>setImmediate(resolve)),
    change(value) {channel.value=value;channel.fire('change');},
    pickSlot() {nodes.get('[data-booking-days]').children[0].fire('click');nodes.get('[data-booking-slots]').children[0].fire('click');},
    reload() {return nodes.get('[data-booking-retry]').fire('click');},
    submit() {return form.fire('submit',{preventDefault(){}});} };
}

test('legacy and malformed slot capabilities leave Discord unavailable and phone usable',async()=>{
  for(const capabilities of [{},{supportedChannels:null},{supportedChannels:'discord'},{supportedChannels:['phone']}]) {
    const f=bookingChannelFixture([capabilities]);
    assert.equal(f.discordOption.disabled,true,'disabled before the slot request resolves');
    await f.ready();
    assert.equal(f.form.hidden,false);
    assert.equal(f.discordOption.disabled,true);
    assert.match(f.discordOption.textContent,/derzeit nicht verfügbar/);
    f.change('discord');
    assert.equal(f.fields.channel.value,'phone');
    assert.equal(f.fields.phone.disabled,false);assert.equal(f.fields.phone.required,true);
    assert.equal(f.fields.discord.disabled,true);assert.equal(f.replyDiscord.disabled,true);
    assert.equal(f.calls.filter(call=>call.options.method==='POST').length,0);
  }
});

test('explicit supportedChannels enables the existing Discord controls',async()=>{
  const f=bookingChannelFixture([{supportedChannels:['phone','discord']}]);await f.ready();
  assert.equal(f.discordOption.disabled,false);
  assert.equal(f.discordOption.textContent,'Discord-Sprachanruf (nur Audio)');
  f.change('discord');
  assert.equal(f.fields.channel.value,'discord');assert.equal(f.fields.phone.disabled,true);
  assert.equal(f.fields.discord.disabled,false);assert.equal(f.fields.discord.required,true);
  assert.equal(f.replyDiscord.disabled,false);
});

test('legacy slots retain the ordinary phone request payload and email confirmation flow',async()=>{
  const f=bookingChannelFixture([{}]);await f.ready();f.pickSlot();await f.submit();
  const posts=f.calls.filter(call=>call.options.method==='POST');assert.equal(posts.length,1);
  const payload=JSON.parse(posts[0].options.body);
  assert.equal(payload.channel,'phone');assert.equal(payload.phone,'+4915100000000');
  assert.equal(payload.replyVia,'email');assert.equal(payload.start,f.slot.start);
  assert.equal(payload.requestId,'synthetic-request-id');assert.equal(payload.acknowledged,true);
  assert.equal(Object.hasOwn(payload,'discord'),false);
  assert.match(f.nodes.get('[data-booking-result]').textContent,/E-Mail mit Bestätigungslink/);
});

test('a later capability withdrawal resets a selected Discord flow to phone',async()=>{
  const f=bookingChannelFixture([{supportedChannels:['phone','discord']},{}]);await f.ready();
  f.change('discord');f.fields.replyVia.value='discord';await f.reload();
  assert.equal(f.discordOption.disabled,true);assert.equal(f.fields.channel.value,'phone');
  assert.equal(f.fields.replyVia.value,'email');assert.equal(f.fields.discord.disabled,true);
  assert.equal(f.fields.phone.required,true);assert.equal(f.fields.phone.disabled,false);
});
