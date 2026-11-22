import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Im isolierten News-only-Kandidaten ist der Bildprovider absichtlich aus.
// Der aktive Analyseschritt darf die leeren Jobwerte nicht überschreiben.
test('News-only verwendet keinen kostenpflichtigen Bilddienst', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/wirkungsticker.yml', import.meta.url), 'utf8');
  const schritt = workflow.split('- name: Import, analyze (one call per story) and build')[1]?.split('\n      - name:')[0] || '';
  assert.ok(schritt, 'der Analyseschritt ist nicht auffindbar');
  assert.match(workflow, /^      VISUAL_GENERATION_PROVIDER: disabled$/m);
  assert.match(workflow, /^      WOEK_NEWS_VISUAL_API_URL: ""$/m);
  assert.match(workflow, /^      WOEK_NEWS_ANALYSIS_TOKEN: ""$/m);
  assert.doesNotMatch(schritt, /WOEK_NEWS_VISUAL_API_URL:|WOEK_NEWS_ANALYSIS_TOKEN:|VISUAL_GENERATION_PROVIDER:/);
});
