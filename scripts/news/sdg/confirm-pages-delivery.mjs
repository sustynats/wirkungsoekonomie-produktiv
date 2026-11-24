import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditionLedger } from './editions.mjs';
import { packageSdgEdition } from './package-edition.mjs';
import {
  inspectSdgPagesAudit, SDG_PAGES_RELEASE_PATH, SDG_PAGES_REPOSITORY,
  verifySdgCompletedPagesRun, verifySdgPublicDelivery,
} from './pages-release.mjs';
import { loadSdgTickerPresentation, readSdgReleaseCatalog } from './release-catalog.mjs';

const numbered = /^[1-9]\d{0,19}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const officialSite = 'https://wirkungsoekonomie.de/';
const observationName = /^discovery-[a-zA-Z0-9]{6}$/;
const metadataRoute = /^actions\/runs\/[1-9]\d{0,19}\/(?:attempts\/[1-9]\d{0,19}(?:\/jobs\?per_page=100)?|artifacts\?per_page=100)$/;
export const SDG_RUNNER_ARCHIVE_LIMIT = 2 * 1024 * 1024;
const metadataLimit = 8 * 1024 * 1024;

function nativeRead(route) {
  try {
    return execFileSync('gh', ['api', '--method', 'GET', `repos/${SDG_PAGES_REPOSITORY}/${route}`], {
      timeout: 30_000, maxBuffer: 64 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GH_TOKEN: process.env.GH_TOKEN || process.env.WOEK_NEWS_GITHUB_RUN_READ_TOKEN || '',
      },
    });
  } catch {
    throw Error('SDG_PAGES_NATIVE_READ_FAILED');
  }
}

async function publicRead(route) {
  const response = await fetch(new URL(route, officialSite), {
    redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'Cache-Control': 'no-cache' },
  });
  if (response.status !== 200) throw Error('SDG_PAGES_PUBLIC_READ_FAILED');
  return Buffer.from(await response.arrayBuffer());
}

