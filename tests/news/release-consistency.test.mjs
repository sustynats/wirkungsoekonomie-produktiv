import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("autonomous new pages update both committed search and taxonomy before publication", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/wirkungsticker.yml", import.meta.url), "utf8");
  const taxonomy = workflow.indexOf("npm run taxonomy:build");
  const commit = workflow.indexOf("git add --");
  const publish = workflow.indexOf("gh workflow run deploy.yml");
  assert.ok(taxonomy > workflow.indexOf("npm run build:search"));
  assert.ok(commit > taxonomy && publish > commit);
  assert.match(workflow.slice(commit, workflow.indexOf("\n", commit)), /content\/taxonomy\/site-map\.json/);
});

test("frequent news cannot cancel an active Pages publication", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\s*\n\s+group: pages\s*\n(?:\s*#.*\n)*\s+cancel-in-progress: false/);
});

test("fast and full releases install the dependencies of shared artifact checks", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const steps = workflow.split(/\n\s{6}- name: /);
  const install = steps.find(step => step.startsWith("Install Python build dependencies\n"));
  const artifact = steps.find(step => step.startsWith("Build public deploy artifact\n"));
  assert.ok(install && artifact);
  assert.doesNotMatch(install, /\n\s+if:/, "PDF checks also run in ticker-only mode");
  for (const dependency of ["pymupdf", "pypdf", "reportlab"]) assert.ok(install.includes(dependency), dependency);
  assert.ok(workflow.indexOf(install) < workflow.indexOf(artifact));
  assert.match(artifact, /npm run build:artifact/);
  const fast = steps.find(step => step.startsWith("Build ticker and search for fast update\n"));
  assert.match(fast, /npm run news:test/);
});


test('all full and ticker releases rebuild coherent projections from hydrated stores', () => {
  const deploy = fs.readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const quality = fs.readFileSync(new URL('../../.github/workflows/pr-quality.yml', import.meta.url), 'utf8');
  const ticker = fs.readFileSync(new URL('../../.github/workflows/wirkungsticker.yml', import.meta.url), 'utf8');
  const full = deploy.match(/- name: Build static reference data and search\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  const fast = deploy.match(/- name: Build ticker and search for fast update\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(full && fast);
  const before = (body, first, second) => {
    const a = body.indexOf(first), b = body.indexOf(second);
    assert.ok(a >= 0 && b > a, `${first} must exist before ${second}`);
  };
  assert.match(full, /ticker_only != 'true'/);
  before(full, 'npm run news:build', 'WOEK_PDF_BUILD_MODE=verify npm run build');
  assert.match(fast, /ticker_only == 'true'/);
  before(fast, 'npm run news:build', 'npm run build:search');
  before(fast, 'scripts/glossary/build-glossary-registry.mjs', 'scripts/glossary/build-glossary-pages.mjs');
  before(fast, 'scripts/glossary/build-glossary-pages.mjs', 'scripts/portal/build-sdg-reference.mjs --reference-pages-only');
  before(fast, 'scripts/portal/build-sdg-reference.mjs --reference-pages-only', 'tests/site/sdgplus-reference.test.mjs');
  before(fast, 'tests/site/sdgplus-reference.test.mjs', 'npm run build:search');
  before(fast, 'npm run build:search', 'scripts/api/build-core-api-manifest.mjs');
  before(deploy, 'release-hydrate.mjs', 'Build static reference data and search');
  const build = quality.match(/- name: Build ticker from hydrated data before quality checks\n([\s\S]*?)(?=\n      - name:)/)?.[1];
  assert.ok(build && build.includes('npm run news:build'));
  before(quality, 'release-hydrate.mjs', 'Build ticker from hydrated data before quality checks');
  before(quality, 'Build ticker from hydrated data before quality checks', 'Wirkungsticker unit and security tests');
  before(quality, 'Build ticker from hydrated data before quality checks', 'Build search index');
  const restore = ticker.match(/git restore --source=HEAD --staged --worktree -- ([^\n]+)/)?.[1];
  assert.equal(restore, 'wirkungsticker/data/app');
  assert.doesNotMatch(restore,/data\/news|reports\//);
  assert.ok(ticker.indexOf('git restore --source=HEAD --staged --worktree') < ticker.indexOf('node scripts/news/check-git-size.mjs --automatic'));
});
