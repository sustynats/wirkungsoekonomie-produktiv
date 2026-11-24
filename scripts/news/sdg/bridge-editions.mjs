import fs from 'node:fs';
import path from 'node:path';
import { EditionLedger } from './editions.mjs';
import { MeasureRevisions } from './measure-revisions.mjs';
import { MeasureReviewJournal } from './measure-review-journal.mjs';
import { prepareScheduledSdgEditions } from './prepare-scheduled-editions.mjs';
import { readSdgCatalogIndex, readSdgReleaseCatalog, SDG_HASH, SDG_TRANSFER_BYTES } from './release-catalog.mjs';
import { reconcileSdgPagesDelivery } from './confirm-pages-delivery.mjs';

const privateFile = filename => {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat?.isFile() || (stat.mode & 0o077)) throw Error('SDG_BRIDGE_PRIVATE_FILE_REQUIRED');
  return stat;
};

// Only the public projection crosses the existing authenticated import lane.
// Journal rows, snapshots, drafts, review identities and databases stay here.
export function serveSdgEditions(directory, startAt, bridge, { clock = () => new Date().toISOString() } = {}) {
  const privateRoot = path.join(directory, 'sdg');
  const root = path.join(privateRoot, 'publication');
  const editionDb = path.join(privateRoot, 'editions.sqlite');
  const measureDb = path.join(privateRoot, 'measures.sqlite');
  const start = Date.parse(startAt);
  if (!Number.isFinite(start) || new Date(start).toISOString() !== startAt) throw Error('SDG_BRIDGE_START_REQUIRED');
  for (const folder of [privateRoot, root]) {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || (stat.mode & 0o077)) throw Error('SDG_BRIDGE_PRIVATE_DIRECTORY_REQUIRED');
  }
  const packagePath = (catalog, digest) => path.join(catalog.directory, `sdg-edition-${digest}.json`);

  function after(catalog, cursor) {
    const index = catalog.releases.findIndex(entry =>
      entry.edition_id === cursor?.edition_id && entry.sha256 === cursor?.sha256);
    if (index < 0) throw Error('SDG_BRIDGE_CATALOG_PREFIX_MISMATCH');
    return index + 1;
  }

  return {
    prepare(cursor) {
      const prior = readSdgCatalogIndex(root);
      after(prior, cursor);
      // Use the Oracle clock and the configured start, never timestamps from
      // the HTTP caller. The existing journal serializes accepted reviews.
      const checkedThrough = clock();
      if (checkedThrough >= startAt) {
        privateFile(editionDb);
        privateFile(measureDb);
        const ledger = new EditionLedger(editionDb);
        try {
          const measures = new MeasureRevisions(measureDb);
          try {
            prepareScheduledSdgEditions({
              root, ledger, journal: new MeasureReviewJournal(bridge), measures, startAt,
              checkedThrough, sealedAt: clock, expectedCatalogHash: prior.sha256,
            });
          } finally { measures.close(); }
        } finally { ledger.close(); }
      }
      const catalog = readSdgCatalogIndex(root);
      return catalog.releases.slice(after(catalog, cursor)).map(entry => ({
        ...entry, bytes: privateFile(packagePath(catalog, entry.sha256)).size,
      }));
    },
    readPackage(digest, offset) {
      if (typeof digest !== 'string' || !SDG_HASH.test(digest) || !Number.isSafeInteger(offset) ||
          offset < 0 || offset % SDG_TRANSFER_BYTES !== 0) throw Error('SDG_BRIDGE_PACKAGE_REQUEST_INVALID');
      const catalog = readSdgCatalogIndex(root);
      if (!catalog.releases.some(entry => entry.sha256 === digest)) throw Error('SDG_BRIDGE_PACKAGE_NOT_REGISTERED');
      const file = packagePath(catalog, digest);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) || offset >= stat.size) throw Error('SDG_BRIDGE_PACKAGE_REQUEST_INVALID');
        const bytes = Buffer.alloc(Math.min(SDG_TRANSFER_BYTES, stat.size - offset));
        if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length) throw Error('SDG_BRIDGE_PACKAGE_READ_INCOMPLETE');
        return { sha256: digest, offset, total: stat.size, bytes: bytes.toString('base64') };
      } finally { fs.closeSync(fd); }
    },
    async reconcile(committed) {
      privateFile(editionDb);
      const ledger = new EditionLedger(editionDb);
      try {
        return await reconcileSdgPagesDelivery({
          root, ledger, committed, evidenceDirectory: path.join(privateRoot, 'receipts'),
        });
      } finally { ledger.close(); }
    },
    reserveDispatch(committed, sourceCommit, owner) {
      const catalog = readSdgReleaseCatalog(root);
      const tail = catalog.releases.at(-1);
      if (!tail || catalog.sha256 !== committed?.catalog_sha256 || tail.edition_id !== committed.edition_id ||
          tail.sha256 !== committed.sha256) throw Error('SDG_PAGES_DISPATCH_BINDING_REQUIRED');
      privateFile(editionDb);
      const ledger = new EditionLedger(editionDb);
      try {
        if (ledger.editionHash(tail.edition_id) !== tail.manifest.ledger_sha256) throw Error('SDG_RELEASE_LEDGER_MISMATCH');
        return ledger.reservePagesDispatch({ editionId: tail.edition_id, editionHash: tail.sha256,
          catalogHash: catalog.sha256, sourceCommit, runOwner: owner, reservedAt: clock() });
      } finally { ledger.close(); }
    },
  };
}