export async function readSdgPublicNativeMetadata(route, fetchImpl = fetch) {
  if (typeof route !== 'string' || !metadataRoute.test(route)) throw Error('SDG_PAGES_NATIVE_ROUTE_INVALID');
  const response = await fetchImpl(`https://api.github.com/repos/${SDG_PAGES_REPOSITORY}/${route}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'woek-sdg-pages-verifier' },
  });
  if (response.status !== 200 || !response.body) throw Error('SDG_PAGES_NATIVE_READ_FAILED');
  const chunks = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > metadataLimit) throw Error('SDG_PAGES_NATIVE_METADATA_TOO_LARGE');
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}

class RunnerArchiveRequired extends Error {
  constructor(artifact) {
    super('SDG_PAGES_RUNNER_ARCHIVE_REQUIRED');
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '')) throw Error('SDG_PAGES_AUDIT_ARTIFACT_MISMATCH');
    this.artifactId = String(artifact.id);
    this.digest = artifact.digest.slice(7);
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privateEvidenceRoot(root, directory) {
  const requested = path.resolve(directory);
  const checkout = fs.realpathSync(root);
  if (within(checkout, requested)) throw Error('SDG_PAGES_EVIDENCE_INSIDE_CHECKOUT');
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  const resolved = fs.realpathSync(requested);
  if (within(checkout, resolved) || (fs.statSync(resolved).mode & 0o077)) {
    throw Error('SDG_PAGES_EVIDENCE_NOT_PRIVATE');
  }
  return resolved;
}

function save(directory, name, bytes) {
  fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600, flush: true });
}

// Keep incomplete raw snapshots for diagnosis. Only a checked snapshot is
// linked into the completed path and can be reused after a restart.
async function evidence(directory, name, capture, verify, { resumeMissing = false } = {}) {
  const checkpoint = path.join(directory, `${name}.json`);
  const snapshotPattern = new RegExp(`^${name}-[a-zA-Z0-9]{6}$`);
  const accept = () => {
    const bytes = fs.readFileSync(checkpoint);
    const { snapshot, files } = JSON.parse(bytes);
    if (!snapshotPattern.test(snapshot)) throw Error('SDG_PAGES_EVIDENCE_CHANGED');
    const source = path.join(directory, snapshot);
    if (fs.realpathSync(source) !== source) throw Error('SDG_PAGES_EVIDENCE_CHANGED');
    for (const [filename, digest] of Object.entries(files)) {
      if (!/^[a-z.]+$/.test(filename) ||
          sha256(fs.readFileSync(path.join(source, filename))) !== digest) throw Error('SDG_PAGES_EVIDENCE_CHANGED');
    }
    return { value: verify(source), evidenceHash: sha256(bytes) };
  };
  if (fs.existsSync(checkpoint)) return accept();
  const complete = (source, value) => {
    const names = fs.readdirSync(source).filter(file => file !== 'checkpoint.json').sort();
    const files = Object.fromEntries(names.map(file => [file, sha256(fs.readFileSync(path.join(source, file)))]));
    const bytes = JSON.stringify({ snapshot: path.basename(source), files }) + '\n';
    const pointer = path.join(source, 'checkpoint.json');
    try { save(source, 'checkpoint.json', bytes); }
    catch (error) {
      if (error.code !== 'EEXIST' || !fs.readFileSync(pointer).equals(Buffer.from(bytes))) throw error;
    }
    try { fs.linkSync(pointer, checkpoint); }
    catch (error) {
      if (error.code === 'EEXIST') return accept();
      throw error;
    }
    return { value, evidenceHash: sha256(bytes) };
  };
  let partial;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !snapshotPattern.test(entry.name)) continue;
    const source = path.join(directory, entry.name);
    let value;
    try { value = verify(source); }
    catch (error) {
      if (resumeMissing && error.code === 'ENOENT') partial ??= source;
      continue;
    }
    return complete(source, value);
  }
  const source = partial ?? fs.mkdtempSync(path.join(directory, `${name}-`));
  await capture(source);
  return complete(source, verify(source));
}

export async function confirmSdgPagesDelivery({
  root, ledger, editionId, expectedCommit, runId, runAttempt, evidenceDirectory, checkedCatalog,
}, {
  readNative = nativeRead, readPublic = publicRead, clock = () => new Date().toISOString(),
  readArchive = artifact => readNative(`actions/artifacts/${artifact.id}/zip`),
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? '') || typeof runId !== 'string' || !numbered.test(runId) ||
      typeof runAttempt !== 'string' || !numbered.test(runAttempt)) {
    throw Error('SDG_PAGES_EXPECTED_RUN_REQUIRED');
  }
  const release = (checkedCatalog ?? loadSdgTickerPresentation(root))?.releases.find(entry => entry.edition_id === editionId);
  if (!release) throw Error('SDG_PAGES_REGISTERED_EDITION_REQUIRED');
  const pack = packageSdgEdition(ledger, editionId);
  if (pack.sha256 !== release.sha256) throw Error('SDG_EDITION_DELIVERY_BINDING_MISMATCH');
  const existing = ledger.readDelivery(editionId);
  if (existing) {
    if (existing.edition_sha256 !== pack.sha256) throw Error('SDG_EDITION_DELIVERY_BINDING_MISMATCH');
    return { status: 'already_confirmed', receipt: existing };
  }

  const privateRoot = privateEvidenceRoot(root, evidenceDirectory);
  const directory = path.join(privateRoot, `${runId}-${runAttempt}-${expectedCommit}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory || (fs.statSync(directory).mode & 0o077)) {
    throw Error('SDG_PAGES_EVIDENCE_NOT_PRIVATE');
  }
  const runRoute = `actions/runs/${runId}`;
  const attemptRoute = `${runRoute}/attempts/${runAttempt}`;
  const read = (folder, name) => fs.readFileSync(path.join(folder, name));
  const getJson = (folder, name) => JSON.parse(read(folder, name));
  const captureNative = async (folder, name, route) => {
    if (!fs.existsSync(path.join(folder, name))) save(folder, name, await readNative(route));
  };
  const checkRun = run => {
    if (String(run.id) !== runId || String(run.run_attempt) !== runAttempt || run.status !== 'completed' ||
        run.repository?.full_name !== SDG_PAGES_REPOSITORY || run.path !== '.github/workflows/deploy.yml' ||
        run.head_branch !== 'main') throw Error('SDG_PAGES_COMPLETED_RUN_REQUIRED');
    return run;
  };
  const findArtifact = list => {
    if (!Array.isArray(list.artifacts) || list.total_count !== list.artifacts.length) {
      throw Error('SDG_PAGES_ARTIFACT_LIST_INCOMPLETE');
    }
    const candidates = list.artifacts.filter(item => item.name === `sdg-pages-release-${expectedCommit}-${runAttempt}`);
    if (candidates.length !== 1 || !numbered.test(String(candidates[0].id)) || candidates[0].expired !== false) {
      throw Error('SDG_PAGES_AUDIT_ARTIFACT_REQUIRED');
    }
    return candidates[0];
  };
  const native = await evidence(directory, 'native', async folder => {
    await captureNative(folder, 'run.json', attemptRoute);
    const run = checkRun(getJson(folder, 'run.json'));
    await captureNative(folder, 'jobs.json', `${attemptRoute}/jobs?per_page=100`);
    verifySdgCompletedPagesRun({ expectedCommit, run, jobs: getJson(folder, 'jobs.json') });
    await captureNative(folder, 'artifacts.json', `${runRoute}/artifacts?per_page=100`);
    const artifact = findArtifact(getJson(folder, 'artifacts.json'));
    if (!fs.existsSync(path.join(folder, 'audit.zip'))) {
      const bytes = Buffer.from(await readArchive(artifact));
      if (artifact.digest !== `sha256:${sha256(bytes)}`) throw Error('SDG_PAGES_AUDIT_ARTIFACT_MISMATCH');
      save(folder, 'audit.zip', bytes);
    }
  }, folder => inspectSdgPagesAudit({
    expectedCommit, run: checkRun(getJson(folder, 'run.json')), jobs: getJson(folder, 'jobs.json'),
    auditArtifact: findArtifact(getJson(folder, 'artifacts.json')), auditArchiveBytes: read(folder, 'audit.zip'),
  }), { resumeMissing: true });

  const audit = native.value;
  if (audit.release.editions.filter(entry => entry.edition_id === editionId &&
      entry.edition_sha256 === pack.sha256).length !== 1) throw Error('SDG_PAGES_REGISTERED_EDITION_MISMATCH');
  const publicManifest = await evidence(directory, 'public-manifest', async folder => {
    save(folder, 'manifest.json', await readPublic(SDG_PAGES_RELEASE_PATH));
  }, folder => {
    const bytes = read(folder, 'manifest.json');
    if (!audit.manifestBytes.equals(bytes)) throw Error('SDG_PAGES_RELEASE_BINDING_MISMATCH');
    return bytes;
  });
  const observed = await evidence(directory, `edition-${editionId}`, async folder => {
    const bytes = await readPublic(`wirkungsticker/sdg/ausgabe/${editionId}/`);
    const observedAt = clock();
    save(folder, 'edition.html', bytes);
    save(folder, 'observed.json', JSON.stringify({ observed_at: observedAt }));
  }, folder => verifySdgPublicDelivery({
    audit, editionId, editionSha256: pack.sha256, publicManifestBytes: publicManifest.value,
    publicEditionBytes: read(folder, 'edition.html'), observedAt: getJson(folder, 'observed.json').observed_at,
  }));
  return ledger.recordVerifiedDelivery({
    ...observed.value, evidence: {
      native_sha256: native.evidenceHash, manifest_sha256: publicManifest.evidenceHash, edition_sha256: observed.evidenceHash,
    },
  }, pack.manifest.ledger_sha256);
}

