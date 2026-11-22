const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').resolve(__dirname, '../../assets/js/newsletter.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor() { this.dataset = {}; this.textContent = ''; this.hidden = false; this.events = {}; this.attributes = {}; this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) }; }
  addEventListener(name, cb) { this.events[name] = cb; }
  setAttribute(name, value) { this.attributes[name] = value; }
  scrollIntoView() {}
}
class Button extends Element { constructor() { super(); this.disabled = false; } }
class Form extends Element {
  constructor(button) { super(); this.button = button; }
  querySelector(s) { return s === "button[type='submit']" ? this.button : null; }
  reportValidity() { return true; }
}
function setup(fetch, {landingAction, search = '', hostname = 'wirkungsoekonomie.de'} = {}) {
  const button = new Button(), form = new Form(button), message = new Element(), welcome = new Element(), root = new Element();
  root.dataset.apiOrigin = 'https://parlament.wirkungsoekonomie.de';
  root.querySelector = s => ({ '[data-woek-newsletter-form]': form, '[data-woek-newsletter-message]': message, '[data-woek-newsletter-welcome]': welcome })[s] || null;
  const landing = landingAction ? new Element() : null;
  if (landing) { landing.dataset.woekNewsletterLanding = landingAction; landing.querySelector = s => ({ '[data-woek-newsletter-landing-action]': button, '[data-woek-newsletter-landing-message]': message })[s] || null; }
  const navigations = [];
  const document = {createElement: () => ({click() { navigations.push({href:this.href,referrerPolicy:this.referrerPolicy}); }, remove() {}}), body: {appendChild() {}}, title: 'test', querySelector: s => s === '[data-woek-newsletter-landing]' ? landing : s === '[data-woek-newsletter]' ? root : null, querySelectorAll: () => [] };
  const window = {location: { search, pathname: '/wissen/test.html', hostname }, history: {replaceState() {}}, setTimeout};
  class FormData { get(k) { return ({email:'reader@example.invalid',consent:'on',website:''})[k]; } }
  vm.runInNewContext(source, {document, window, fetch, HTMLElement: Element, HTMLButtonElement: Button, HTMLFormElement: Form, FormData, URLSearchParams, Error, TypeError});
  return { button, form, message, welcome, root, landing, navigations };
}
const reply = data => ({ok:true,json:async()=>data});


