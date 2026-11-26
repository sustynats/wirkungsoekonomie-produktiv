import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeStore } from '../bridge/store.mjs';
import { EditionLedger } from './editions.mjs';
import { MeasureRevisions } from './measure-revisions.mjs';
import { MeasureReviewJournal, recoverClosedMeasureReviews } from './measure-review-journal.mjs';
import { readSdgReleaseCatalog, SDG_HASH } from './release-catalog.mjs';
import { registerSdgEdition } from './register-edition.mjs';

// Run in the serialized release checkout with the private review journal.
export function prepareScheduledSdgEditions({ root, ledger, journal, measures, startAt, checkedThrough, sealedAt, expectedCatalogHash }) {
  if (expectedCatalogHash !== null &&
      (typeof expectedCatalogHash !== 'string' || !SDG_HASH.test(expectedCatalogHash))) {
    throw Error('SDG_RELEASE_EXPECTED_CATALOG_REQUIRED');
  }
  const current = readSdgReleaseCatalog(root);
  if (current.sha256 !== expectedCatalogHash) throw Error('SDG_RELEASE_CATALOG_MOVED');
  const registered = new Map(current.releases.map(release => [release.edition_id, release]));
  for (const { edition_id: id, manifest } of current.releases) {
    if (manifest.scheduled_at >= startAt && ledger.editionHash(id) !== manifest.ledger_sha256) {
      throw Error('SDG_RELEASE_LEDGER_MISMATCH');
    }
  }
  const clock = typeof sealedAt === 'function' ? sealedAt : () => sealedAt;
  const acceptedReviews = recoverClosedMeasureReviews({ checkedThrough, now: clock() }, {
    journal, measures, editions: ledger,
  });
  const due = ledger.stageDue({ startAt, checkedThrough, sealedAt: clock(), acceptedReviews });
  const results = [];
  let catalogSha256 = current.sha256;
  for (const edition of due) {
    const release = registered.get(edition.id);
    if (release) {
      results.push({ edition_id: edition.id, edition_sha256: release.sha256, status: 'already_registered', paths: [] });
      continue;
    }
    const result = registerSdgEdition({ root, ledger, editionId: edition.id, expectedCatalogHash: catalogSha256 });
    catalogSha256 = result.catalog_sha256;
    results.push({ edition_id: edition.id, ...result });
  }
  return { catalog_sha256: catalogSha256, editions: results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fields = ['edition-db', 'bridge-db', 'measure-db', 'start-at', 'checked-through', 'expect-catalog'];
  const values = fields.map(name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  if (values.some(value => !value)) throw Error('SDG_SCHEDULE_DATABASE_START_CUTOFF_CATALOG_REQUIRED');
  const [editionDatabase, bridgeDatabase, measureDatabase, startAt, checkedThrough, baseline] = values;
  if (![editionDatabase, bridgeDatabase, measureDatabase].every(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())) {
    throw Error('SDG_SCHEDULE_EXISTING_DATABASES_REQUIRED');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const bridge = new BridgeStore(path.resolve(bridgeDatabase), { lane: 'import' });
  try {
    const journal = new MeasureReviewJournal(bridge);
    const measures = new MeasureRevisions(measureDatabase);
    try {
      const ledger = new EditionLedger(editionDatabase);
      try {
        console.log(JSON.stringify(prepareScheduledSdgEditions({
          root, ledger, journal, measures, startAt, checkedThrough, sealedAt: () => new Date().toISOString(),
          expectedCatalogHash: baseline === 'absent' ? null : baseline,
        })));
      } finally { ledger.close(); }
    } finally { measures.close(); }
  } finally { bridge.close(); }
}
