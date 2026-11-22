import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const release = 'https://github.com/sustynats/wirkungsoekonomie-medien/releases/download/werteadvent-2026-v2/';
const run = (script, cwd, args = []) => spawnSync(process.execPath,
  [path.join(root, 'scripts/quality', script), ...args], { cwd, encoding: 'utf8' });

test('reviewed image bundles survive normalization and pass the publication gate', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'woek-media-gate-'));
  try {
    const names = ['Icons_mit_Beschriftung_v2', 'Icons_ohne_Beschriftung', '24_Comic_Icons_v2', 'Hochformat_Vorlagen'];
    const urls = names.map(name => release + `WerteAdvent_2026_${name}.zip`);
    writeFileSync(path.join(cwd, 'index.html'), urls.map(url => `<a href="${url}">Bilderpaket herunterladen</a>`).join('\n'));
    const normalized = run('sanitize-public-library-formats.mjs', cwd);
    assert.equal(normalized.status, 0, normalized.stderr);
    for (const url of urls) assert.ok(readFileSync(path.join(cwd, 'index.html'), 'utf8').includes(`href="${url}"`));
    const checked = run('check-public-library-formats.mjs', cwd);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(run('sanitize-public-library-formats.mjs', cwd, ['--check']).status, 0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('unknown archives and source documents remain blocked, including in the library registry', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'woek-media-gate-'));
  try {
    for (const url of [release + 'unreviewed.zip', release.replace('wirkungsoekonomie-medien', 'another-repo') + 'WerteAdvent_2026_Hochformat_Vorlagen.zip', '/manuscript.docx']) {
      writeFileSync(path.join(cwd, 'index.html'), `<a href="${url}">Download</a>`);
      assert.equal(run('sanitize-public-library-formats.mjs', cwd).status, 1);
      assert.equal(run('check-public-library-formats.mjs', cwd).status, 1);
    }
    writeFileSync(path.join(cwd, 'index.html'), '<p>Bibliothek</p>');
    mkdirSync(path.join(cwd, 'assets/data'), { recursive: true });
    writeFileSync(path.join(cwd, 'assets/data/library-version-registry.json'), JSON.stringify({ documents: [{ id: 'source-package', urls: { primary: release + 'WerteAdvent_2026_Hochformat_Vorlagen.zip' } }] }));
    assert.equal(run('check-public-library-formats.mjs', cwd).status, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