// Called by the normal writer on its next wake, using the bound catalog
// already present in its checkout. A current public manifest identifies the
// concrete run to verify, even if the dispatch response was lost.
export async function reconcileSdgPagesDelivery({
  root, ledger, committed, evidenceDirectory, manifestObservation,
}, { readNative = nativeRead, readArchive, readPublic = publicRead, clock = () => new Date().toISOString() } = {}) {
  const catalog = readSdgReleaseCatalog(root);
  const last = catalog.releases.findIndex(entry =>
    entry.edition_id === committed?.edition_id && entry.sha256 === committed?.sha256);
  if (last < 0) throw Error('SDG_BRIDGE_CATALOG_PREFIX_MISMATCH');
  const pending = catalog.releases.slice(0, last + 1).filter(entry => !ledger.readDelivery(entry.edition_id));
  if (!pending.length) return { status: 'current' };

  const directory = privateEvidenceRoot(root, evidenceDirectory);
  let observation, manifestBytes;
  if (manifestObservation !== undefined) {
    if (typeof manifestObservation !== 'string' || !observationName.test(manifestObservation)) {
      throw Error('SDG_PAGES_OBSERVATION_INVALID');
    }
    observation = path.join(directory, manifestObservation);
    if (fs.realpathSync(observation) !== observation || (fs.statSync(observation).mode & 0o077)) {
      throw Error('SDG_PAGES_EVIDENCE_NOT_PRIVATE');
    }
    manifestBytes = fs.readFileSync(path.join(observation, 'manifest.json'));
  } else {
    manifestBytes = await readPublic(SDG_PAGES_RELEASE_PATH);
    observation = fs.mkdtempSync(path.join(directory, 'discovery-'));
    save(observation, 'manifest.json', manifestBytes);
  }
  const manifest = JSON.parse(manifestBytes);
  if (manifest?.kind !== 'sdg_pages_release' || manifest.repository !== SDG_PAGES_REPOSITORY ||
      manifest.schema_version !== 1 || !Array.isArray(manifest.editions)) {
    throw Error('SDG_PAGES_RELEASE_BINDING_MISMATCH');
  }
  const target = pending.find(entry => manifest.editions.some(edition =>
    edition.edition_id === entry.edition_id && edition.edition_sha256 === entry.sha256));
  if (!target) return { status: 'awaiting_delivery' };
  try {
    const confirmation = await confirmSdgPagesDelivery({
      root, ledger, editionId: target.edition_id, expectedCommit: manifest.source_commit,
      runId: manifest.run_id, runAttempt: manifest.run_attempt, evidenceDirectory, checkedCatalog: catalog,
    }, {
      readNative, readArchive, clock,
      readPublic: route => route === SDG_PAGES_RELEASE_PATH ? manifestBytes : readPublic(route),
    });
    return { status: confirmation.status, edition_id: target.edition_id };
  } catch (error) {
    if (!(error instanceof RunnerArchiveRequired)) throw error;
    return { status: 'archive_required', artifact_id: error.artifactId, artifact_sha256: error.digest,
      manifest_observation: path.basename(observation) };
  }
}

