import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsletterServer } from '../server.mjs';

const headers = { Origin: 'https://wirkungsoekonomie.de', 'Content-Type': 'application/json' };
const subscription = '12345678-1234-1234-1234-123456789abc', token = 'T'.repeat(43);
async function fixture(t, overrides = {}) {
  const calls = [];
  const server = createNewsletterServer({
    ready: () => true,
    parse: input => { if (!input?.consent || !input.email?.includes('@')) throw Error('invalid'); return { website: '', ...input }; },
    subscribe: async input => { calls.push(input); return { outcome: 'accepted', delivery: 'sent' }; },
    confirm: async () => ({ outcome: 'confirmed', session: { recognitionToken: 'PRIVATE' } }),
    unsubscribe: async () => ({ outcome: 'unsubscribed' }),
    isConfirmationError: () => false,
    onDeliveryFailure: () => {}, client: '/* fixture */', ...overrides,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, request: (path = '', init = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/woek-newsletter${path}`, { headers, ...init }), server };
}
test('health reflects verified SMTP availability without sending mail', async t => {
  const s = await fixture(t, { ready: () => false });
  assert.deepEqual(await (await s.request()).json(), { state: 'unknown', signup_available: false });
  const r = await s.request('', { method: 'POST', body: JSON.stringify({ email: 'reader@example.invalid', consent: true }) });
  assert.equal(r.status, 503); assert.equal(s.calls.length, 0);
});
test('invalid consent, origin, body and content type cannot subscribe', async t => {
  const s = await fixture(t);
  for (const [init, status] of [
    [{ method: 'POST', body: JSON.stringify({ email: 'reader@example.invalid', consent: false }) }, 400],
    [{ method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' }, 403],
    [{ method: 'POST', body: '{broken' }, 400],
    [{ method: 'POST', body: 'x'.repeat(5000) }, 413],
    [{ method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }, 415],
  ]) assert.equal((await s.request('', init)).status, status);
  assert.equal(s.calls.length, 0);
});
test('accepts once and throttles repeated signup before another delivery', async t => {
  const s = await fixture(t);
  const init = { method: 'POST', body: JSON.stringify({ email: 'reader@example.invalid', consent: true }) };
  const r = await s.request('', init);
  assert.equal(r.status, 202); assert.equal(r.headers.get('Access-Control-Allow-Origin'), headers.Origin);
  assert.deepEqual(await r.json(), { outcome: 'accepted', delivery: 'sent' });
  assert.equal((await s.request('', init)).status, 429); assert.equal(s.calls.length, 1);
});
test('failed SMTP delivery updates health and never claims success', async t => {
  let failed = 0;
  const s = await fixture(t, { subscribe: async () => ({ outcome: 'accepted', delivery: 'not_sent' }), onDeliveryFailure: () => failed++ });
  const r = await s.request('', { method: 'POST', body: JSON.stringify({ email: 'reader@example.invalid', consent: true }) });
  assert.equal((await r.json()).delivery, 'not_sent'); assert.equal(failed, 1);
});
test('confirmation and optout require valid tokens; private session stays server-side', async t => {
  const s = await fixture(t);
  assert.equal((await s.request('/bestaetigen', { method: 'POST', body: '{}' })).status, 400);
  const body = JSON.stringify({ subscription, token });
  const r = await s.request('/bestaetigen', { method: 'POST', body });
  assert.deepEqual(await r.json(), { outcome: 'confirmed' }); assert.equal(r.headers.get('set-cookie'), null);
  assert.deepEqual(await (await s.request('/abmelden', { method: 'POST', body })).json(), { outcome: 'unsubscribed' });
  const page = await fetch(`http://127.0.0.1:${s.server.address().port}/woek-newsletter/bestaetigen?subscription=${subscription}&token=${token}`);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /data-woek-newsletter-landing="confirm"/);
});
