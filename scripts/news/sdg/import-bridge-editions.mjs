import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bridgeSession } from '../bridge/remote.mjs';
import { writeRepositoryJson } from '../newsroom-store.mjs';
import { writeSdgEditionCandidate } from './package-edition.mjs';
import { SDG_RUNNER_ARCHIVE_LIMIT } from './confirm-pages-delivery.mjs';
import { SDG_PAGES_REPOSITORY } from './pages-release.mjs';
import {
  loadSdgTickerPresentation, readSdgCatalogIndex, readSdgReleaseCatalog, SDG_HASH, SDG_TRANSFER_BYTES, validateSdgEditionPackage,
} from './release-catalog.mjs';

const gitFileCeiling = 100 * 1024 * 1024;
const editionId = /^\d{4}-\d{2}-\d{2}-(?:morgenlage|mittagslage|abendlage)$/;
const itemKeys = 'case_id revision_id event_id supersedes stage domain event_at discovered_at title summary sources impact';
const sourceKeys = 'url title publisher source_published_at discovered_at';
const impactKeys = 'direction magnitude label temporal_status evidence_label';

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = keys.split(' ');
  return expected.length === Object.keys(value).length && expected.every(key => Object.hasOwn(value, key));
}

function publicScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value);
}

function publicFields(value, keys) {
  return exactKeys(value, keys) && Object.values(value).every(publicScalar);
}

function requirePublicProjection(pack, entry) {
  const manifest = validateSdgEditionPackage(pack, entry.edition_id, entry.sha256);
  const hasReferences = manifest.schema_version === 2;
  const keys = hasReferences ? `${itemKeys} reference_frameworks` : itemKeys;
  if (!exactKeys(pack, 'manifest sha256') || !exactKeys(manifest,
    'schema_version kind edition_id ledger_sha256 scheduled_at cutoff_at sealed_at published_at items') ||
    manifest.items.some(item => !exactKeys(item, keys) ||
      !Object.entries(item).every(([key, value]) =>
        ['sources', 'impact', 'reference_frameworks'].includes(key) || publicScalar(value)) ||
      !Array.isArray(item.sources) || !item.sources.every(source => publicFields(source, sourceKeys)) ||
      !exactKeys(item.impact, 'human planet democracy') ||
      !Object.values(item.impact).every(impact => publicFields(impact, impactKeys)))) {
    throw Error('SDG_BRIDGE_PUBLIC_PROJECTION_REQUIRED');
  }
  return pack;
}

async function transferPackage(sdg, entry, file) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    for (let offset = 0; offset < entry.bytes; offset += SDG_TRANSFER_BYTES) {
      const chunk = await sdg.readPackage(entry.sha256, offset);
      const bytes = Buffer.from(chunk?.bytes ?? '', 'base64');
      if (chunk?.sha256 !== entry.sha256 || chunk.offset !== offset || chunk.total !== entry.bytes ||
          bytes.length !== Math.min(SDG_TRANSFER_BYTES, entry.bytes - offset) ||
          bytes.toString('base64') !== chunk.bytes || fs.writeSync(fd, bytes) !== bytes.length) {
        throw Error('SDG_BRIDGE_PACKAGE_TRANSFER_MISMATCH');
      }
    }
  } finally { fs.closeSync(fd); }
  requirePublicProjection(JSON.parse(fs.readFileSync(file, 'utf8')), entry);
}

// The initial, already reviewed package can be staged before ticker-mode.json.
// The normal Pages build still owns publication and the verified receipt.
export function importFirstSdgPackage({ root, packageFile, editionId: id, expectedSha256 }) {
  if (typeof id !== 'string' || !editionId.test(id) || typeof expectedSha256 !== 'string' ||
      !SDG_HASH.test(expectedSha256) || typeof packageFile !== 'string' || !packageFile) {
    throw Error('SDG_FIRST_PACKAGE_BINDING_REQUIRED');
  }
  if (fs.existsSync(path.join(root, 'data/news/sdg/ticker-mode.json'))) throw Error('SDG_FIRST_PACKAGE_MODE_ALREADY_SET');
  const catalog = readSdgCatalogIndex(root);
  const [registered] = catalog.releases;
  if (registered && (catalog.releases.length !== 1 || registered.edition_id !== id || registered.sha256 !== expectedSha256)) {
    throw Error('SDG_FIRST_PACKAGE_CATALOG_ALREADY_SET');
  }
  const filename = registered ? path.join(catalog.directory, `sdg-edition-${expectedSha256}.json`) : packageFile;
  let pack;
  try {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size >= gitFileCeiling) throw Error('SDG_FIRST_PACKAGE_SIZE_INVALID');
      const bytes = Buffer.alloc(stat.size);
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fs.fstatSync(fd).size !== stat.size) {
        throw Error('SDG_FIRST_PACKAGE_SIZE_INVALID');
      }
      pack = JSON.parse(bytes);
    } finally { fs.closeSync(fd); }
  } catch { throw Error('SDG_FIRST_PACKAGE_UNREADABLE'); }
  const entry = { edition_id: id, sha256: expectedSha256 };
  requirePublicProjection(pack, entry);
  if (!pack.manifest.items.length) throw Error('SDG_FIRST_PACKAGE_EMPTY');
  if (registered) return { status: 'already_registered', edition_id: id, edition_sha256: expectedSha256 };
  if (readSdgCatalogIndex(root).sha256 !== catalog.sha256) throw Error('SDG_RELEASE_CATALOG_MOVED');
  writeSdgEditionCandidate(catalog.directory, pack);
  writeRepositoryJson(catalog.filename, { schema_version: 1, releases: [entry] });
  return { status: 'registered_for_website_build', edition_id: id, edition_sha256: expectedSha256 };
}

