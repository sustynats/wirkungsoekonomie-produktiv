import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';

const routes = ['', 'biografie/', 'urheberschaft/', 'publikationen/', 'podcast/', 'musik/', 'presse/', 'faq/'];

test('the regular build regenerates the profile before adding the shared site layout', () => {
  const {scripts} = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const generator = scripts.build.indexOf('node scripts/natalie/build-natalie-pages.mjs');
  const sharedLayout = scripts.build.indexOf('python3 tools/sync_layout.py');
  assert.ok(generator >= 0 && sharedLayout > generator);
});

test('all eight generated profiles keep their contrast palette when the shared CSS follows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-profile-palette-'));
  try {
    const script = path.join(root, 'scripts/natalie/build-natalie-pages.mjs');
    fs.mkdirSync(path.dirname(script), {recursive: true});
    fs.copyFileSync('scripts/natalie/build-natalie-pages.mjs', script);
    for (const dependency of [
      'components/natalie/telephone-booking.mjs', 'content/natalie/telephone-booking.json',
      'scripts/natalie/build-booking-verification.mjs',
      'ops/telephone-booking/templates/verify.html',
      'ops/telephone-booking/static/phone-verify.js', 'ops/telephone-booking/static/manage.css',
    ]) {
      const destination = path.join(root, dependency);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(dependency, destination);
    }
    execFileSync(process.execPath, [script], {stdio: 'pipe'});
    const before = new Map(routes.map(route => [route, fs.readFileSync(path.join(root, 'w/natalie-weber', route, 'index.html'), 'utf8')]));
    execFileSync(process.execPath, [script], {stdio: 'pipe'});
    for (const route of routes) {
      const html = fs.readFileSync(path.join(root, 'w/natalie-weber', route, 'index.html'), 'utf8');
      assert.equal(html, before.get(route), `${route}: generator must be idempotent`);
      if (!route) {
        assert.match(html, /natalie-weber-portrait-20261108\.jpg/);
        assert.match(html, /assets\/js\/telephone-booking\.js/);
        assert.match(html, /id="gespraech"/);
      }
      assert.equal((html.match(/id="natalie-profile"/g) || []).length, 1, route);
      assert.equal((html.match(/<h1\b/g) || []).length, 1, route);
      assert.match(html, new RegExp(`rel="canonical" href="https://wirkungsoekonomie.de/w/natalie-weber/${route}"`));
      const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
      assert.ok(css, route);
      assert.match(css, /#natalie-profile\s*\{[^}]*--navy:#101f38/);
      assert.match(css, /#natalie-profile \.hero\s*\{[^}]*background:[^}]*var\(--navy\)/);
      assert.match(css, /#natalie-profile \.subhero\s*\{[^}]*background:[^}]*var\(--navy\)/);
      assert.match(css, /#natalie-profile \.hero h1\s*\{[^}]*color:#fff/);
      assert.match(css, /#natalie-profile \.subhero h1\s*\{[^}]*color:#fff/);
      assert.doesNotMatch(css, /(?:^|\})\s*(?:body|:root|\.hero|\.subhero)\s*\{/);
    }
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
