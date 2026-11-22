// A committed report can outlive its Actions log. This receipt replaces only
// the unavailable log transport for the single audited run below. It neither
// reconstructs paid answers nor changes story, input, or unknown-outcome holds.
import {createHash} from 'node:crypto';

const RUN_ID = 43093046835;
const REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';
const HEAD_SHA = '4c8259cf179221f2fd053579bc8e8a2588ee93ce';
const STARTED_AT = '2026-11-11T20:11:36.287Z';
const COMPLETED_AT = '2026-11-11T20:27:06.122Z';

export const COMMITTED_PAID_SOURCE = Object.freeze({
  repository: REPOSITORY,
  run_id: RUN_ID,
  atomic_commit: '61c322e7be6f7acc875e83ebce76b04f21c6b6db',
  report_blob: 'adf245bfb2f4aef586c6a8f3284e73825d0e3150',
  report_sha256: '1dd89f078f9072cf66d3ba321e10b0e83d1d09c67d95e3924ca6619608267bb1',
  usage_blob: '35d34c3bc7273a2ba5f6f2868f182f14e21c53b7',
  usage_row_sha256: 'ce489072dd01eaf0ee0584c58ae6dee4182e508a62f1627eb7f7a82c33170403',
});

// The original completed job response independently retained both successful
// steps. Use these archived fields only if the same strictly bound live job
// supplies an empty steps array; never replace nonempty or malformed metadata.
const RETAINED_JOB_STEPS = Object.freeze({
  kind: 'retained_original_job_steps',
  original_jobs_sha256: '75d85962d77176d13addc2b4c84d37a2b4d4f2f55f41758a2f8f0738e8305499',
  steps: Object.freeze([
    Object.freeze({name:'Import, analyze (one call per story) and build',number:14,
      status:'completed',conclusion:'success',
      started_at:'2026-11-11T20:11:36Z',completed_at:'2026-11-11T20:27:12Z'}),
    Object.freeze({name:'Commit one atomic update',number:24,
      status:'completed',conclusion:'success',
      started_at:'2026-11-11T20:35:06Z',completed_at:'2026-11-11T20:35:30Z'}),
  ]),
});

// Keep the original counters: successful request-attempts (3) plus failed
// calls (1) produced four accounted calls. The failed answer remains unknown.
const REPORT = Object.freeze({
  schema_version: '1.2', run_id: String(RUN_ID),
  started_at: STARTED_AT, completed_at: COMPLETED_AT,
  processing_version: '2026-09-15-direct-3',
  berlin_slot: 'Automatischer Lauf 21:00',
  ai_calls: 4, ai_stories: 4, ai_request_attempts: 3, ai_failed_calls: 1,
  ai_repair_calls: 0,
  provider: 'OpenAI Responses API', model: 'gpt-5.4-mini-2026-03-17',
  input_tokens: 69004, output_tokens: 89231, estimated_cost_usd: 0.441369,
  ai_output_failure_cost_usd: 0.152927,
  token_source: 'includes_reported_output_failure_usage',
  published_stories: 2, updated_stories: 0,
  title_images: [
    {story_id:'wt-c0d6ac76177a2223', status:'deferred', reason:'PUBLIC_MEDIA_RELEASE_NOT_AUTHORIZED', higgsfield_called:false},
    {story_id:'wt-efecabc69cbb42bf', status:'deferred', reason:'PUBLIC_MEDIA_RELEASE_NOT_AUTHORIZED', higgsfield_called:false},
  ],
});

function exactStep(steps, name, number, started, completed) {
  const matches = steps.filter(step => step.name === name);
  return matches.length === 1 && matches[0].number === number
    && matches[0].status === 'completed' && matches[0].conclusion === 'success'
    && matches[0].started_at === started && matches[0].completed_at === completed;
}

// Strict comparisons above and below remain authoritative. These bounded
// descriptors explain a rejection without retaining raw names or error text.
function bindingValue(field, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const result = {type};
  if (type === 'string') result.length = value.length;
  if (field.endsWith('.name')) {
    if (type === 'string') result.sha256 = createHash('sha256').update(value).digest('hex');
    return result;
  }
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  const states = ['queued','in_progress','completed','pending','waiting','requested',
    'success','failure','neutral','cancelled','skipped','timed_out','action_required','startup_failure','stale'];
  const numeric = /(?:\.id|\.run_id|\.run_attempt|\.number|\.count|\.matches)$/.test(field);
  if (numeric && ((type === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (type === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value))))) result.value = value;
  else if ((field.endsWith('.present') || field.endsWith('.is_array')) && type === 'boolean') result.value = value;
  else if (field.endsWith('.head_sha') && type === 'string' && /^[a-fA-F0-9]{40}$/.test(value)) result.value = value;
  else if (/(?:\.started_at|\.completed_at)$/.test(field) && type === 'string'
    && timestamp.test(value) && Number.isFinite(Date.parse(value))) result.value = value;
  else if (/(?:\.status|\.conclusion)$/.test(field) && type === 'string' && states.includes(value)) result.value = value;
  return result;
}

