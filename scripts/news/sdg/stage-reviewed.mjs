import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../bridge/contract.mjs';
import { BridgeStore } from '../bridge/store.mjs';
import { readRepositoryJson } from '../newsroom-store.mjs';
import { prepareReviewedStory } from '../publish-reviewed.mjs';
import { loadNewsRegistry } from '../registry.mjs';
import { EditionLedger } from './editions.mjs';
import { MeasureRevisions } from './measure-revisions.mjs';
import { MeasureReviewJournal, stageIndependentMeasureReview } from './measure-review-journal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function prepareReviewedSdgStory(input, registry, stories, at) {
  const result = prepareReviewedStory(input, registry, stories, at, { sdgMeasure: true });
  if (result.errors.length) throw Object.assign(Error('SDG_MEASURE_STORY_REVIEW_FAILED'), { issues: result.errors });
  // Keep the shared public projection unchanged. Only a source from the exact
  // reviewed packet can supply the private proof checked against the ledger.
  const originals = new Map(input.sources.map(source => [hash(source), source]));
  const sources = result.record.sources.map(source => {
    const original = originals.get(source.content_hash);
    if (!original?.sdg_evidence || original.source_id !== source.source_id || original.url !== source.url) {
      throw Error('SDG_MEASURE_EVIDENCE_UNBOUND');
    }
    const { registry_id, reference, snapshot_sha256 } = original.sdg_evidence;
    return { ...source, sdg_evidence: { registry_id, reference, snapshot_sha256 } };
  });
  const existing = stories.find(item => item.story_id === result.record.story_id);
  return { record: { ...result.record, sources }, existing };
}

export async function stageReviewedFiles({ review, impactReview, bridgeDatabase, measureDatabase, editionDatabase }) {
  const packet = readRepositoryJson(review);
  const receipt = readRepositoryJson(impactReview);
  if (packet.review_type && packet.review_type !== 'story') throw Error('SDG_MEASURE_REVIEW_TYPE_INVALID');
  const registry = loadNewsRegistry(root);
  const store = new BridgeStore(bridgeDatabase, { lane: 'import' });
  try {
    for (const file of [measureDatabase, editionDatabase]) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.chmodSync(file, 0o600);
    }
    const measures = new MeasureRevisions(measureDatabase);
    try {
      const editions = new EditionLedger(editionDatabase);
      try {
        return await stageIndependentMeasureReview({ packet, receipt, now: () => new Date().toISOString() }, {
          measures, editions, journal: new MeasureReviewJournal(store),
          // SDG revisions are matched and recovered by their private ledger
          // and review journal. The historical news store is outside this lane.
          prepareRecord: (input, at) => prepareReviewedSdgStory(input, registry, [], at),
        });
      } finally { editions.close(); }
    } finally { measures.close(); }
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const required = ['review', 'impact-review', 'bridge-db', 'measure-db', 'edition-db'];
  const values = required.map(name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  if (values.some(value => !value)) throw Error('SDG_REVIEW_FILES_AND_PRIVATE_DATABASES_REQUIRED');
  const [review, impactReview, bridgeDatabase, measureDatabase, editionDatabase] = values.map(value => path.resolve(value));
  const result = await stageReviewedFiles({ review, impactReview, bridgeDatabase, measureDatabase, editionDatabase });
  console.log(JSON.stringify({ status: result.status, revision_id: result.item?.id }));
}
