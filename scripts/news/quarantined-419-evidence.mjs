// Exact metadata recovered from the restored 419 report and provider starts;
// this is a receipt, never an approval or a substitute for the missing image.
export const QUARANTINED_419_IDS = Object.freeze(['wt-9d7f160ac0f47000', 'wt-6de83078b2772501']);

export function quarantine419Enabled(env = process.env) {
  return env.WOEK_NEWS_ONLY === 'true' && env.VISUAL_GENERATION_PROVIDER === 'disabled';
}

export function restored419Evidence(run, nativeStep) {
  if (run.id !== 41913667334) return null;
  const valid = run.status === 'completed' && run.conclusion === 'failure' && run.run_attempt === 1
    && run.created_at === '2026-11-04T21:11:02Z' && run.updated_at === '2026-11-04T21:30:08Z'
    && nativeStep?.conclusion === 'success'
    && Date.parse(nativeStep.started_at) <= Date.parse('2026-11-04T21:14:51.641Z')
    && Date.parse(nativeStep.completed_at) >= Date.parse('2026-11-04T21:26:36.568Z');
  if (!valid) throw Error('PAID_PREFLIGHT_419_RUN_BINDING_INVALID');
  return { report: {
    run_id:'41913667334', started_at:'2026-11-04T21:14:51.641Z', completed_at:'2026-11-04T21:26:36.568Z',
    berlin_slot:'manueller Lauf', processing_version:'2026-09-15-direct-3', ai_calls:2, ai_stories:2,
    input_tokens:35892, output_tokens:14041, estimated_cost_usd:0.024027, token_source:'provider_reported_usage',
    published_stories:1, updated_stories:0,
    title_images:[{story_id:QUARANTINED_419_IDS[0], higgsfield_called:true,
      source_reused:false, status:'fallback', fallback_reason:'TITLE_IMAGE_UNAVAILABLE'}],
  }, providerEvents: QUARANTINED_419_IDS.map(story_id => ({story_ids:[story_id]})) };
}