export async function importSdgBridgeEditions({ root, sdg }) {
  const catalog = loadSdgTickerPresentation(root);
  if (!catalog) return { changed: false, count: 0 };
  const { edition_id, sha256 } = catalog.releases.at(-1);
  const pending = await sdg.prepare({ edition_id, sha256 });
  if (!Array.isArray(pending)) throw Error('SDG_BRIDGE_CATALOG_RESPONSE_INVALID');
  if (!pending.length) return { changed: false, count: 0 };
  const occupied = new Set(catalog.releases.map(entry => entry.edition_id));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-public-editions-'));
  try {
    const packages = [];
    for (const entry of pending) {
      if (!exactKeys(entry, 'edition_id sha256 bytes') || typeof entry.edition_id !== 'string' ||
          !editionId.test(entry.edition_id) || occupied.has(entry.edition_id) ||
          typeof entry.sha256 !== 'string' || !SDG_HASH.test(entry.sha256) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes >= gitFileCeiling) {
        throw Error('SDG_BRIDGE_CATALOG_RESPONSE_INVALID');
      }
      const file = path.join(dir, entry.sha256);
      await transferPackage(sdg, entry, file);
      occupied.add(entry.edition_id);
      packages.push({ entry, file });
    }
    if (readSdgCatalogIndex(root).sha256 !== catalog.sha256) throw Error('SDG_RELEASE_CATALOG_MOVED');
    for (const { entry, file } of packages) {
      writeSdgEditionCandidate(catalog.directory, requirePublicProjection(JSON.parse(fs.readFileSync(file, 'utf8')), entry));
    }
    const releases = [...catalog.releases, ...pending].map(({ edition_id, sha256 }) => ({ edition_id, sha256 }));
    writeRepositoryJson(catalog.filename, { schema_version: 1, releases });
    return { changed: true, count: pending.length };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function downloadRunnerArchive(artifactId) {
  if (!process.env.GH_TOKEN) throw Error('SDG_PAGES_RUNNER_ARCHIVE_UNAVAILABLE');
  try {
    return execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
      `repos/${SDG_PAGES_REPOSITORY}/actions/artifacts/${artifactId}/zip`], {
      timeout: 30_000, maxBuffer: SDG_RUNNER_ARCHIVE_LIMIT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw Error('SDG_PAGES_RUNNER_ARCHIVE_UNAVAILABLE');
  }
}

export async function reconcileSdgReceiptFromRunner({ sdg, committed, downloadArchive = downloadRunnerArchive }) {
  const result = await sdg.reconcile(committed);
  if (result?.status !== 'archive_required') return result;
  const { artifact_id, artifact_sha256, manifest_observation } = result;
  if (typeof artifact_id !== 'string' || !/^[1-9]\d{0,19}$/.test(artifact_id) ||
      typeof artifact_sha256 !== 'string' || !SDG_HASH.test(artifact_sha256) ||
      typeof manifest_observation !== 'string' || !/^discovery-[a-zA-Z0-9]{6}$/.test(manifest_observation)) {
    throw Error('SDG_PAGES_RUNNER_ARCHIVE_REQUEST_INVALID');
  }
  const bytes = Buffer.from(await downloadArchive(artifact_id));
  if (!bytes.length || bytes.length > SDG_RUNNER_ARCHIVE_LIMIT ||
      createHash('sha256').update(bytes).digest('hex') !== artifact_sha256) {
    throw Error('SDG_PAGES_AUDIT_ARTIFACT_MISMATCH');
  }
  return sdg.reconcile(committed, { artifact_id, manifest_observation, archive_base64: bytes.toString('base64') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    if (process.env.GITHUB_ACTIONS === 'true') throw Error('SDG_FIRST_PACKAGE_LOCAL_CHECKOUT_REQUIRED');
    const { values } = parseArgs({ options: {
      'first-package': { type: 'string' }, 'edition-id': { type: 'string' }, sha256: { type: 'string' },
    } });
    console.log(JSON.stringify(importFirstSdgPackage({
      root: process.cwd(), packageFile: values['first-package'], editionId: values['edition-id'], expectedSha256: values.sha256,
    })));
  } else {
    await runBridgeImport();
  }
}

export async function receiveSdgBridgeEditions({ root, run, connect = bridgeSession, downloadArchive }) {
  const active = loadSdgTickerPresentation(root);
  const { releases } = active ?? readSdgReleaseCatalog(root);
  if (!releases.some(entry => entry.manifest.items.length)) return { changed: false, count: 0 };
  const committed = releases.at(-1);

  const { store, sdg } = connect();
  await store.acquire(new Date().toISOString(), 'combined', { manualRunId: run });
  let success = false;
  try {
    try {
      const receipt = await reconcileSdgReceiptFromRunner({
        sdg, committed: { edition_id: committed.edition_id, sha256: committed.sha256 }, downloadArchive,
      });
      if (['confirmed', 'already_confirmed', 'awaiting_delivery', 'current'].includes(receipt?.status)) {
        console.log(`SDG publication receipt: ${receipt.status}.`);
      }
    } catch {
      // Receipt uncertainty must not initiate a retry or stop editorial delivery.
      console.warn('SDG_PAGES_RECEIPT_PENDING');
    }
    const result = active ? await importSdgBridgeEditions({ root, sdg }) : { changed: false, count: 0 };
    success = true;
    return result;
  } finally { await store.release(success); }
}

async function runBridgeImport() {
  const result = await receiveSdgBridgeEditions({
    root: process.cwd(), run: `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`,
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
  console.log(`Accepted ${result.count} checked SDG editions for the website build.`);
}