const subscription='12345678-1234-1234-1234-123456789abc', token='T'.repeat(43), unsubscribe='U'.repeat(43);
const query=`?subscription=${subscription}&token=${token}&unsubscribe_token=${unsubscribe}`;
const submit=s=>s.form.events.submit({preventDefault(){}});
test('signup uses fixed Oracle host, credentials omit, existing accepted consent source',async()=>{
 const calls=[];const s=setup(async(url,options={})=>{calls.push({url,options});return calls.length===1?reply({state:'active',signup_available:true}):reply({outcome:'accepted',delivery:'sent'});});await tick();
 assert.equal(s.form.hidden,false);assert.equal(s.welcome.hidden,true);await submit(s);
 assert.equal(calls.length,2);for(const c of calls){assert.equal(c.url,'https://130.162.217.58.sslip.io/api/woek-newsletter');assert.equal(c.options.credentials,'omit');}
 assert.equal(JSON.parse(calls[1].options.body).consent_source,'wirkungsoekonomie.de/');assert.equal(s.button.disabled,true);await submit(s);assert.equal(calls.length,2);
});
test('signup blocks simultaneous requests before state rerender',async()=>{
 let resolve,calls=0;const s=setup(async()=>{calls++;if(calls===1)return reply({signup_available:true});return new Promise(r=>resolve=r);});await tick();const first=submit(s);await submit(s);assert.equal(calls,2);resolve(reply({outcome:'accepted',delivery:'sent'}));await first;
});
for(const result of [{outcome:'already_pending'},{outcome:'already_active'},{outcome:'accepted',delivery:'not_sent'},{outcome:'contact_required'}])test(`no repeated signup after ${result.outcome}/${result.delivery}`,async()=>{let calls=0;const s=setup(async()=>++calls===1?reply({signup_available:true}):reply(result));await tick();await submit(s);await submit(s);assert.equal(calls,2);assert.equal(s.button.disabled,true);});
test('network uncertainty blocks blind signup retries',async()=>{let calls=0;const s=setup(async()=>{if(++calls===1)return reply({signup_available:true});throw new TypeError('network');});await tick();await submit(s);await submit(s);assert.equal(calls,2);assert.match(s.message.textContent,/keine sichere/);});
test('definitive validation rejection permits corrected signup',async()=>{let calls=0;const s=setup(async()=>++calls===1?reply({signup_available:true}):{ok:false,status:400,json:async()=>({error:'Adresse prüfen'})});await tick();await submit(s);assert.equal(s.button.disabled,false);await submit(s);assert.equal(calls,3);});
test('unavailable backend prevents signup',async()=>{let calls=0;const s=setup(async()=>{calls++;throw new TypeError('network');});await tick();await submit(s);assert.equal(calls,1);assert.equal(s.button.disabled,true);});
test('static confirm does not POST, preserves optout token, drops unrelated query, only once',async()=>{let calls=0;const s=setup(async()=>{calls++;},{landingAction:'confirm',search:query+'&next=https%3A%2F%2Fevil.example&email=private'});assert.equal(s.navigations.length,0);await s.button.events.click();await s.button.events.click();assert.equal(calls,0);assert.equal(s.navigations.length,1);const n=s.navigations[0],u=new URL(n.href);assert.equal(u.origin,'https://130.162.217.58.sslip.io');assert.equal(u.pathname,'/woek-newsletter/bestaetigen');assert.equal(u.searchParams.get('unsubscribe_token'),unsubscribe);assert.equal(u.searchParams.has('email'),false);assert.equal(u.searchParams.has('next'),false);assert.equal(n.referrerPolicy,'no-referrer');assert.notEqual(s.landing.dataset.state,'complete');});
test('static unsubscribe navigates to dedicated optout route and excludes extra optout token',async()=>{const s=setup(()=>{throw Error('must not POST')},{landingAction:'unsubscribe',search:query});await s.button.events.click();const u=new URL(s.navigations[0].href);assert.equal(u.pathname,'/woek-newsletter/abmelden');assert.equal(u.searchParams.has('unsubscribe_token'),false);});
for(const bad of ['?subscription=invalid&token='+token,query+'&token='+token,'?delivery=campaign&token='+token,'?subscription='+subscription+'&token=https://evil.example'])test(`invalid or separate-contract callback never navigates: ${bad.slice(0,25)}`,()=>{const s=setup(()=>{throw Error('must not POST')},{landingAction:'unsubscribe',search:bad});assert.equal(s.button.disabled,true);assert.equal(s.navigations.length,0);assert.equal(s.button.events.click,undefined);});
test('unknown source host cannot relay',()=>{const s=setup(()=>{}, {landingAction:'confirm',search:query,hostname:'evil.example'});assert.equal(s.button.disabled,true);assert.equal(s.button.events.click,undefined);});
test('same backend host uses validated relative POST and blocks completed repetition',async()=>{let calls=0;const s=setup(async(url,options)=>{calls++;assert.equal(url,'/api/woek-newsletter/bestaetigen');assert.equal(JSON.parse(options.body).unsubscribe_token,unsubscribe);return reply({outcome:'confirmed'});},{landingAction:'confirm',search:query,hostname:'woek-parlament.vercel.app'});await s.button.events.click();await s.button.events.click();assert.equal(calls,1);assert.equal(s.landing.dataset.state,'complete');});
test('same backend uncertain response leaves callback locked',async()=>{let calls=0;const s=setup(async()=>{calls++;throw TypeError('timeout');},{landingAction:'unsubscribe',search:query,hostname:'woek-parlament.vercel.app'});await s.button.events.click();await s.button.events.click();assert.equal(calls,1);assert.equal(s.button.disabled,true);assert.notEqual(s.landing.dataset.state,'complete');});

test('Oracle confirmation uses same-origin POST',async()=>{const s=setup(async(url)=>{assert.equal(url,'/api/woek-newsletter/bestaetigen');return reply({outcome:'confirmed'});},{landingAction:'confirm',search:query,hostname:'130.162.217.58.sslip.io'});await s.button.events.click();assert.equal(s.landing.dataset.state,'complete');});
