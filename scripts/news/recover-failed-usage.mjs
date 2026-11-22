// Account for paid work in a failed/cancelled runner whose atomic publish never reached
// main. Recover only the machine report, never accept unpublished article text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { repositoryJson } from './newsroom-store.mjs';
import { restored419Evidence, QUARANTINED_419_IDS } from './quarantined-419-evidence.mjs';
import {committedPaidRunEvidence} from './committed-paid-run-evidence.mjs';
import {paidPreflightDiagnostic, observePaidPreflightFailure, readPaidPreflightText, readPaidPreflightJson} from './paid-preflight-diagnostics.mjs';

function nativeLogPayloads(log, nativeStep) {
  const start = Date.parse(nativeStep?.started_at), end = Date.parse(nativeStep?.completed_at);
  const bounded = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  const step = /\t(Import, analyze(?: \(one call per story\))? and build|UNKNOWN STEP)\t/;
  return String(log).split('\n').flatMap(line => {
    const match = line.match(step);
    if (!match) return [];
    const payload = line.slice(match.index + match[0].length), split = payload.indexOf(' ');
    const at = Date.parse(payload.slice(0, split).replace(/^\uFEFF/, ''));
    // Cancelled GitHub logs may lose step labels. Only the independently
    // recorded native step's time interval can recover those labels.
    if (match[1] === 'UNKNOWN STEP' && (!bounded || !Number.isFinite(at) || at < start || at >= end + 1000)) return [];
    return [payload.slice(split + 1)];
  });
}

export function reportFromRunLog(log, {nativeStep} = {}) {
  const lines = nativeLogPayloads(log, nativeStep);
  const start = lines.findIndex(line => line.trim() === '{');
  if (start < 0) return null; // Failed before a completed analysis report.
  const body = lines.slice(start).join('\n');
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {end = i + 1; break;}
  }
  if (end < 0) throw Error('RECOVERY_REPORT_INCOMPLETE');
  const report = JSON.parse(body.slice(0, end));
  if (report.schema_version !== '1.2' || !Number.isFinite(Date.parse(report.started_at))
      || !Number.isFinite(Date.parse(report.completed_at))) throw Error('RECOVERY_REPORT_INVALID');
  for (const key of ['ai_calls', 'input_tokens', 'output_tokens', 'estimated_cost_usd']) {
    if (!Number.isFinite(report[key]) || report[key] < 0) throw Error(`RECOVERY_USAGE_INVALID:${key}`);
  }
  return report;
}

export function recoverUsageReport(usage, report, workflow, now) {
  const runId = `news-run-${createHash('sha256').update(report.started_at).digest('hex').slice(0,12)}`;
  if ((usage.runs || []).some(run => run.run_id === runId || run.started_at === report.started_at)) return false;
  const started = Date.parse(report.started_at);
  const completed = Date.parse(report.completed_at), created = Date.parse(workflow.created_at);
  const updated = Date.parse(workflow.updated_at), recovered = Date.parse(now);
  if (!['failure', 'cancelled'].includes(workflow.conclusion)
      || ![started, completed, created, updated, recovered].every(Number.isFinite)
      || started < created || completed < started || completed > updated || updated > recovered) {
    throw Error('RECOVERY_RUN_BINDING_INVALID');
  }
  for (const key of ['ai_calls', 'input_tokens', 'output_tokens', 'estimated_cost_usd']) {
    if (!Number.isFinite(report[key]) || report[key] < 0) throw Error(`RECOVERY_USAGE_INVALID:${key}`);
  }
  (usage.runs ||= []).push({
    run_id: runId, started_at: report.started_at, completed_at: report.completed_at,
    berlin_slot: report.berlin_slot,
    processing_version: report.processing_version || 'legacy',
    counts: { ai_requests: report.ai_calls, ai_stories: report.ai_stories || 0, published_stories: 0, updated_stories: 0 },
    ai: { requests: report.ai_calls, input_tokens: report.input_tokens, output_tokens: report.output_tokens,
      estimated_cost_usd: report.estimated_cost_usd, token_source: report.token_source },
    recovery: { recovered_at: now, github_run_id: workflow.id, url: workflow.html_url,
      publication_committed: false, report_published_stories: report.published_stories || 0,
      report_updated_stories: report.updated_stories || 0 },
  });
  return true;
}

