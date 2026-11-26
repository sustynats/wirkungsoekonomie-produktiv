import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRepositoryJson } from '../newsroom-store.mjs';
import { EditionLedger } from './editions.mjs';
import { packageSdgEdition, writeSdgEditionCandidate } from './package-edition.mjs';
import { readSdgReleaseCatalog, SDG_HASH, validateSdgEditionPackage } from './release-catalog.mjs';

// Invoked in the existing serialized release checkout. This prepares the
// source paths for that checkout's Git commit; Pages deployment stays owned
// by the site's normal workflow.
export function registerSdgEdition({ root, ledger, editionId, expectedCatalogHash }) {
  if (expectedCatalogHash !== null &&
      (typeof expectedCatalogHash !== 'string' || !SDG_HASH.test(expectedCatalogHash))) {
    throw Error('SDG_RELEASE_EXPECTED_CATALOG_REQUIRED');
  }
  return ledger.transaction(() => {
    const current = readSdgReleaseCatalog(root);
    const pack = packageSdgEdition(ledger, editionId);
    validateSdgEditionPackage(pack, editionId, pack.sha256);
    const already = current.releases.find(release => release.edition_id === editionId);
    if (already) {
      if (already.sha256 !== pack.sha256) throw Error('SDG_RELEASE_EDITION_IMMUTABLE');
      return { status: 'already_registered', catalog_sha256: current.sha256, edition_sha256: pack.sha256, paths: [] };
    }
    if (current.sha256 !== expectedCatalogHash) throw Error('SDG_RELEASE_CATALOG_MOVED');
    const releases = current.releases.map(({ edition_id, sha256 }) => ({ edition_id, sha256 }));
    releases.push({ edition_id: editionId, sha256: pack.sha256 });
    const packageFile = writeSdgEditionCandidate(current.directory, pack);
    writeRepositoryJson(current.filename, { schema_version: 1, releases });
    const result = readSdgReleaseCatalog(root);
    return {
      status: 'registered_for_website_build',
      previous_catalog_sha256: current.sha256,
      catalog_sha256: result.sha256,
      edition_sha256: pack.sha256,
      paths: [packageFile, current.filename].map(file => path.relative(root, file)),
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const required = ['edition-db', 'edition-id', 'expect-catalog'];
  const values = required.map(name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  if (values.some(value => !value)) throw Error('SDG_RELEASE_DATABASE_EDITION_CATALOG_REQUIRED');
  const [database, editionId, baseline] = values;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const ledger = new EditionLedger(database);
  try {
    console.log(JSON.stringify(registerSdgEdition({ root, ledger, editionId,
      expectedCatalogHash: baseline === 'absent' ? null : baseline })));
  } finally { ledger.close(); }
}
