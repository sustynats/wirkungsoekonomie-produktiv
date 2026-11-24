import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRepositoryJson } from '../newsroom-store.mjs';
import { loadSdgTickerPresentation, SDG_HASH } from './release-catalog.mjs';

export const SDG_PAGES_REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';
const sourceHash = /^[a-f0-9]{40}$/;
const runNumber = /^[1-9]\d{0,19}$/;
export const SDG_PAGES_RELEASE_PATH = 'wirkungsticker/sdg/release.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeSdgPagesRelease({ root, artifactRoot, sourceCommit, runId, runAttempt }) {
  const catalog = loadSdgTickerPresentation(root);
  const file = path.join(artifactRoot, SDG_PAGES_RELEASE_PATH);
  if (!catalog) {
    if (fs.existsSync(file)) throw Error('SDG_PAGES_RELEASE_STALE');
    return null;
  }
  if (!sourceHash.test(sourceCommit ?? '') || typeof runId !== 'string' || !runNumber.test(runId) ||
      typeof runAttempt !== 'string' || !runNumber.test(runAttempt)) {
    throw Error('SDG_PAGES_RELEASE_SOURCE_REQUIRED');
  }
  const editions = catalog.releases.map(({ edition_id: id, sha256: editionHash }) => {
    const filename = path.join(artifactRoot, 'wirkungsticker/sdg/ausgabe', id, 'index.html');
    const html = fs.readFileSync(filename);
    const main = (html.toString('utf8').match(/<main\b[^>]*>/gi) ?? []).filter(tag => tag.includes(' id="main-content"'));
    if (main.length !== 1 || !main[0].includes(` data-sdg-edition-sha256="${editionHash}"`)) {
      throw Error('SDG_PAGES_EDITION_BINDING_MISMATCH');
    }
    return { edition_id: id, edition_sha256: editionHash, html_sha256: sha256(html) };
  });
  const manifest = {
    schema_version: 1,
    kind: 'sdg_pages_release',
    repository: SDG_PAGES_REPOSITORY,
    source_commit: sourceCommit,
    run_id: runId,
    run_attempt: runAttempt,
    catalog_sha256: catalog.sha256,
    editions,
  };
  if (fs.existsSync(file)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(manifest)) {
      throw Error('SDG_PAGES_RELEASE_STALE');
    }
  } else {
    writeRepositoryJson(file, manifest);
  }
  return manifest;
}

export function verifySdgCompletedPagesRun({ expectedCommit, run, jobs }) {
  if (run?.repository?.full_name !== SDG_PAGES_REPOSITORY || run.path !== '.github/workflows/deploy.yml' ||
      run.head_branch !== 'main' || run.status !== 'completed' || !sourceHash.test(run.head_sha ?? '') ||
      !['push', 'workflow_dispatch'].includes(run.event) || (run.event === 'push' && run.head_sha !== expectedCommit) ||
      !runNumber.test(String(run.id)) || !runNumber.test(String(run.run_attempt)) ||
      !Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length) {
    throw Error('SDG_PAGES_RUN_MISMATCH');
  }
  const build = jobs.jobs.filter(job => job.name === 'build');
  const deploy = jobs.jobs.filter(job => job.name === 'deploy');
  if (build.length !== 1 || deploy.length !== 1 ||
      [build[0], deploy[0]].some(job => String(job.run_id) !== String(run.id) ||
        job.status !== 'completed' || job.conclusion !== 'success')) {
    throw Error('SDG_PAGES_DELIVERY_NOT_SUCCESSFUL');
  }
  return { build: build[0], deploy: deploy[0] };
}

