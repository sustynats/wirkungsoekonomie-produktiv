import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const app = path.resolve(import.meta.dirname, '../../../woek-parlament-app');
const result = await build({
  entryPoints: [path.join(app, 'lib/woek-newsletter/subscriptions.ts')], bundle: true,
  platform: 'node', format: 'esm', write: false, alias: { '@': app },
  plugins: [{ name: 'isolated-subscription-fixture', setup(build) {
    build.onResolve({ filter: /^zod$/ }, () => ({ path: require.resolve('zod') }));
    build.onResolve({ filter: /^(nodemailer|.*database\/supabase-admin)$/ }, args => ({ path: args.path.includes('supabase-admin') ? 'database' : 'smtp', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'smtp'
      ? `export default {createTransport(options){globalThis.fixture.transport=options;return {async sendMail(message){if(globalThis.fixture.fail)throw Error('Synthetic SMTP failure');globalThis.fixture.messages.push(message);}};}}`
      : `export async function supabaseRpc(){return;} export async function supabaseRest(p,o={}){return globalThis.fixture.database(p,o);}` }));
  } }],
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
function setup() {
  const state = { row: null, messages: [], events: [], fail: false,
    async database(p, o) {
      if (p.includes('subscription_events')) { this.events.push(JSON.parse(o.body)); return; }
      if (o.method === 'POST') { this.row = { id: '12345678-1234-1234-1234-123456789abc', ...JSON.parse(o.body) }; return [this.row]; }
      if (o.method === 'PATCH') { Object.assign(this.row, JSON.parse(o.body)); return; }
      if (o.method === 'DELETE') { this.row = null; return; }
      return this.row ? [structuredClone(this.row)] : [];
    },
  };
  globalThis.fixture = state;
  Object.assign(process.env, { WOEK_NEWSLETTER_EMAIL_SEND_MODE: 'production', WOEK_NEWSLETTER_DELIVERY_PROVIDER: 'ionos_smtp', WOEK_NEWSLETTER_SMTP_HOST: 'smtp.ionos.de', WOEK_NEWSLETTER_SMTP_USER: 'sender@example.invalid', WOEK_NEWSLETTER_SMTP_PASSWORD: 'synthetic', WOEK_NEWSLETTER_SMTP_FROM: 'sender@example.invalid', NEXT_PUBLIC_PORTAL_URL: 'https://130.162.217.58.sslip.io' });
  return state;
}
const input = { email: 'reader@example.invalid', consent: true, website: '' };
test('full DOI lifecycle keeps existing schema and does not activate before confirmation', async () => {
  const s = setup();
  assert.deepEqual(await lib.requestNewsletterSubscription(input), { outcome: 'accepted', delivery: 'sent' });
  assert.equal(s.row.status, 'PENDING_CONFIRMATION'); assert.equal(s.row.confirmed_at, null);
  const url = new URL(s.messages[0].text.match(/https:\/\/[^\s]+\/bestaetigen\?[^\s]+/)[0]);
  assert.equal(url.origin, 'https://130.162.217.58.sslip.io');
  const id = s.row.id, token = url.searchParams.get('token'), optout = url.searchParams.get('unsubscribe_token');
  assert.notEqual(s.row.confirmation_token_hash, token);
  assert.equal((await lib.requestNewsletterSubscription(input)).outcome, 'already_pending'); assert.equal(s.messages.length, 1);
  await assert.rejects(() => lib.confirmNewsletterSubscription(id, 'wrong'), /ungültig/);
  assert.equal((await lib.confirmNewsletterSubscription(id, token, optout)).outcome, 'confirmed');
  assert.equal(s.row.status, 'ACTIVE'); assert.equal(s.messages.length, 2);
  assert.equal((await lib.requestNewsletterSubscription(input)).outcome, 'already_active');
  assert.equal((await lib.unsubscribeNewsletter(id, optout)).outcome, 'unsubscribed'); assert.equal(s.row, null);
});
test('SMTP failure remains inactive and a corrected transport can retry', async () => {
  const s = setup(); s.fail = true;
  assert.equal((await lib.requestNewsletterSubscription(input)).delivery, 'not_sent');
  assert.equal(s.row.status, 'AWAITING_CONFIRMATION_DELIVERY'); assert.equal(s.row.confirmation_sent_at, null);
  s.fail = false;
  assert.equal((await lib.requestNewsletterSubscription(input)).delivery, 'sent'); assert.equal(s.row.status, 'PENDING_CONFIRMATION');
  assert.equal(s.transport.requireTLS, true); assert.equal(s.transport.socketTimeout, 20_000);
});
test('an expired pending confirmation can request a fresh usable link', async () => {
  const s = setup(); await lib.requestNewsletterSubscription(input);
  const previous = s.row.confirmation_token_hash;
  s.row.confirmation_expires_at = '2000-01-01T00:00:00Z';
  assert.equal((await lib.requestNewsletterSubscription(input)).delivery, 'sent');
  assert.equal(s.messages.length, 2); assert.notEqual(s.row.confirmation_token_hash, previous);
});
