import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`,import.meta.url),'utf8');
const hydration = text => text.match(/      - name: [^\n]+\n(?:(?!      - name:)[\s\S])*?        run: node scripts\/news\/release-hydrate\.mjs\n(?:(?!      - name:)[\s\S])*?(?=\n      - name:|\n  [a-zA-Z_-]+:|$)/)?.[0] || '';

for (const name of ['pr-quality','deploy','wirkungsticker','ops-discord-monitor','wirkungsticker-discovery','redaktionsworker']) {
  test(`${name} hydrates pinned private data with a scoped token before data consumers`, () => {
    const workflow=read(name), step=hydration(workflow);
    assert.ok(step,'a real hydration step exists');
    assert.match(step,/GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.ok(workflow.indexOf('actions/setup-node@v4') < workflow.indexOf(step));
    if (name==='pr-quality') assert.ok(workflow.indexOf(step) < workflow.indexOf('run: bash scripts/news/run-isolated-unit-tests.sh'));
    if (name==='deploy') assert.ok(workflow.indexOf(step) < workflow.indexOf('WOEK_PDF_BUILD_MODE=verify npm run build'));
    if (name==='wirkungsticker') assert.match(step,/if: steps\.slot\.outputs\.should_run == 'true'/);
    if (name==='ops-discord-monitor') assert.match(step,/continue-on-error: true/);
    if (name==='wirkungsticker-discovery') {
      assert.ok(workflow.indexOf('id: slot') < workflow.indexOf(step) && workflow.indexOf(step) < workflow.indexOf('Research, cluster and enqueue'));
      assert.match(step,/if: steps\.slot\.outputs\.should_run == 'true'/);
      assert.match(step,/WOEK_NEWS_BRIDGE_TOKEN: ''/);
    }
    if (name==='redaktionsworker') {
      assert.ok(workflow.indexOf(step) < workflow.indexOf('Worker tests') && workflow.indexOf(step) < workflow.indexOf('Draft open editorial requests'));
      assert.match(step,/WOEK_NEWS_BRIDGE_TOKEN: ''/);
      assert.match(step,/OPENAI_API_KEY: ''/);
    }
  });
}
