import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// One audited published profile, not a location heuristic. Effects can
// legitimately cross borders; a different place alone is never a repair rule.
const REVIEWED = Object.freeze({
  story_id: 'wt-544a1c7fa90f447e', published_at: '2026-10-27T02:14:35.937Z',
  target_label: 'örtliche Feuerpause und humanitärer Korridor in Oleschky',
  profile_sha256: 'bb9ab71e28c83bc9be56973403647324abd959ad5c7feb2c0557f5fd0242be8f',
  observation_sha256: '04f50f9379b66ed653b51248ae0e1423043713356f634f15a311ee68179a1991',
  at: '2026-10-27T02:53:00.000Z',
  note: 'In der ersten Darstellung erschien der berichtete Raketenangriff auf Kiew im Wirkungsprofil der Feuerpause in Oleschky. Der Angriff ist ein anderer Quellvorgang. Seine berichteten Schäden werden deshalb als getrennter Quellenkontext und nicht als Folge der Feuerpause dargestellt. Quellen, Schadensangaben und Wirkungspotenzial der Feuerpause bleiben unverändert.',
});

const LOERRACH = Object.freeze({
  story_id: 'wt-c0d6ac76177a2223',
  published_at: '2026-11-11T20:20:28.261Z',
  profile_sha256: 'c2686080f89ce3b0194a453d13ca9c8b0c945e34180f31b006dd45d0a8b1f5b1',
  at: '2026-11-14T00:00:00.000Z',
  source: 'https://www.presseportal.de/blaulicht/pm/110970/6388763',
  note: 'Laut Polizeimeldung vom 11. November ereignete sich die Explosion am 10. November 2026. Belegt ist ein Sachschaden im Eingangsbereich. Ob und in welchem Umfang Reparatur und Entsorgung zu einer Umweltveränderung führen, bleibt offen. Die frühere Zuordnung als beobachtete Planet-Wirkung ist daher zurückgezogen.',
});

export function loerrachObservationCorrection(record = {}, assessment = record.impact_assessment || record.analysis?.impact_assessment) {
  if (record.story_id !== LOERRACH.story_id || record.published !== true
    || record.published_at !== LOERRACH.published_at || record.manual_only || record.editorial_approval_hash
    || observationContextFingerprint(assessment) !== LOERRACH.profile_sha256) return null;
  return LOERRACH;
}

export function observationContextFingerprint(assessment = {}) {
  const {version, news_event, evaluation_target, baseline, counterfactual, temporal_status, dimensions, observed_effects} = assessment;
  return hash({version, news_event, evaluation_target, baseline, counterfactual, temporal_status, dimensions, observed_effects});
}

// Read-only publication projection. All paid answers, stored assessments,
// receipts and original versions stay byte-for-byte unchanged. Matching the
// semantic profile also covers the public DTO after private review metadata
// has been stripped. A changed assessment requires a new editorial audit.
export function projectReviewedObservationContext(input = {}, assessment = {}, reviewed = REVIEWED) {
  if (input.published === false || input.manual_only || input.editorial_approval_hash
    || (input.story_id && input.story_id !== reviewed.story_id)
    || (input.published_at && input.published_at !== reviewed.published_at)
    || assessment.evaluation_target?.label !== reviewed.target_label
    || !Number.isFinite(Date.parse(reviewed.at))
    || assessment.source_context_observations || assessment.observation_context_correction
    || observationContextFingerprint(assessment) !== reviewed.profile_sha256) return assessment;
  const matches = (assessment.observed_effects || []).filter(effect => hash(effect) === reviewed.observation_sha256);
  if (matches.length !== 1) return assessment;
  const projected = structuredClone(assessment);
  projected.observed_effects = projected.observed_effects.filter(effect => hash(effect) !== reviewed.observation_sha256);
  projected.source_context_observations = [{...structuredClone(matches[0]), same_target: false, same_baseline: false}];
  projected.observation_context_correction = {at: reviewed.at, note: reviewed.note};
  return projected;
}