// Oracle reads the native JSON and checks the downloaded ZIP against its
// digest. No Actions credential or signed archive URL crosses the bridge.
export async function reconcileRunnerSdgPagesDelivery(options, upload, {
  readNative = readSdgPublicNativeMetadata, readPublic, clock,
} = {}) {
  let bytes;
  if (upload !== undefined) {
    if (typeof upload?.artifact_id !== 'string' || !numbered.test(upload.artifact_id) ||
        typeof upload.manifest_observation !== 'string' || !observationName.test(upload.manifest_observation) ||
        typeof upload.archive_base64 !== 'string' ||
        upload.archive_base64.length > Math.ceil(SDG_RUNNER_ARCHIVE_LIMIT / 3) * 4) {
      throw Error('SDG_PAGES_RUNNER_ARCHIVE_INVALID');
    }
    bytes = Buffer.from(upload.archive_base64, 'base64');
    if (!bytes.length || bytes.length > SDG_RUNNER_ARCHIVE_LIMIT || bytes.toString('base64') !== upload.archive_base64) {
      throw Error('SDG_PAGES_RUNNER_ARCHIVE_INVALID');
    }
  }
  return reconcileSdgPagesDelivery({ ...options, manifestObservation: upload?.manifest_observation }, {
    readNative, readPublic, clock,
    readArchive(artifact) {
      if (!bytes) throw new RunnerArchiveRequired(artifact);
      if (upload.artifact_id !== String(artifact.id)) throw Error('SDG_PAGES_RUNNER_ARCHIVE_INVALID');
      return bytes;
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fields = ['edition-db', 'edition-id', 'source-commit', 'run-id', 'run-attempt', 'evidence-dir'];
  const values = fields.map(name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3));
  if (values.some(value => !value)) throw Error('SDG_PAGES_DELIVERY_ARGUMENTS_REQUIRED');
  const [database, editionId, expectedCommit, runId, runAttempt, evidenceDirectory] = values;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const db = fs.realpathSync(database);
  if (within(fs.realpathSync(root), db) || !fs.statSync(db).isFile() || (fs.statSync(db).mode & 0o077)) {
    throw Error('SDG_PAGES_PRIVATE_LEDGER_REQUIRED');
  }
  const ledger = new EditionLedger(db);
  try {
    console.log(JSON.stringify(await confirmSdgPagesDelivery({
      root, ledger, editionId, expectedCommit, runId, runAttempt, evidenceDirectory,
    })));
  } finally { ledger.close(); }
}
