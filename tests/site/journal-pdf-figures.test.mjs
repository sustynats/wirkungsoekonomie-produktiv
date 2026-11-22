import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../scripts/blog/build-journal-pdfs.mjs', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('function cleanArticleMarkup('), source.indexOf('\nfunction formatDate('));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-figures-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets/chart.png'), Buffer.from([137, 80, 78, 71]));
  return { root, clean: vm.runInNewContext(`${functionSource}; cleanArticleMarkup`, { root, fs, path }) };
}

test('historical print editions retain their existing omission of figures', t => {
  const { clean } = fixture(t);
  assert.equal(clean('<p>Text</p><figure><img src="/assets/chart.png"><figcaption>Figure</figcaption></figure>'), '<p>Text</p>');
});

test('opted-in editions embed local bytes from a nested article and retain captions and alt text', t => {
  const { root, clean } = fixture(t);
  const html = clean('<figure><img src="../../assets/chart.png" alt="Measured curve" loading="lazy"><figcaption>Model, not observations</figcaption></figure>', {
    embedFigures: true, baseDirectory: path.join(root, 'blog/nested'),
  });
  assert.match(html, /src="data:image\/png;base64,iVBORw=="/);
  assert.match(html, /alt="Measured curve"/);
  assert.match(html, /<figcaption>Model, not observations<\/figcaption>/);
  assert.doesNotMatch(html, /loading=/);
});

test('missing files, external images and paths outside the repository fail instead of silently dropping a figure', t => {
  const { clean } = fixture(t);
  for (const source of ['/assets/missing.png', 'https://example.org/chart.png', '../../private.png']) {
    assert.throws(() => clean(`<img src="${source}">`, { embedFigures: true }));
  }
});
