import test from 'node:test';
import assert from 'node:assert/strict';
import { lageProcessingStatus } from '../../scripts/news/lage-processing-status.mjs';

const now = '2026-10-08T06:10:00Z';
const report = { completed_at: '2026-10-08T06:09:00Z', eligible_stories: 20, pending_story_count: 20,
  ai_calls_available_this_run: 0, ai_budget_pacing: { paused: true }, source_successes: 20, source_failures: 0 };

// Kept separate from provider/build imports so this contract can be checked
// directly without running the already passing provider refusal cases.
test('stale/future/missing reports cannot invent a current outage; source and provider states differ', () => {
  for (const [value, checkedAt] of [
    [undefined, null],
    [{ ...report, completed_at: '2026-10-07T22:00:00Z' }, '2026-10-07T22:00:00Z'],
    [{ ...report, completed_at: '2026-10-08T06:11:00Z' }, null],
  ]) {
    const status = lageProcessingStatus(value, now);
    assert.equal(status.state, 'processing_unknown');
    assert.equal(status.checked_at, checkedAt);
    assert.match(status.note, /kein aktueller Nachweis über den Abschluss der Nachrichtenverarbeitung/);
    assert.match(status.note, /belegt nicht, dass es keine weiteren relevanten Nachrichten gibt/);
    assert.doesNotMatch(status.note, /derzeit verzögert|Anbieter.*gestört|Quellen.*ausgefallen/);
    assert.ok(!['provider_unavailable', 'source_unavailable', 'processing_limited', 'paid_recovery_pending'].includes(status.state));
  }
  // A fresh completed report must still distinguish concrete observed blocks.
  assert.equal(lageProcessingStatus({ ...report, ai_provider_billing_blocked: true }, now).state, 'provider_unavailable');
  assert.equal(lageProcessingStatus({ ...report, source_successes: 0, source_failures: 5 }, now).state, 'source_unavailable');
  assert.equal(lageProcessingStatus({ ...report, pending_story_count: 0, ai_budget_pacing: { paused: false } }, now), null);
});
