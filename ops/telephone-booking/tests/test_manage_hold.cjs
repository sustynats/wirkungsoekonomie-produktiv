const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  const byId = new Map();
  const actions = new Map();
  const make = () => ({ hidden: false, disabled: false, textContent: '', value: '', href: '', children: [],
    replaceChildren() { this.children = []; }, append(...v) { this.children.push(...v); }, addEventListener() {} });
  for (const name of ['approve', 'decline', 'cancel', 'sent', 'send_confirmation_email']) actions.set(name, make());
  const document = { getElementById(id) { if (!byId.has(id)) byId.set(id, make()); return byId.get(id); },
    querySelector(sel) { return actions.get(sel.match(/data-action="([^"]+)"/)[1]); },
    querySelectorAll() { return [...actions.values()]; }, createElement() { return make(); } };
  const context = vm.createContext({ document, location: { hash:'', pathname:'/manage' }, history: { replaceState() {} },
    Intl, Date, AbortSignal, encodeURIComponent, setTimeout, confirm: () => true, navigator: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/manage.js'), 'utf8'), context);
  return { context, byId, actions };
}
const payload = { name:'Synthetic User', start:'2026-11-10T09:00:00Z', channel:'phone',
  phone:'+4915100000000', discord:'', email:'synthetic@example.org', replyVia:'email', topic:'praxis',
  background:'synthetic', questions:'synthetic', outcome:'synthetic' };
function record(status, calendarState) {
  return { payload, status, calendarState, reference:'deadbeef', expires:'2026-11-09T09:00:00Z',
    verified:true, discordVerified:false, confirmationSent:null };
}
test('every held calendar state hides all decisions, contact drafts and calendar downloads', () => {
  for (const [status, state] of [['pending','approve_hold'], ['confirmed','cancel_synced_hold'], ['confirmed','cancel_manual_hold']]) {
    const { context, byId, actions } = fixture();
    context.render(record(status,state));
    for (const action of actions.values()) assert.equal(action.hidden,true);
    for (const name of ['reply','download','email','participant-download','participant-calendar-info']) assert.equal(byId.get(name).hidden,true);
    assert.match(byId.get('state').textContent,/ungeklärt/);
    assert.match(byId.get('message').textContent,/nicht wiederholen/);
  }
});
test('non-held pending and synced-confirmed records retain their expected actions', () => {
  const { context, byId, actions } = fixture();
  context.render(record('pending','none'));
  assert.equal(actions.get('approve').hidden,false);
  assert.equal(actions.get('decline').hidden,false);
  context.render(record('confirmed','synced'));
  assert.equal(actions.get('cancel').hidden,false);
  assert.equal(byId.get('reply').hidden,false);
  assert.equal(byId.get('download').hidden,true);
});
test('an uncertain cancellation immediately hides a previously confirmed reply and actions', async () => {
  const { context, byId, actions } = fixture();
  context.render(record('confirmed','synced'));
  assert.equal(byId.get('reply').hidden,false);
  context.fetch = async () => { throw new Error('synthetic lost response'); };
  await context.run('cancel');
  for (const action of actions.values()) assert.equal(action.hidden,true);
  for (const name of ['reply','download','email','participant-download','participant-calendar-info']) assert.equal(byId.get(name).hidden,true);
  assert.match(byId.get('state').textContent,/ungeklärt/);
  assert.match(byId.get('message').textContent,/nicht sicher/);
  context.render(record('confirmed','synced'));
  assert.equal(actions.get('cancel').hidden,false);
  assert.equal(byId.get('reply').hidden,false);
});
test('confirmation preview is exact and uncertain delivery cannot be resent', () => {
  const { context, byId, actions } = fixture();
  const row = {...record('confirmed','synced'), confirmationDelivery:'not_sent',
    confirmationPreview:{email:'synthetic@example.org', subject:'Bestätigung', body:'Synthetische Vorschau'}};
  context.render(row);
  assert.equal(actions.get('send_confirmation_email').hidden,false);
  assert.equal(byId.get('email').hidden,true);
  assert.equal(byId.get('copy').hidden,true);
  assert.match(byId.get('email-preview').textContent,/synthetic@example.org/);
  assert.equal(byId.get('draft').value,'Synthetische Vorschau');
  for (const state of ['queued','unknown']) {
    context.render({...row, confirmationDelivery:state});
    assert.equal(actions.get('send_confirmation_email').hidden,true);
    assert.equal(actions.get('cancel').hidden,true);
    assert.equal(actions.get('sent').hidden,true);
  }
});

test('cancelled and declined previews send only the displayed decision and never resend a hold', async () => {
  for (const status of ['cancelled', 'declined']) {
    const { context, byId, actions } = fixture();
    const row = {...record(status,'none'), confirmationDelivery:'not_sent',
      confirmationPreview:{email:'synthetic@example.org',subject:'Absage',body:'Synthetische Absage'}};
    context.render(row);
    assert.equal(actions.get('send_confirmation_email').hidden,false);
    assert.match(actions.get('send_confirmation_email').textContent,/Absage/);
    assert.equal(byId.get('email').hidden,true);
    assert.equal(byId.get('copy').hidden,true);
    assert.equal(byId.get('draft').value,'Synthetische Absage');
    let sent;
    context.fetch = async (_url, options) => { sent = JSON.parse(options.body); return {ok:true,json:async()=>({...row,confirmationDelivery:'queued'})}; };
    await context.run('send_confirmation_email');
    assert.equal(sent.action,'send_confirmation_email');
    assert.equal(sent.expectedStatus,status);
    for (const state of ['queued','unknown']) {
      context.render({...row,confirmationDelivery:state});
      assert.equal(actions.get('send_confirmation_email').hidden,true);
    }
  }
});
