// Diagnostics only: preserve the original error and every existing guard decision.
// Raw stderr, messages, payloads, URLs and credentials never enter these records.
import {privateDownloadFailureDiagnostic} from './release-part.mjs';

const remembered = new WeakMap();
const repositories = new Set(['sustynats/wirkungsoekonomie.de', 'sustynats/wirkungsoekonomie-produktiv']);
const operations = new Set(['workflow_runs', 'run_metadata', 'jobs', 'run_log',
  'recovery_report', 'provider_events', 'usage_recovery', 'interrupted_run',
  'workflow_scan', 'active_runs', 'active_guard', 'preflight']);
const phases = new Set(['github_read', 'json_decode', 'recovery', 'guard']);
const workflows = new Set(['wirkungsticker.yml', 'wirkungsticker-discovery.yml']);
const statuses = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const publicCodes = new Set([
  'PAID_PREFLIGHT_REPOSITORY_INVALID', 'PAID_PREFLIGHT_OPTIONS_INVALID',
  'PAID_PREFLIGHT_BINDING_INVALID', 'PAID_PREFLIGHT_REPOSITORY_MISMATCH',
  'PAID_PREFLIGHT_LEDGER_INVALID', 'PAID_PREFLIGHT_WINDOW_INVALID',
  'PAID_PREFLIGHT_RUN_LIST_INVALID', 'PAID_PREFLIGHT_RUN_ORDER_INVALID',
  'PAID_PREFLIGHT_RUN_LIST_INCOMPLETE', 'PAID_PREFLIGHT_RUN_BINDING_INVALID',
  'PAID_PREFLIGHT_CURRENT_RUN_NOT_ACTIVE', 'PAID_PREFLIGHT_RERUN_REQUIRES_AUDIT',
  'PAID_PREFLIGHT_OLD_UNTRACKED_RUN', 'PAID_PREFLIGHT_JOBS_INCOMPLETE',
  'PAID_PREFLIGHT_NATIVE_STEP_UNKNOWN', 'PAID_PREFLIGHT_419_RUN_BINDING_INVALID',
  'PAID_PREFLIGHT_COMMITTED_RUN_BINDING_INVALID', 'PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID',
  'PAID_PREFLIGHT_COMMITTED_USAGE_BINDING_INVALID',
  'PAID_PREFLIGHT_REPORT_UNBOUND', 'PAID_PREFLIGHT_REPORT_TIME_INVALID',
  'PAID_PREFLIGHT_INPUT_RECEIPT_MISSING', 'PAID_PREFLIGHT_INPUT_IDS_MISSING',
  'PAID_PREFLIGHT_VISUAL_RECEIPT_MISSING', 'PAID_PREFLIGHT_ACTIVE_LIST_UNCERTAIN',
  'PAID_PREFLIGHT_OTHER_RUN_ACTIVE', 'PAID_PREFLIGHT_CURRENT_RUN_UNCONFIRMED',
  'PAID_PREFLIGHT_REPOSITORY_LEDGER_INVALID', 'PAID_PREFLIGHT_MODE_REQUIRED',
  'PAID_RECOVERY_TIME_INVALID', 'RECOVERY_REPORT_INCOMPLETE',
  'RECOVERY_REPORT_INVALID', 'RECOVERY_RUN_BINDING_INVALID'
]);
const usageFields = new Set(['ai_calls', 'input_tokens', 'output_tokens', 'estimated_cost_usd']);
const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
function safeContext(context = {}) {
  try {
    const result = {
      repository: repositories.has(context.repository) ? context.repository : 'UNKNOWN',
      operation: operations.has(context.operation) ? context.operation : 'preflight',
      phase: phases.has(context.phase) ? context.phase : 'guard',
      run_id: Number.isSafeInteger(context.run_id) && context.run_id > 0 ? context.run_id : null,
    };
    if (Number.isSafeInteger(context.page) && context.page >= 1 && context.page <= 20) result.page = context.page;
    if (workflows.has(context.workflow)) result.workflow = context.workflow;
    if (statuses.has(context.requested_status)) result.requested_status = context.requested_status;
    return result;
  } catch { return {repository:'UNKNOWN', operation:'preflight', phase:'guard', run_id:null}; }
}
const bindingFields = new Set(['jobs.count','job.present','job.id','job.run_id','job.run_attempt',
  'job.head_sha','job.status','job.conclusion','job.started_at','job.completed_at','job.steps.is_array',
  ...['native','commit'].flatMap(prefix => ['matches','name','number','status','conclusion','started_at','completed_at'].map(key => `${prefix}.${key}`))]);
const bindingTypes = new Set(['undefined','null','array','object','string','number','boolean','bigint','function','symbol']);
const bindingStates = new Set(['queued','in_progress','completed','pending','waiting','requested',
  'success','failure','neutral','cancelled','skipped','timed_out','action_required','startup_failure','stale']);
