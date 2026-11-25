import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hash } from '../bridge/contract.mjs';
import { berlinInstant, lageDefinition } from '../lage.mjs';

export const SDG_HASH = /^[a-f0-9]{64}$/;
export const SDG_TRANSFER_BYTES = 512 * 1024;
const ID = /^\d{4}-\d{2}-\d{2}-(?:morgenlage|mittagslage|abendlage)$/;

export function isSdgReferenceList(value) {
  return Array.isArray(value) && value.every(reference => typeof reference === 'string' && reference.trim());
}

export function validateSdgEditionPackage(pack, id, digest) {
  if (typeof id !== 'string' || !ID.test(id) || typeof digest !== 'string' || !SDG_HASH.test(digest)) {
    throw Error('SDG_RELEASE_CATALOG_INVALID');
  }
  const manifest = pack?.manifest;
  const scheduled = berlinInstant(id.slice(0, 10), lageDefinition(id.slice(11)).hour);
  if (pack?.sha256 !== digest || !manifest || hash(manifest) !== digest || manifest.edition_id !== id ||
      ![1, 2].includes(manifest.schema_version) || manifest.kind !== 'sdg_edition_candidate' ||
      !SDG_HASH.test(manifest.ledger_sha256 || '') || manifest.published_at !== null || !Array.isArray(manifest.items) ||
      manifest.items.some(item => !item || typeof item !== 'object' || (manifest.schema_version === 2
        ? !isSdgReferenceList(item.reference_frameworks) : Object.hasOwn(item, 'reference_frameworks'))) ||
      !scheduled || scheduled !== manifest.scheduled_at ||
      ![manifest.cutoff_at, manifest.sealed_at].every(value => Number.isFinite(Date.parse(value))) ||
      Date.parse(manifest.cutoff_at) > Date.parse(manifest.sealed_at)) {
    throw Error('SDG_RELEASE_PACKAGE_MISMATCH');
  }
  return manifest;
}

export function readSdgCatalogIndex(root) {
  const storage = path.join(root, 'data/news/sdg');
  const filename = path.join(storage, 'release-catalog.json');
  const directory = path.join(storage, 'editions');
  if (!fs.existsSync(filename)) return { filename, directory, sha256: null, releases: [] };
  const bytes = fs.readFileSync(filename);
  const catalog = JSON.parse(bytes);
  if (catalog.schema_version !== 1 || !Array.isArray(catalog.releases)) throw Error('SDG_RELEASE_CATALOG_INVALID');
  const ids = new Set();
  const releases = catalog.releases.map(({ edition_id: id, sha256 }) => {
    if (typeof id !== 'string' || !ID.test(id) || ids.has(id) || typeof sha256 !== 'string' || !SDG_HASH.test(sha256)) {
      throw Error('SDG_RELEASE_CATALOG_INVALID');
    }
    ids.add(id);
    return { edition_id: id, sha256 };
  });
  return { filename, directory, sha256: createHash('sha256').update(bytes).digest('hex'), releases };
}

export function readSdgReleaseCatalog(root) {
  const catalog = readSdgCatalogIndex(root);
  const releases = catalog.releases.map(({ edition_id: id, sha256 }) => {
    const pack = JSON.parse(fs.readFileSync(path.join(catalog.directory, `sdg-edition-${sha256}.json`), 'utf8'));
    return { edition_id: id, sha256, manifest: validateSdgEditionPackage(pack, id, sha256) };
  });
  return { ...catalog, releases };
}

export function loadSdgTickerPresentation(root) {
  const filename = path.join(root, 'data/news/sdg/ticker-mode.json');
  if (!fs.existsSync(filename)) return null;
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (config?.schema_version !== 1 || config.mode !== 'sdg') throw Error('SDG_TICKER_MODE_INVALID');
  const catalog = readSdgReleaseCatalog(root);
  const anchor = catalog.releases.find(entry =>
    entry.edition_id === config.anchor?.edition_id && entry.sha256 === config.anchor?.sha256);
  if (!anchor || !anchor.manifest.items.length) throw Error('SDG_TICKER_RELEASE_ANCHOR_REQUIRED');
  return catalog;
}