export function inspectSdgPagesAudit({ expectedCommit, run, jobs, auditArtifact, auditArchiveBytes }) {
  const { build, deploy } = verifySdgCompletedPagesRun({ expectedCommit, run, jobs });
  const auditTime = Date.parse(auditArtifact?.created_at);
  const archiveHash = sha256(auditArchiveBytes);
  if (auditArtifact?.name !== `sdg-pages-release-${expectedCommit}-${run.run_attempt}` || auditArtifact.expired !== false ||
      String(auditArtifact.workflow_run?.id) !== String(run.id) || auditArtifact.workflow_run?.head_sha !== run.head_sha ||
      auditArtifact.digest !== `sha256:${archiveHash}` ||
      ![auditTime, Date.parse(build.started_at), Date.parse(build.completed_at)].every(Number.isFinite) ||
      auditTime < Date.parse(build.started_at) || auditTime > Date.parse(build.completed_at)) {
    throw Error('SDG_PAGES_AUDIT_ARTIFACT_MISMATCH');
  }
  const auditManifestBytes = execFileSync('python3', ['-c', `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = [entry for entry in archive.infolist() if entry.filename == sys.argv[1]]
    if len(entries) != 1:
        raise ValueError("SDG_PAGES_AUDIT_MANIFEST_REQUIRED")
    sys.stdout.buffer.write(archive.read(entries[0]))
`, path.basename(SDG_PAGES_RELEASE_PATH)], { input: auditArchiveBytes, maxBuffer: 32 * 1024 ** 2 });
  const release = JSON.parse(auditManifestBytes);
  if (!sourceHash.test(expectedCommit ?? '') || release.source_commit !== expectedCommit ||
      release.repository !== SDG_PAGES_REPOSITORY || release.kind !== 'sdg_pages_release' || release.schema_version !== 1 ||
      !SDG_HASH.test(release.catalog_sha256 ?? '') || !Array.isArray(release.editions) ||
      release.run_id !== String(run.id) || release.run_attempt !== String(run.run_attempt)) {
    throw Error('SDG_PAGES_RELEASE_BINDING_MISMATCH');
  }
  const deployedAt = Date.parse(deploy.completed_at);
  if (!Number.isFinite(deployedAt) || deployedAt < Date.parse(build.completed_at)) {
    throw Error('SDG_PAGES_OBSERVATION_TIME_INVALID');
  }
  return { manifestBytes: auditManifestBytes, release, archiveHash, deployedAt };
}

export function verifySdgPublicDelivery({
  audit, editionId, editionSha256, publicManifestBytes, publicEditionBytes, observedAt,
}) {
  const { manifestBytes, release, archiveHash, deployedAt } = audit;
  if (!manifestBytes.equals(Buffer.from(publicManifestBytes))) throw Error('SDG_PAGES_RELEASE_BINDING_MISMATCH');
  const matching = release.editions.filter(entry => entry.edition_id === editionId);
  if (matching.length !== 1 || !SDG_HASH.test(editionSha256 ?? '') || matching[0].edition_sha256 !== editionSha256 ||
      matching[0].html_sha256 !== sha256(publicEditionBytes)) {
    throw Error('SDG_PAGES_PUBLIC_EDITION_MISMATCH');
  }
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed < deployedAt || new Date(observed).toISOString() !== observedAt) {
    throw Error('SDG_PAGES_OBSERVATION_TIME_INVALID');
  }
  return {
    edition_id: editionId,
    edition_sha256: editionSha256,
    source_commit: release.source_commit,
    run_id: release.run_id,
    run_attempt: release.run_attempt,
    audit_artifact_sha256: archiveHash,
    edition_html_sha256: matching[0].html_sha256,
    deployment_job_completed_at: new Date(deployedAt).toISOString(),
    observed_at: observedAt,
  };
}

// Native authenticated evidence and public first-party observations remain separate.
export function verifySdgPagesDelivery(evidence) {
  return verifySdgPublicDelivery({ ...evidence, audit: inspectSdgPagesAudit(evidence) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (process.env.GITHUB_REPOSITORY !== SDG_PAGES_REPOSITORY || process.env.RELEASE_COMMIT !== sourceCommit) {
    throw Error('SDG_PAGES_RELEASE_CHECKOUT_MISMATCH');
  }
  const release = writeSdgPagesRelease({
    root, artifactRoot: path.join(root, '_site'), sourceCommit,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `active=${release !== null}\n`);
  console.log(release ? `SDG Pages release bound to ${sourceCommit}: ${release.editions.length} editions` : 'SDG Pages release inactive');
}
