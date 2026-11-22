import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACCESS_NOTES, annotateArtifact, annotateSourceAccess } from '../../scripts/quality/annotate-source-access.mjs';

test('adds a named supplemental route without modifying the historical anchor', () => {
  for (const note of ACCESS_NOTES) {
    const original = `<p><a class="source" href="${note.original}">Originalquelle</a>.</p>`;
    const result = annotateSourceAccess(original);
    assert.equal(result.added, 1);
    assert.ok(result.html.includes(`<a class="source" href="${note.original}">Originalquelle</a>`));
    assert.ok(result.html.includes(`href="${note.destination.replaceAll('&', '&amp;')}"`));
    assert.match(result.html, /ergänzender Quellenzugang/);
    assert.equal(annotateSourceAccess(result.html).html, result.html);
    if (note.versionNote) assert.ok(result.html.includes(note.versionNote));
  }
});

test('does not alter NIST originals that respond to a bounded GET', () => {
  for (const url of ['https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf', 'https://nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf']) {
    const input = `<a href="${url}">Originalquelle</a>`;
    assert.deepEqual(annotateSourceAccess(input), { html: input, added: 0 });
  }
});

test('does not change scripts, comments, data-href or unrelated links', () => {
  const url = ACCESS_NOTES[0].original;
  const input = `<script>const fragment = '<a href="${url}">x</a>';</script><!-- <a href="${url}">x</a> --><a data-href="${url}" href="https://example.org/">x</a><a href="https://example.org/">y</a>`;
  assert.deepEqual(annotateSourceAccess(input), { html: input, added: 0 });
});

test('recognizes an anchor when a quoted attribute contains a greater-than character', () => {
  const input = `<a title="a > b" href="${ACCESS_NOTES[0].original}">Quelle</a>`;
  const result = annotateSourceAccess(input);
  assert.equal(result.added, 1);
  assert.ok(result.html.startsWith(input));
});

test('updates only HTML files under the artifact without following symlinks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-access-'));
  try {
    const root = path.join(temp, 'site'), outside = path.join(temp, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    const input = `<a href='${ACCESS_NOTES[0].original}'>Quelle</a>`;
    fs.writeFileSync(path.join(root, 'index.html'), input);
    fs.writeFileSync(path.join(root, 'data.json'), input);
    fs.writeFileSync(path.join(outside, 'outside.html'), input);
    fs.symlinkSync(outside, path.join(root, 'outside-link'));
    assert.deepEqual(annotateArtifact(root), { scanned: 1, changed: 1, added: 1 });
    assert.equal(fs.readFileSync(path.join(root, 'data.json'), 'utf8'), input);
    assert.equal(fs.readFileSync(path.join(outside, 'outside.html'), 'utf8'), input);
    assert.deepEqual(annotateArtifact(root), { scanned: 1, changed: 0, added: 0 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});


test('final source access projection runs after the approved lexicon replaces generated files', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const steps = pkg.scripts['build:artifact'].split(' && ');
  const install = steps.indexOf('node scripts/wirkungslexikon/install-artifact.mjs');
  const annotate = steps.indexOf('node scripts/quality/annotate-source-access.mjs _site');
  assert.ok(install >= 0 && annotate > install, 'source access notes must survive final lexicon installation');
  const original = `<a href="${ACCESS_NOTES.find(n => n.id === 'enisa-threat-landscape-2025').original}">Quelle</a>`;
  const replacedByApprovedLexicon = original;
  const final = annotateSourceAccess(replacedByApprovedLexicon);
  assert.equal(final.added, 1);
  assert.match(final.html, /data-source-access-note="enisa-threat-landscape-2025"/);
  assert.ok(final.html.includes(original));
});
