import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const origin = 'https://wirkungsoekonomie.de';
const statePrefix = 'woek_discord_oauth_state:';
const urls = ['assets/js/woek-community-auth.js', 'assets/js/woek-community-auth-v2.js'];

test('both public login pages request the updated client version', () => {
  for (const file of ['app/index.html', 'werkzeuge/faktencheck/index.html']) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /woek-community-auth-v2\.js\?v=20261106-oauth-errors/);
    assert.doesNotMatch(html, /woek-community-auth-v2\.js\?v=20260628-community-copy/);
  }
});

function storage(entries = []) {
  const values = new Map(entries);
  return { getItem: (k) => values.get(k) ?? null,
    setItem: (k,v) => values.set(k,String(v)),
    removeItem: (k) => values.delete(k) };
}

async function run(file, { fragment, entries = [], fail = false, session = storage(entries) }) {
  const calls = [], redirects = [], replacements = [];
  const local = storage();
  const panel = { dataset: {}, querySelector: () => null };
  const document = { querySelectorAll: (selector) => selector === '[data-community-auth]' ? [panel] : [] };
  const location = { origin, href: `${origin}/app/${fragment}`, pathname: '/app/', search: '', hash: fragment,
    assign: (url) => redirects.push(url) };
  const window = { location, sessionStorage: session, localStorage: local,
    history: { replaceState: (...args) => replacements.push(args) }, crypto: { getRandomValues: (a) => a } };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', statePresent: session.getItem(`${statePrefix}good`) !== null });
    if (fail) throw new Error('synthetic outage');
    return { ok: true, json: async () => ({ ok: true, token: 'synthetic-session', loggedIn: true, member: true }) };
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document, fetch, URL, URLSearchParams, Uint8Array, Math, Date });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { calls, redirects, replacements, session, local };
}

for (const file of urls) {
  test(`${file}: missing or unknown state is rejected and fragment removed`, async () => {
    for (const fragment of ['#access_token=synthetic', '#access_token=synthetic&state=unknown']) {
      const result = await run(file, { fragment });
      assert.equal(result.calls.length, 0);
      assert.equal(result.redirects.length, 0);
      assert.equal(result.replacements.length, 1);
      assert.equal(result.local.getItem('woek_community_auth'), null);
    }
  });
  test(`${file}: state for an off-site return is rejected`, async () => {
    const result = await run(file, { fragment: '#access_token=synthetic&state=good',
      entries: [[`${statePrefix}good`, 'https://attacker.example/']] });
    assert.equal(result.calls.length, 0);
    assert.equal(result.redirects.length, 0);
  });
  test(`${file}: valid state is consumed before exchange and replay is rejected`, async () => {
    const session = storage([[`${statePrefix}good`, `${origin}/werkzeuge/faktencheck/`]]);
    const first = await run(file, { fragment: '#access_token=synthetic&state=good', session });
    assert.equal(first.calls.length, 2);
    assert.equal(first.calls[0].method, 'POST');
    assert.equal(first.calls[0].statePresent, false);
    assert.equal(first.redirects[0], `${origin}/werkzeuge/faktencheck/?woek_login=success`);
    const replay = await run(file, { fragment: '#access_token=synthetic&state=good', session });
    assert.equal(replay.calls.length, 0);
  });
  test(`${file}: failed token exchange never redirects with success`, async () => {
    const result = await run(file, { fragment: '#access_token=synthetic&state=good', fail: true,
      entries: [[`${statePrefix}good`, `${origin}/werkzeuge/faktencheck/`]] });
    assert.equal(result.calls.length, 1);
    assert.equal(result.redirects.length, 0);
    assert.equal(result.session.getItem(`${statePrefix}good`), null);
  });
}
