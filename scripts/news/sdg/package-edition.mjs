import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, safeUrl } from '../bridge/contract.mjs';
import { deriveImpactPresentation, IMPACT_KEYS } from '../impact-assessment.mjs';
import { publicImpactAssessment } from '../impact-release.mjs';
import { EditionLedger } from './editions.mjs';
import { reviewedMeasureSourcesHash } from './reviewed-measure-handoff.mjs';

const digestPattern = /^[a-f0-9]{64}$/;

function projectEditionItem(ledger, entry) {
  const stored = ledger.readDossier(entry.id);
  const dossier = stored?.dossier;
  if (!dossier?.record || !Array.isArray(dossier.evidence) || stored.dossierHash !== entry.dossier_hash ||
      dossier.revision?.revision_id !== entry.id || !digestPattern.test(dossier.case_id || '') ||
      dossier.review?.accepted_at !== entry.ready_at ||
      entry.analysis_hash !== hash(dossier.record.impact_assessment) ||
      entry.source_hash !== reviewedMeasureSourcesHash(dossier.record, dossier.evidence)) {
    throw Error('SDG_EDITION_DOSSIER_MISMATCH');
  }
  const profile = publicImpactAssessment(dossier.record);
  if (!profile || profile.version !== '2.1') throw Error('SDG_EDITION_PUBLIC_IMPACT_PROFILE_REQUIRED');
  const presentation = deriveImpactPresentation(profile);
  const sources = dossier.evidence.map(evidence => {
    const proof = dossier.record.sources.find(source => source.url === evidence.url &&
      source.sdg_evidence?.registry_id === evidence.registry_id &&
      source.sdg_evidence?.reference === evidence.reference &&
      source.sdg_evidence?.snapshot_sha256 === evidence.snapshot_sha256);
    if (!proof) throw Error('SDG_EDITION_SOURCE_UNBOUND');
    return { url: safeUrl(evidence.url), title: proof.title, publisher: proof.publisher ?? null,
      source_published_at: evidence.original_published_at, discovered_at: evidence.discovered_at };
  });
  if (typeof dossier.record.title !== 'string' || !dossier.record.title.trim() ||
      typeof dossier.record.source_summary !== 'string' || !dossier.record.source_summary.trim() || !sources.length) {
    throw Error('SDG_EDITION_PUBLIC_CONTENT_REQUIRED');
  }
  return {
    case_id: dossier.case_id,
    revision_id: entry.id,
    event_id: dossier.revision.event_id,
    supersedes: dossier.revision.supersedes,
    stage: dossier.revision.stage,
    domain: dossier.revision.domain,
    event_at: dossier.revision.event_at,
    discovered_at: dossier.revision.discovered_at,
    title: dossier.record.title,
    summary: dossier.record.source_summary,
    sources,
    impact: Object.fromEntries(IMPACT_KEYS.map(key => {
      const part = presentation.dimensions[key];
      return [key, { direction: part.direction, magnitude: part.magnitude, label: part.label,
        temporal_status: part.temporal_status, evidence_label: part.evidence_label }];
    })),
  };
}

export function packageSdgEdition(ledger, editionId) {
  const edition = ledger.read(editionId);
  if (!edition || edition.state !== 'staged' || edition.publication_at !== null) throw Error('SDG_EDITION_NOT_STAGED');
  const { id, scheduled_at: scheduledAt, cutoff, sealed_at: sealedAt, items } = edition;
  if (edition.hash !== hash({ id, scheduledAt, cutoff, sealedAt, items })) {
    throw Error('SDG_EDITION_MANIFEST_CHANGED');
  }
  const manifest = {
    schema_version: 1,
    kind: 'sdg_edition_candidate',
    edition_id: id,
    ledger_sha256: edition.hash,
    scheduled_at: scheduledAt,
    cutoff_at: cutoff,
    sealed_at: sealedAt,
    published_at: null,
    items: items.map(entry => projectEditionItem(ledger, entry)),
  };
  return { manifest, sha256: hash(manifest) };
}

export function writeSdgEditionCandidate(directory, pack) {
  if (pack.sha256 !== hash(pack.manifest)) throw Error('SDG_EDITION_PACKAGE_CHANGED');
  const file = path.join(directory, `sdg-edition-${pack.sha256}.json`);
  const bytes = JSON.stringify(pack, null, 2) + '\n';
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(directory, '.sdg-edition-'));
  try {
    const staged = path.join(temporary, 'candidate.json');
    fs.writeFileSync(staged, bytes, { mode: 0o600 });
    try { fs.linkSync(staged, file); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== bytes) throw error;
    }
    return file;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const required = ['edition-db', 'edition-id', 'out'];
  const values = required.map(name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  if (values.some(value => !value)) throw Error('SDG_EDITION_DATABASE_ID_OUTPUT_REQUIRED');
  const [database, editionId, directory] = values;
  const ledger = new EditionLedger(database, { readOnly: true });
  try {
    const pack = packageSdgEdition(ledger, editionId);
    writeSdgEditionCandidate(directory, pack);
    console.log(JSON.stringify({ hash: pack.sha256, edition_id: editionId, count: pack.manifest.items.length }));
  } finally { ledger.close(); }
}
