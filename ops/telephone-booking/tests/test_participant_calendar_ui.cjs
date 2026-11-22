const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preview = JSON.parse(fs.readFileSync(path.join(__dirname, 'participant-calendar-preview.fixture.json'), 'utf8'));
function fixture() {
  const ids = new Map(); const actions = new Map();
  const calls = { fetch: 0, copied: [], blobs: [], downloads: [], revoked: [] };
  const make = () => ({ hidden:false, disabled:false, textContent:'', value:'', href:'', children:[], events:{},
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
    addEventListener(name, callback) { this.events[name] = callback; },
    click() { calls.downloads.push({ href:this.href, download:this.download }); } });
  for (const action of ['approve','decline','cancel','sent','send_confirmation_email']) actions.set(action, make());
  const document = {
    getElementById(id) { if (!ids.has(id)) ids.set(id,make()); return ids.get(id); },
    querySelector(selector) { return actions.get(selector.match(/data-action="([^"]+)"/)[1]); },
    querySelectorAll() { return [...actions.values(), ...ids.values()]; }, createElement() { return make(); },
  };
  const context = vm.createContext({ document, location:{hash:'',pathname:'/manage'}, history:{replaceState(){}},
    Intl, Date, AbortSignal, Blob, encodeURIComponent, confirm:()=>true,
    setTimeout(callback) { callback(); },
    URL:{createObjectURL(blob) { calls.blobs.push(blob); return `blob:synthetic-${calls.blobs.length}`; },
      revokeObjectURL(url) { calls.revoked.push(url); }},
    navigator:{clipboard:{async writeText(text) { calls.copied.push(text); }}},
    fetch() { calls.fetch += 1; throw new Error('Unexpected synthetic network action'); },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/manage.js'),'utf8'),context);
  return { context, ids, actions, calls };
}

test('confirmed Discord preview copies actual server notice with all provider links', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../templates/manage.html'),'utf8');
  for (const id of ['participant-download','participant-calendar-info']) assert.equal(html.split(`id="${id}"`).length,2);
  const { context, ids, actions, calls } = fixture(); context.render(preview);
  assert.equal(ids.get('draft').value, preview.confirmationPreview.body);
  assert.equal(ids.get('copy').hidden,false);
  assert.equal(actions.get('send_confirmation_email').hidden,true);
  assert.equal(ids.get('participant-download').hidden,false);
  await ids.get('copy').events.click();
  assert.equal(calls.copied[0],preview.confirmationPreview.body);
  for (const link of preview.confirmationPreview.calendar.links) assert.ok(calls.copied[0].includes(link.url));
  assert.equal(calls.fetch,0);
});

test('participant download uses the neutral preview ICS Blob without API or bearer', async () => {
  const { context, ids, calls } = fixture(); context.render(preview);
  ids.get('participant-download').events.click();
  assert.equal(calls.blobs.length,1);
  assert.equal(calls.blobs[0].type,'text/calendar;charset=utf-8');
  const ics = await calls.blobs[0].text();
  assert.equal(ics, preview.confirmationPreview.calendar.ics);
  for (const privateValue of ['PRIVATE_OWNER_BEARER','private-person@example.test','0123456789abcdef','/manage']) assert.ok(!ics.includes(privateValue));
  assert.equal(calls.downloads[0].download,'gespraech-natalie-weber.ics');
  assert.deepEqual(calls.revoked,['blob:synthetic-1']);
  assert.equal(calls.fetch,0);
});

test('cancelled, held and unknown views cannot produce a participant download', () => {
  for (const state of ['cancelled','held','unknown']) {
    const { context, ids, calls } = fixture();
    context.render(state === 'cancelled' ? {...preview,status:'cancelled',calendarState:'none',confirmationPreview:null} :
      state === 'held' ? {...preview,calendarState:'cancel_synced_hold'} : preview);
    if (state === 'unknown') context.lockUnknownCalendarView();
    assert.equal(ids.get('participant-download').hidden,true);
    assert.equal(ids.get('participant-calendar-info').hidden,true);
    ids.get('participant-download').events.click();
    assert.equal(calls.blobs.length,0); assert.equal(calls.fetch,0);
  }
});

test('combined recovery controls retain approve-only before a confirmed participant import', () => {
  const { context, ids, actions, calls } = fixture();
  context.render({...preview, status:'pending', recoveryRequired:true, calendarState:'none', confirmationPreview:null});
  assert.equal(actions.get('approve').hidden,false);
  assert.equal(actions.get('decline').hidden,true);
  assert.equal(ids.get('participant-download').hidden,true);
  context.render(preview);
  assert.equal(actions.get('approve').hidden,true);
  assert.equal(actions.get('decline').hidden,true);
  assert.equal(ids.get('participant-download').hidden,false);
  assert.equal(ids.get('draft').value,preview.confirmationPreview.body);
  assert.equal(calls.fetch,0);
});