export function recoverFailedUsage({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), now = new Date().toISOString(), write = true, gh = args => execFileSync('gh', args, { encoding:'utf8', maxBuffer:24*1024*1024 }) } = {}) {
  const file = path.join(root, 'data/news/usage.json');
  const usage = JSON.parse(fs.readFileSync(file, 'utf8'));
  const registry = usage.failed_run_recovery || { checked_run_ids: [] };
  const checked = new Set(registry.checked_run_ids || []);
  const { workflow_runs: runs } = JSON.parse(gh(['api', 'repos/sustynats/wirkungsoekonomie.de/actions/workflows/wirkungsticker.yml/runs?status=failure&per_page=30']));
  let recovered = 0;
  const unresolved = [];
  for (const run of runs) {
    if (checked.has(run.id) || !run.created_at.startsWith(now.slice(0,7))) continue;
    try {
      const report = reportFromRunLog(gh(['run','view',String(run.id),'--repo','sustynats/wirkungsoekonomie.de','--log']));
      if (report && recoverUsageReport(usage, report, run, now)) recovered++;
      checked.add(run.id);
    } catch { unresolved.push(run.id); }
  }
  usage.failed_run_recovery = { checked_at:now, checked_run_ids:[...checked].slice(-200), unresolved_run_ids:unresolved, status:unresolved.length ? 'open' : 'checked' };
  if (write) fs.writeFileSync(file, repositoryJson(usage));
  return { recovered_runs:recovered, checked_runs:checked.size, unresolved_run_ids:unresolved, recovered_cost_usd:usage.runs.filter(run => run.recovery?.recovered_at === now).reduce((sum,run)=>sum+run.ai.estimated_cost_usd,0) };
}

export const INTERRUPTED_PAID_GUARD_VERSION = 'interrupted-paid-1';
const GUARD_START = '2026-10-28T20:06:01Z'; // First audited cancellation; existing legacy input locks remain unchanged.
export const LEGACY_PAID_REPOSITORY = 'sustynats/wirkungsoekonomie.de';
export const NEW_PAID_REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';

export function interruptedPaidWorkBlocked(guard, {requireCurrentRun = false, runId, runAttempt, repository, allowQuarantined419 = false} = {}) {
  if (!guard) return requireCurrentRun;
  if (guard.quarantined_visual_run_ids?.length && !allowQuarantined419) return true;
  if (requireCurrentRun && repository && ![LEGACY_PAID_REPOSITORY, NEW_PAID_REPOSITORY].includes(repository)) return true;
  if (requireCurrentRun && repository === NEW_PAID_REPOSITORY
    && (guard.checked_for_repository !== repository
      || guard.repository_guards?.[LEGACY_PAID_REPOSITORY]?.status !== 'checked'
      || guard.repository_guards?.[NEW_PAID_REPOSITORY]?.status !== 'checked'
      || guard.cross_repository_active_check !== 'clear')) return true;
  return guard.version !== INTERRUPTED_PAID_GUARD_VERSION || guard.status !== 'checked'
    || requireCurrentRun && (guard.checked_for_run_id !== String(runId)
      || guard.checked_for_run_attempt !== Number(runAttempt));
}

function providerInputEvents(log, nativeStep) {
  const events = [];
  for (const line of nativeLogPayloads(log, nativeStep)) {
    const start = line.indexOf('{"news_import_progress":');
    if (start < 0) continue;
    const progress = JSON.parse(line.slice(start)).news_import_progress;
    if (progress.stage === 'provider_request_started') events.push(progress);
  }
  return events;
}