function cleanBindingValue(field, descriptor) {
  const type = descriptor?.type;
  if (!bindingTypes.has(type)) return {type:'unavailable'};
  const result = {type};
  const length = descriptor.length;
  if (type === 'string' && Number.isSafeInteger(length) && length >= 0) result.length = length;
  if (field.endsWith('.name')) {
    const digest = descriptor.sha256;
    if (type === 'string' && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) result.sha256 = digest;
    return result; // Raw step names are never eligible, even on a forged error.
  }
  const value = descriptor.value;
  const numeric = /(?:\.id|\.run_id|\.run_attempt|\.number|\.count|\.matches)$/.test(field);
  if (numeric && ((result.type === 'number' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (result.type === 'string' && typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))))) result.value = value;
  else if ((field.endsWith('.present') || field.endsWith('.is_array')) && result.type === 'boolean' && typeof value === 'boolean') result.value = value;
  else if (field.endsWith('.head_sha') && result.type === 'string' && typeof value === 'string' && /^[a-fA-F0-9]{40}$/.test(value)) result.value = value;
  else if (/(?:\.started_at|\.completed_at)$/.test(field) && result.type === 'string' && typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))) result.value = value;
  else if (/(?:\.status|\.conclusion)$/.test(field) && result.type === 'string' && typeof value === 'string' && bindingStates.has(value)) result.value = value;
  return result;
}
function committedJobBindingDetails(error) {
  try {
    const detail = error?.committed_job_binding;
    const mismatches = detail?.mismatches;
    if (detail?.version !== 'committed-job-binding-1' || !Array.isArray(mismatches)) return null;
    const rows = [];
    for (const row of mismatches.slice(0,32)) {
      const field = row?.field;
      if (!bindingFields.has(field)) continue;
      rows.push({field, expected:cleanBindingValue(field,row.expected), observed:cleanBindingValue(field,row.observed)});
    }
    return {version:'committed-job-binding-1',mismatches:rows};
  } catch { return null; }
}
function diagnose(error, context) {
  const result = {version:'paid-preflight-diagnostic-1', ...safeContext(context),
    category:'UNKNOWN', error_code:'UNCLASSIFIED'};
  try {
    if (result.phase === 'github_read') {
      const native = privateDownloadFailureDiagnostic(error);
      const category = /^(?:HTTP_[45]\d\d|OUTPUT_LIMIT|CLIENT_MISSING|TERMINATED_UNKNOWN)$/.test(native.category)
        ? native.category : 'UNKNOWN';
      return {...result, category, error_code:'GITHUB_READ_FAILED',
        exit_status:native.exit_status, native_code:native.native_code,
        stderr_shape:native.stderr_shape, killed:native.killed,
        signal:native.signal, fields_state:native.fields_state};
    }
    if (result.phase === 'json_decode' || error instanceof SyntaxError)
      return {...result, category:'JSON_INVALID', error_code:'JSON_PARSE_FAILED'};
    const message = error?.message;
    if (publicCodes.has(message)) {
      const binding = message === 'PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID' ? committedJobBindingDetails(error) : null;
      return {...result, category:message.startsWith('RECOVERY_') ? 'RECOVERY_VALIDATION' : 'GUARD_VALIDATION',
        error_code:message, ...(binding ? {committed_job_binding:binding} : {})};
    }
    if (typeof message === 'string' && message.startsWith('RECOVERY_USAGE_INVALID:')) {
      const field = message.slice('RECOVERY_USAGE_INVALID:'.length);
      if (usageFields.has(field)) return {...result, category:'RECOVERY_VALIDATION',
        error_code:'RECOVERY_USAGE_INVALID', usage_field:field};
    }
  } catch { /* Unsafe/malformed error properties cannot escape into output. */ }
  return result;
}
export function paidPreflightDiagnostic(error, context = {}) {
  if (objectLike(error) && remembered.has(error)) return {...remembered.get(error)};
  return diagnose(error, context);
}
export function observePaidPreflightFailure(fn, context = {}) {
  try { return fn(); }
  catch (error) {
    if (objectLike(error) && !remembered.has(error)) remembered.set(error, Object.freeze(diagnose(error, context)));
    throw error; // Same object/message: no change to the existing fail-closed mapping.
  }
}
export function readPaidPreflightText(gh, args, context = {}) {
  return observePaidPreflightFailure(() => gh(args), {...context, phase:'github_read'});
}
export function readPaidPreflightJson(gh, args, context = {}) {
  const text = readPaidPreflightText(gh, args, context);
  return observePaidPreflightFailure(() => JSON.parse(text), {...context, phase:'json_decode'});
}