function jobBindingError(jobs) {
  const error = Error('PAID_PREFLIGHT_COMMITTED_JOB_BINDING_INVALID');
  try {
    const mismatches = [];
    const compare = (field, observed, expected) => {
      if (observed !== expected) mismatches.push({field,
        expected:bindingValue(field,expected), observed:bindingValue(field,observed)});
    };
    compare('jobs.count', jobs?.length, 1);
    const job = jobs?.length === 1 ? jobs[0] : null;
    compare('job.present', Boolean(job), true);
    if (job) {
      for (const [key,expected] of Object.entries({id:130774763726,run_id:RUN_ID,run_attempt:1,
        head_sha:HEAD_SHA,status:'completed',conclusion:'cancelled',
        started_at:'2026-11-11T20:04:28Z',completed_at:'2026-11-11T20:49:28Z'})) compare(`job.${key}`,job[key],expected);
      compare('job.steps.is_array',Array.isArray(job.steps),true);
      if (Array.isArray(job.steps)) for (const [prefix,name,number,started,completed] of [
        ['native','Import, analyze (one call per story) and build',14,'2026-11-11T20:11:36Z','2026-11-11T20:27:12Z'],
        ['commit','Commit one atomic update',24,'2026-11-11T20:35:06Z','2026-11-11T20:35:30Z']]) {
        const matches = job.steps.filter(step => step?.name === name);
        compare(`${prefix}.matches`,matches.length,1);
        if (matches.length === 1) for (const [key,expected] of Object.entries({number,status:'completed',conclusion:'success',started_at:started,completed_at:completed}))
          compare(`${prefix}.${key}`,matches[0][key],expected);
        else compare(`${prefix}.name`,job.steps.find(step => step?.number === number)?.name,name);
      }
    }
    Object.defineProperty(error,'committed_job_binding',{value:{version:'committed-job-binding-1',mismatches}});
  } catch { /* Diagnostic collection must never replace the original rejection. */ }
  return error;
}

export function committedPaidRunEvidence(run, jobs, usage, repository) {
  if (run?.id !== RUN_ID) return null;
  if (repository !== REPOSITORY || run.repository?.full_name !== REPOSITORY
    || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'cancelled'
    || run.head_sha !== HEAD_SHA || run.head_branch !== 'main'
    || run.path !== '.github/workflows/wirkungsticker.yml'
    || run.created_at !== '2026-11-11T20:04:25Z' || run.updated_at !== '2026-11-11T21:01:48Z') {
    throw Error('PAID_PREFLIGHT_COMMITTED_RUN_BINDING_INVALID');
  }
  const job = jobs?.length === 1 ? jobs[0] : null;
  const retainedSteps = Array.isArray(job?.steps) && job.steps.length === 0;
  const effectiveSteps = retainedSteps ? RETAINED_JOB_STEPS.steps : job?.steps;
  if (!job || job.id !== 130774763726 || job.run_id !== RUN_ID || job.run_attempt !== 1
    || job.head_sha !== HEAD_SHA || job.status !== 'completed' || job.conclusion !== 'cancelled'
    || job.started_at !== '2026-11-11T20:04:28Z' || job.completed_at !== '2026-11-11T20:49:28Z'
    || !Array.isArray(job.steps)
    || !exactStep(effectiveSteps, 'Import, analyze (one call per story) and build', 14,
      '2026-11-11T20:11:36Z', '2026-11-11T20:27:12Z')
    || !exactStep(effectiveSteps, 'Commit one atomic update', 24,
      '2026-11-11T20:35:06Z', '2026-11-11T20:35:30Z')) {
    throw jobBindingError(jobs);
  }
  const rows = Array.isArray(usage?.runs) ? usage.runs.filter(row =>
    row?.run_id === 'news-run-e3a88d3a37a9' || row?.started_at === STARTED_AT) : [];
  if (rows.length !== 1 || rows[0].recovery
    || createHash('sha256').update(JSON.stringify(rows[0])).digest('hex') !== COMMITTED_PAID_SOURCE.usage_row_sha256) {
    throw Error('PAID_PREFLIGHT_COMMITTED_USAGE_BINDING_INVALID');
  }
  return {report: structuredClone(REPORT), source: COMMITTED_PAID_SOURCE,
    ...(retainedSteps ? {
      nativeStep: structuredClone(RETAINED_JOB_STEPS.steps[0]),
      stepEvidence: {kind:RETAINED_JOB_STEPS.kind, original_jobs_sha256:RETAINED_JOB_STEPS.original_jobs_sha256},
    } : {}),
  };
}