// Verify interrupted native runs before another provider request. This records
// costs and unresolved run identities only, never restores article text or
// replays a claim/finalize operation. The existing atomic usage push is the
// boundary: an uncommitted answer needs its separately audited input receipt.
export function verifyInterruptedPaidRuns({usage, now = new Date().toISOString(), runId,
  runAttempt = 1, documentedAttempts = () => [], documentedZeroAttempt = () => false,
  repository = LEGACY_PAID_REPOSITORY, historicalOnly = false, previousGuard, persistGuard = true, allowQuarantined419 = false,
  gh = args => execFileSync('gh', args, {encoding:'utf8', maxBuffer:24*1024*1024, timeout:20000}),
} = {}) {
  if (![LEGACY_PAID_REPOSITORY, NEW_PAID_REPOSITORY].includes(repository)) throw Error('PAID_PREFLIGHT_REPOSITORY_INVALID');
  if (typeof historicalOnly !== 'boolean' || typeof persistGuard !== 'boolean') throw Error('PAID_PREFLIGHT_OPTIONS_INVALID');
  const REPO = `repos/${repository}`;
  if (!Number.isFinite(Date.parse(now)) || !/^\d+$/.test(String(runId))
    || !Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw Error('PAID_PREFLIGHT_BINDING_INVALID');
  const previous = previousGuard === undefined ? usage.failed_run_recovery?.interrupted_guard : previousGuard;
  const compatible = previous?.version === INTERRUPTED_PAID_GUARD_VERSION;
  if (previous?.checked_for_repository && previous.checked_for_repository !== repository) throw Error('PAID_PREFLIGHT_REPOSITORY_MISMATCH');
  if (repository === NEW_PAID_REPOSITORY && compatible && previous.checked_for_repository !== repository) throw Error('PAID_PREFLIGHT_REPOSITORY_MISMATCH');
  const safeId = id => Number.isSafeInteger(id) && id > 0;
  if (compatible && (!['tracked_run_ids','unresolved_run_ids','checked_runs'].every(key => Array.isArray(previous[key]))
    || !previous.tracked_run_ids.every(safeId) || !previous.unresolved_run_ids.every(safeId)
    || !previous.checked_runs.every(row => safeId(row?.run_id) && Number.isSafeInteger(row.attempt)
      && Number.isFinite(Date.parse(row.updated_at))))) throw Error('PAID_PREFLIGHT_LEDGER_INVALID');
  const windowStart = compatible ? previous.window_start : GUARD_START;
  if (!Number.isFinite(Date.parse(windowStart)) || Date.parse(windowStart) > Date.parse(now)) throw Error('PAID_PREFLIGHT_WINDOW_INVALID');
  const checked = new Map((compatible ? previous.checked_runs || [] : []).map(row => [row.run_id, row]));
  const unresolved = new Set(compatible ? previous.unresolved_run_ids || [] : []);
  const previouslyTracked = new Set(compatible ? previous.tracked_run_ids || [] : []);
  const tracked = new Set([...previouslyTracked, ...(historicalOnly ? [] : [Number(runId)])]);
  const runs = new Map();
  const unresolvedReasons = {};
  const diagnostics = [];
  const quarantinedVisualRuns = new Set();
  let recovered = 0, scanComplete = false, verificationError = null;
  const json = (args, context) => readPaidPreflightJson(gh, args, {repository, ...context});
  const validRun = run => Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isFinite(Date.parse(run.created_at)) && Number.isFinite(Date.parse(run.updated_at));
  try {
    let lastCreated = Infinity;
    for (let page = 1; page <= 20; page++) {
      const result = json(['api', `${REPO}/actions/workflows/wirkungsticker.yml/runs?per_page=100&page=${page}`], {operation:'workflow_runs', page});
      if (!Array.isArray(result.workflow_runs) || !Number.isSafeInteger(result.total_count) || result.total_count < 0
        || result.workflow_runs.length > Math.min(100,result.total_count)
        || page === 1 && result.total_count > 0 && result.workflow_runs.length === 0) throw Error('PAID_PREFLIGHT_RUN_LIST_INVALID');
      for (const run of result.workflow_runs) {
        if (!validRun(run) || Date.parse(run.created_at) > lastCreated) throw Error('PAID_PREFLIGHT_RUN_ORDER_INVALID');
        lastCreated = Date.parse(run.created_at);
        if (lastCreated >= Date.parse(windowStart)) runs.set(run.id, run);
      }
      if (lastCreated < Date.parse(windowStart) || (page - 1) * 100 + result.workflow_runs.length >= result.total_count) {scanComplete = true; break;}
      if (result.workflow_runs.length < 100) throw Error('PAID_PREFLIGHT_RUN_LIST_INCOMPLETE');
    }
    if (!scanComplete) throw Error('PAID_PREFLIGHT_RUN_LIST_INCOMPLETE');
    // Queued runs can be older than the moving scan window. Keep their IDs
    // until their terminal outcome has actually been checked, including the
    // run whose own preflight is about to permit paid work.
    for (const id of new Set([...tracked, ...unresolved, ...(historicalOnly ? [] : [Number(runId)])])) {
      if (runs.has(id)) continue;
      const run = json(['api', `${REPO}/actions/runs/${id}`], {operation:'run_metadata', run_id:id});
      if (!validRun(run) || run.id !== id) throw Error('PAID_PREFLIGHT_RUN_BINDING_INVALID');
      runs.set(id, run);
    }
    if (!historicalOnly) {
      const current = runs.get(Number(runId));
      if (current.status !== 'in_progress') throw Error('PAID_PREFLIGHT_CURRENT_RUN_NOT_ACTIVE');
      if (Number(runAttempt) !== 1 || current.run_attempt !== 1) throw Error('PAID_PREFLIGHT_RERUN_REQUIRES_AUDIT');
      if (Date.parse(current.created_at) < Date.parse(windowStart) && !previouslyTracked.has(current.id)) throw Error('PAID_PREFLIGHT_OLD_UNTRACKED_RUN');
    }
    for (const run of runs.values()) {
      if (!historicalOnly && run.id === Number(runId)) {tracked.add(run.id); continue;}
      if (run.status !== 'completed') {
        tracked.add(run.id);
        if (historicalOnly) {unresolved.add(run.id); unresolvedReasons[run.id]='PAID_PREFLIGHT_HISTORICAL_RUN_ACTIVE';}
        continue;
      }
      tracked.delete(run.id);
      const prior = checked.get(run.id);
      if (prior?.attempt === run.run_attempt && prior.updated_at === run.updated_at && !unresolved.has(run.id)) continue;
      if (run.run_attempt !== 1) {unresolved.add(run.id); unresolvedReasons[run.id]='PAID_PREFLIGHT_RERUN_REQUIRES_AUDIT'; continue;}
      if (['success','skipped','neutral'].includes(run.conclusion)) {
        checked.set(run.id,{run_id:run.id,attempt:run.run_attempt,updated_at:run.updated_at}); unresolved.delete(run.id); continue;
      }
      if (!['failure','cancelled','timed_out','action_required'].includes(run.conclusion)) {unresolved.add(run.id); unresolvedReasons[run.id]='PAID_PREFLIGHT_OUTCOME_UNKNOWN'; continue;}
      try {
        const result = json(['api', `${REPO}/actions/runs/${run.id}/jobs?per_page=100`], {operation:'jobs', run_id:run.id});
        if (!Array.isArray(result.jobs) || result.total_count !== result.jobs.length
          || !result.jobs.every(job => safeId(job.id) && job.run_id === run.id)) throw Error('PAID_PREFLIGHT_JOBS_INCOMPLETE');
        const jobs = result.jobs;
        const committed = repository === NEW_PAID_REPOSITORY ? committedPaidRunEvidence(run, jobs, usage, repository) : null;
        // Only the audited committed branch can supply an archived native step.
        const native = committed?.nativeStep ? [committed.nativeStep]
          : jobs.flatMap(job => job.steps || []).filter(step => /^Import, analyze(?: \(one call per story\))? and build$/.test(step.name || ''));
        const neverStarted = result.total_count === 0 || jobs.every(job => job.conclusion === 'skipped')
          || jobs.length === 1 && native.length === 1 && native[0].conclusion === 'skipped';
        if (!neverStarted) {
          if (native.length !== 1 || jobs.length !== 1) throw Error('PAID_PREFLIGHT_NATIVE_STEP_UNKNOWN');
          const restored = repository === LEGACY_PAID_REPOSITORY ? restored419Evidence(run, native[0]) : null;
          const log = restored || committed ? null : readPaidPreflightText(gh, ['run','view',String(run.id),'--repo',repository,'--log'],
            {repository, operation:'run_log', run_id:run.id});
          const report = restored?.report || committed?.report || observePaidPreflightFailure(() => reportFromRunLog(log, {nativeStep:native[0]}),
            {repository, operation:'recovery_report', phase:'recovery', run_id:run.id});
          if (!report || String(report.run_id) !== String(run.id)) throw Error('PAID_PREFLIGHT_REPORT_UNBOUND');
          if (Date.parse(report.started_at) < Date.parse(run.created_at)
            || Date.parse(report.completed_at) < Date.parse(report.started_at)
            || Date.parse(report.completed_at) > Date.parse(run.updated_at)
            || Date.parse(run.updated_at) > Date.parse(now)) throw Error('PAID_PREFLIGHT_REPORT_TIME_INVALID');
          // The committed receipt does not claim reconstructed provider log events.
          const providerEvents = restored?.providerEvents || (committed ? null : observePaidPreflightFailure(() => providerInputEvents(log, native[0]),
            {repository, operation:'provider_events', phase:'recovery', run_id:run.id}));
          const inputs = (providerEvents || []).flatMap(event => event.story_ids || []);
          const durable = (usage.runs || []).some(row => row.started_at === report.started_at
            && row.processing_version === report.processing_version && !row.recovery
            && row.ai?.requests === report.ai_calls);
          if (!durable && report.ai_calls > 0 && report.token_source === 'provider_reported_usage') {
            if (observePaidPreflightFailure(() => recoverUsageReport(usage, report, run, now),
              {repository, operation:'usage_recovery', phase:'recovery', run_id:run.id})) recovered++;
          }
          const bound = receipt => receipt.recovery?.run_id === run.id || receipt.recovery?.additional_attempt?.run_id === run.id;
          const documented = inputs.length > 0 && inputs.length === report.ai_calls && inputs.every(id => documentedAttempts(id).some(receipt =>
            bound(receipt) && Number(receipt.retry_count) >= inputs.filter(value => value === id).length));
          // Some completed historical reports omitted the zero-attempt field.
          // Only a separately audited, exact receipt can establish that zero;
          // the real native step must also have completed without a start marker.
          const documentedZero = native[0].conclusion === 'success' && documentedZeroAttempt(run, report);
          const noAnalysisRequest = report.ai_calls === 0 && providerEvents?.length === 0 && inputs.length === 0
            && (report.ai_request_attempts === 0 || documentedZero);
          if (!durable && !noAnalysisRequest && !documented) throw Error('PAID_PREFLIGHT_INPUT_RECEIPT_MISSING');
          if (inputs.length === 0 && report.ai_calls > 0 && !durable) throw Error('PAID_PREFLIGHT_INPUT_IDS_MISSING');
          if ((!durable || restored || committed) && (!Array.isArray(report.title_images) || report.title_images.some(image =>
            image.higgsfield_called !== false && image.source_reused !== true && !['skipped','deferred'].includes(image.status)
              && !documentedAttempts(image.story_id).some(receipt => bound(receipt)
                && /^[a-f0-9]{64}$/.test(receipt.recovery?.retained_visual_source_sha256 || ''))))) {
            const visual = report.title_images;
            const exactScopedHold = allowQuarantined419 && restored && documented
              && inputs.length === 2 && QUARANTINED_419_IDS.every(id => inputs.includes(id))
              && Array.isArray(visual) && visual.length === 1 && visual[0].story_id === QUARANTINED_419_IDS[0]
              && visual[0].higgsfield_called === true && visual[0].source_reused === false
              && visual[0].status === 'fallback' && visual[0].fallback_reason === 'TITLE_IMAGE_UNAVAILABLE';
            if (exactScopedHold) {
              unresolved.add(run.id);
              unresolvedReasons[run.id] = 'PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING';
              quarantinedVisualRuns.add(run.id);
              continue; // Preserve the unknown image and re-evaluate in every run.
            }
            throw Error('PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING');
          }
        }
        checked.set(run.id,{run_id:run.id,attempt:run.run_attempt,updated_at:run.updated_at}); unresolved.delete(run.id);
      } catch (error) {
        diagnostics.push(paidPreflightDiagnostic(error, {repository, operation:'interrupted_run', phase:'guard', run_id:run.id}));
        unresolved.add(run.id); unresolvedReasons[run.id]=/^PAID_PREFLIGHT_[A-Z_]+$/.test(error.message) ? error.message : 'PAID_PREFLIGHT_READ_UNAVAILABLE';
      }
    }
  } catch (error) {
    diagnostics.push(paidPreflightDiagnostic(error, {repository, operation:'workflow_scan', phase:'guard', run_id:Number(runId)}));
    verificationError = /^PAID_PREFLIGHT_[A-Z_]+$/.test(error.message) ? error.message : 'PAID_PREFLIGHT_READ_UNAVAILABLE';
  }
  const openUnresolved = [...unresolved].filter(id => !quarantinedVisualRuns.has(id));
  const guard = {version:INTERRUPTED_PAID_GUARD_VERSION,status:verificationError || openUnresolved.length ? 'open' : 'checked',
    checked_at:now,checked_for_run_id:String(runId),checked_for_run_attempt:Number(runAttempt),checked_for_repository:repository,
    window_start:scanComplete && !verificationError ? now : windowStart,
    tracked_run_ids:[...tracked],unresolved_run_ids:[...unresolved],checked_runs:[...checked.values()].slice(-200),
    unresolved_reasons:unresolvedReasons,quarantined_visual_run_ids:[...quarantinedVisualRuns],recovered_runs:recovered,verification_error:verificationError,diagnostics,provider_called:false};
  if (persistGuard) (usage.failed_run_recovery ||= {}).interrupted_guard = guard;
  return guard;
}

// Read both repositories before permitting a migrated paid run. This snapshot
// is a preflight, not a substitute for the separate cross-repository lock.
export function verifyMigrationActiveRuns({runId, gh}) {
  let seenCurrent = false;
  const active = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
  for (const repository of [LEGACY_PAID_REPOSITORY, NEW_PAID_REPOSITORY]) {
    for (const workflow of ['wirkungsticker.yml', 'wirkungsticker-discovery.yml']) {
      for (const status of active) {
        const path = `repos/${repository}/actions/workflows/${workflow}/runs?status=${status}&per_page=100`;
        const page = readPaidPreflightJson(gh, ['api', path],
          {repository, operation:'active_runs', workflow, requested_status:status});
        if (!Number.isSafeInteger(page.total_count) || page.total_count < 0 || page.total_count > 100
          || !Array.isArray(page.workflow_runs) || page.workflow_runs.length !== page.total_count
          || page.workflow_runs.some(row => !Number.isSafeInteger(row.id) || row.id <= 0 || row.status !== status))
          throw Error('PAID_PREFLIGHT_ACTIVE_LIST_UNCERTAIN');
        for (const row of page.workflow_runs) {
          if (repository === NEW_PAID_REPOSITORY && workflow === 'wirkungsticker.yml'
            && status === 'in_progress' && String(row.id) === String(runId)) { seenCurrent = true; continue; }
          throw Error('PAID_PREFLIGHT_OTHER_RUN_ACTIVE');
        }
      }
    }
  }
  if (!seenCurrent) throw Error('PAID_PREFLIGHT_CURRENT_RUN_UNCONFIRMED');
  return 'clear';
}

export function verifyMigratedPaidRuns({usage, now = new Date().toISOString(), runId, runAttempt = 1, documentedAttempts, allowQuarantined419 = false,
  documentedZeroAttempt, gh = args => execFileSync('gh', args, {encoding:'utf8', maxBuffer:24*1024*1024, timeout:20000})} = {}) {
  const saved = usage.failed_run_recovery?.interrupted_guard;
  const scoped = saved?.repository_guards;
  if (saved && saved.version !== INTERRUPTED_PAID_GUARD_VERSION) throw Error('PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID');
  if (saved?.checked_for_repository === NEW_PAID_REPOSITORY && !scoped) throw Error('PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID');
  if (scoped && (!scoped[LEGACY_PAID_REPOSITORY] || !scoped[NEW_PAID_REPOSITORY]
    || scoped[LEGACY_PAID_REPOSITORY].version !== INTERRUPTED_PAID_GUARD_VERSION
    || scoped[NEW_PAID_REPOSITORY].version !== INTERRUPTED_PAID_GUARD_VERSION))
    throw Error('PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID');
  const legacyPrevious = scoped ? scoped[LEGACY_PAID_REPOSITORY] : (saved || null);
  const newPrevious = scoped ? scoped[NEW_PAID_REPOSITORY] : null;
  const common = {usage, now, runId, runAttempt, documentedAttempts, documentedZeroAttempt, allowQuarantined419, gh, persistGuard:false};
  const legacy = verifyInterruptedPaidRuns({...common, repository:LEGACY_PAID_REPOSITORY, historicalOnly:true, previousGuard:legacyPrevious});
  const current = verifyInterruptedPaidRuns({...common, repository:NEW_PAID_REPOSITORY, previousGuard:newPrevious});
  let activeCheck = 'uncertain', activeError = null;
  const activeDiagnostics = [];
  try { activeCheck = verifyMigrationActiveRuns({runId, gh}); }
  catch (error) {
    activeDiagnostics.push(paidPreflightDiagnostic(error, {operation:'active_guard', phase:'guard', run_id:Number(runId)}));
    activeError = /^PAID_PREFLIGHT_[A-Z_]+$/.test(error.message) ? error.message : 'PAID_PREFLIGHT_READ_UNAVAILABLE';
  }
  const guard = {version:INTERRUPTED_PAID_GUARD_VERSION,
    status:legacy.status === 'checked' && current.status === 'checked' && activeCheck === 'clear' ? 'checked' : 'open',
    checked_at:now, checked_for_run_id:String(runId), checked_for_run_attempt:Number(runAttempt),
    checked_for_repository:NEW_PAID_REPOSITORY, cross_repository_active_check:activeCheck,
    verification_error:activeError || legacy.verification_error || current.verification_error || null,
    unresolved_run_ids:[...new Set([...legacy.unresolved_run_ids, ...current.unresolved_run_ids])],
    unresolved_reasons:{...legacy.unresolved_reasons, ...current.unresolved_reasons},
    quarantined_visual_run_ids:[...new Set([...legacy.quarantined_visual_run_ids, ...current.quarantined_visual_run_ids])],
    recovered_runs:legacy.recovered_runs + current.recovered_runs,
    repository_guards:{[LEGACY_PAID_REPOSITORY]:legacy,[NEW_PAID_REPOSITORY]:current},
    diagnostics:[...legacy.diagnostics, ...current.diagnostics, ...activeDiagnostics], provider_called:false};
  (usage.failed_run_recovery ||= {}).interrupted_guard = guard;
  return guard;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(recoverFailedUsage({write:!process.argv.includes('--dry-run')})));
