import test from 'node:test';
import assert from 'node:assert/strict';
import { lageProcessingStatus } from '../../scripts/news/lage-processing-status.mjs';

const NOW = '2026-11-19T15:30:00.000Z';
const fresh = Object.freeze({ started_at: '2026-11-19T15:00:00.000Z',
  completed_at: '2026-11-19T15:10:00.000Z', source_successes: 3, source_failures: 0 });

function unknown(report, now = NOW) {
  const status = lageProcessingStatus(report, now);
  assert.equal(status.state, 'processing_unknown');
  assert.match(status.note, /kein aktueller Nachweis/);
  assert.match(status.note, /belegt nicht, dass es keine weiteren relevanten Nachrichten gibt/);
  return status;
}

test('missing processing evidence produces a visible unknown note', () => {
  for (const report of [undefined, null, {}, { completed_at: '' }]) {
    assert.equal(unknown(report).checked_at, null);
  }
});

test('a recent completed healthy report adds no warning', () => {
  assert.equal(lageProcessingStatus(fresh, NOW), null);
});

test('stale completed evidence remains visible with its original evidence time', () => {
  const report = { ...fresh, started_at: '2026-11-18T08:00:00.000Z', completed_at: '2026-11-18T08:10:00.000Z' };
  assert.equal(unknown(report).checked_at, report.completed_at);
});

test('future or invalid evidence time never looks current', () => {
  for (const completed_at of ['2026-11-19T15:31:00.000Z', 'invalid', 12345]) {
    assert.equal(unknown({ ...fresh, completed_at }).checked_at, null);
  }
  assert.equal(unknown(fresh, 'invalid-now').checked_at, null);
});

test('a recent start without a completed report remains unknown', () => {
  assert.equal(unknown({ started_at: fresh.started_at, source_successes: 3 }).checked_at, null);
});

test('completion before start or malformed start is not trusted', () => {
  unknown({ ...fresh, started_at: '2026-11-19T15:20:00.000Z' });
  unknown({ ...fresh, started_at: 'invalid' });
});

test('the existing two-hour freshness boundary is preserved exactly', () => {
  const report = { ...fresh, started_at: '2026-11-19T13:20:00.000Z', completed_at: '2026-11-19T13:30:00.000Z' };
  assert.equal(lageProcessingStatus(report, NOW), null);
  unknown(report, '2026-11-19T15:30:00.001Z');
});

test('a fresh paid recovery hold displays a processing delay', () => {
  const status = lageProcessingStatus({ ...fresh, paid_recovery_hold: true }, NOW);
  assert.equal(status.state, 'paid_recovery_pending');
  assert.equal(status.checked_at, fresh.completed_at);
  assert.match(status.note, /Nachrichtenverarbeitung ist derzeit verzögert/);
});

test('an open paid guard displays the same delay and a closed guard does not', () => {
  const opened = lageProcessingStatus({ ...fresh, paid_recovery_guard: { status: 'open' } }, NOW);
  assert.equal(opened.state, 'paid_recovery_pending');
  assert.equal(lageProcessingStatus({ ...fresh, paid_recovery_guard: { status: 'closed' } }, NOW), null);
});

test('a stale paid hold is evidence of an unknown current state, not a fresh blocked observation', () => {
  unknown({ ...fresh, started_at: '2026-11-18T08:00:00.000Z', completed_at: '2026-11-18T08:10:00.000Z', paid_recovery_hold: true });
});

test('existing provider, source and capacity delay states remain available', () => {
  for (const [extra, state] of [
    [{ ai_provider_degraded: true }, 'provider_unavailable'],
    [{ ai_provider_billing_blocked: true }, 'provider_unavailable'],
    [{ ai_error: 'PROVIDER_FAILED' }, 'provider_unavailable'],
    [{ source_failures: 2, source_successes: 0 }, 'source_unavailable'],
    [{ pending_story_count: 2, budget_blocked: true }, 'processing_limited'],
    [{ pending_story_count: 2, ai_budget_pacing: { paused: true } }, 'processing_limited'],
    [{ pending_story_count: 2, ai_calls_available_this_run: 0, eligible_stories: 1 }, 'processing_limited'],
  ]) assert.equal(lageProcessingStatus({ ...fresh, ...extra }, NOW).state, state);
});

test('status projection neither mutates the report nor leaks internal hold details', () => {
  const guard = Object.freeze({ status: 'open', run_id: 'PRIVATE_RUN_SENTINEL', error: 'PRIVATE_ERROR_SENTINEL' });
  const report = Object.freeze({ ...fresh, paid_recovery_guard: guard, token: 'PRIVATE_TOKEN_SENTINEL' });
  const before = JSON.stringify(report);
  const status = lageProcessingStatus(report, NOW);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(Object.keys(status).sort(), ['checked_at', 'note', 'state']);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|token|run_id/);
});
