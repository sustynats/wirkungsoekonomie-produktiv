import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';

const workflow = fs.readFileSync(new URL('../../.github/workflows/wirkungsticker.yml', import.meta.url), 'utf8');
const block = (name) => {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.equal(workflow.indexOf(marker, start + marker.length), -1, `duplicate ${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return { start, value: workflow.slice(start, next < 0 ? undefined : next) };
};

test('cross-repository paid guard succeeds before personal orders or provider work', () => {
  const guard = block('Verify interrupted paid work before another provider request');
  assert.match(guard.value, /^        id: paid_preflight$/m);
  assert.doesNotMatch(guard.value, /^        continue-on-error:\s*(?:true|\$\{\{)/m);
  for (const name of ["Fetch Natalie's news orders from the private editorial desk",
    'Import, analyze (one call per story) and build',
    'Take over editions approved in the private editorial desk']) {
    const later = block(name);
    assert.ok(guard.start < later.start, `${name} must follow guard`);
    assert.doesNotMatch(later.value.match(/^        if:.*$/m)?.[0] ?? '', /(?:always|failure|cancelled)\s*\(/);
  }
});

test('order delivery cannot override a failed or skipped paid preflight', () => {
  const delivery = block("Hand analysed news orders to Natalie's approval list");
  const condition = delivery.value.match(/^        if:.*$/m)?.[0];
  assert.ok(condition);
  assert.match(condition, /steps\.paid_preflight\.outcome\s*==\s*'success'/);
  assert.doesNotMatch(condition, /\|\|/);
});

test('failure recovery uploads only after the paid preflight has succeeded', () => {
  const recovery = block('Preserve failed-run work and usage for recovery');
  const expression = recovery.value.match(/^        if:\s*(.*)$/m)?.[1];
  assert.ok(expression);
  const evaluate = (outcome, failed, canceled, shouldRun = 'true') => runInNewContext(expression, {
    always: () => true,
    failure: () => failed,
    cancelled: () => canceled,
    steps: {slot: {outputs: {should_run: shouldRun}}, paid_preflight: {outcome}},
  });
  assert.equal(evaluate('failure', true, false), false);
  assert.equal(evaluate('skipped', true, false), false);
  assert.equal(evaluate('success', true, false), true);
  assert.equal(evaluate('success', false, true), true);
  assert.equal(evaluate('success', false, false), false);
  assert.equal(evaluate('success', true, false, 'false'), false);
});
