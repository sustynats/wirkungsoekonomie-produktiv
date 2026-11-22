// Public processing evidence for an edition, not a news-freshness assertion.
// Pure and import-free: no store writes, provider calls or delivery decisions.
export function lageProcessingStatus(report, now) {
  const checkedAt = report?.completed_at;
  const completed = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;
  const at = Date.parse(now);
  const age = at - completed;
  const started = report?.started_at == null ? null : Date.parse(report.started_at);
  // A recent start alone is not evidence of a completed processing run. Keep
  // the existing two-hour window; unknown evidence must remain visible.
  if (!Number.isFinite(age) || age < 0 || age > 2 * 3600000
      || started !== null && (!Number.isFinite(started) || started > completed)) {
    return { state: 'processing_unknown',
      checked_at: Number.isFinite(age) && age >= 0 ? checkedAt : null,
      note: 'Zum Zeitpunkt der Zusammenstellung liegt kein aktueller Nachweis über den Abschluss der Nachrichtenverarbeitung vor. Diese Ausgabe zeigt bereits veröffentlichte Nachrichten; sie belegt nicht, dass es keine weiteren relevanten Nachrichten gibt.' };
  }
  const paidRecoveryBlocked = report.paid_recovery_hold || report.paid_recovery_guard?.status === 'open';
  const providerBlocked = report.ai_provider_degraded || report.ai_provider_billing_blocked || report.ai_error;
  const limited = Number(report.pending_story_count || 0) > 0 && (report.budget_blocked || report.ai_budget_pacing?.paused
    || report.ai_calls_available_this_run === 0 && Number(report.eligible_stories || 0) > 0);
  const sourceBlocked = Number(report.source_failures || 0) > 0 && !Number(report.source_successes || 0);
  if (!paidRecoveryBlocked && !providerBlocked && !limited && !sourceBlocked) return null;
  return { state: paidRecoveryBlocked ? 'paid_recovery_pending'
      : providerBlocked ? 'provider_unavailable' : sourceBlocked ? 'source_unavailable' : 'processing_limited',
    checked_at: checkedAt,
    note: 'Die Nachrichtenverarbeitung ist derzeit verzögert. Eingegangene Meldungen sind noch nicht vollständig geprüft oder veröffentlicht. Dies ist keine Feststellung, dass es keine relevanten Nachrichten gibt.' };
}
