import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeSession } from '../bridge/remote.mjs';
import { writeRepositoryJson } from '../newsroom-store.mjs';
import { writeSdgEditionCandidate } from './package-edition.mjs';
import { SDG_RUNNER_ARCHIVE_LIMIT } from './confirm-pages-delivery.mjs';
import { SDG_PAGES_REPOSITORY } from './pages-release.mjs';
import {
  loadSdgTickerPresentation, readSdgCatalogIndex, SDG_HASH, SDG_TRANSFER_BYTES, validateSdgEditionPackage,
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
  const { store, sdg } = bridgeSession();
  const run = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  await store.acquire(new Date().toISOString(), 'combined', { manualRunId: run });
  let success = false;
  try {
    const committed = loadSdgTickerPresentation(process.cwd())?.releases.at(-1);
    if (committed) {
      try {
        const receipt = await reconcileSdgReceiptFromRunner({
          sdg, committed: { edition_id: committed.edition_id, sha256: committed.sha256 },
        });
        if (['confirmed', 'already_confirmed', 'awaiting_delivery', 'current'].includes(receipt?.status)) {
          console.log(`SDG publication receipt: ${receipt.status}.`);
        }
      } catch {
        // Retain the uncertainty in Oracle. Receipt failure never initiates a
        // Pages retry, and a new editorial approval may still be published.
        console.warn('SDG_PAGES_RECEIPT_PENDING');
      }
    }
    const result = await importSdgBridgeEditions({ root: process.cwd(), sdg });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
    console.log(`Accepted ${result.count} checked SDG editions for the website build.`);
    success = true;
  } finally { await store.release(success); }
}
