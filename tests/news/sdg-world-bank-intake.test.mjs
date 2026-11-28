import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadNewsRegistry } from '../../scripts/news/registry.mjs';
import { MeasureRevisions, measureId } from '../../scripts/news/sdg/measure-revisions.mjs';
import { collectWorldBankApprovals } from '../../scripts/news/sdg/world-bank-intake.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../../content/news/sdg-source-registry.json', import.meta.url)));
const [source] = config.sources;
const approval = (name = 'Renewable Energy Technical Assistance') => ({
  id: 'P511160', proj_id: 'P511160', project_name: name, status: 'Active', countrycode: ['ZW'],
  boardapprovaldate: '2026-11-26T00:00:00Z', closingdate: '2027-06-30',
  project_abstract: 'Additional unverified source material',
});

function fixture(t) {
  const privateRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-approvals-')));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const file = path.join(privateRoot, 'measures.sqlite');
  fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const ledger = new MeasureRevisions(file);
  ledger.close();
  return { privateRoot, source, file, wait: async () => {} };
}

function response(url, projects, total = projects.length) {
  const offset = Number(new URL(url).searchParams.get('os'));
  return Response.json({ total: String(total), os: String(offset), page: String(offset / 100 + 1),
    projects: Object.fromEntries(projects.map(project => [project.id, project])) });
}

test('the reviewed source is additive and excluded from the general news collector', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const registry = loadNewsRegistry(root);
  const entries = registry.sources.filter(item => item.source_id === source.source_id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, 'D');
  assert.equal(entries[0].enabled, false);
  assert.equal(entries[0].sdg_intake.active, true);
});

test('the service invokes the collector through the versioned release symlink', t => {
  const { privateRoot } = fixture(t);
  const release = fileURLToPath(new URL('../../scripts/news/sdg/', import.meta.url));
  const current = path.join(privateRoot, 'current');
  fs.symlinkSync(release, current, 'dir');
  const invocation = spawnSync(process.execPath, [path.join(current, 'world-bank-intake.mjs')], { encoding: 'utf8' });
  assert.equal(invocation.status, 1);
  assert.match(invocation.stderr, /SDG_PROJECT_ROOT_REQUIRED/);
});

test('a verified approval is ingested once and a metadata change becomes a separate revision', async t => {
  const options = fixture(t);
  let row = approval();
  const fetcher = async url => {
    if (url === source.sdg_intake.robots_url) return new Response('', { status: 404 });
    const query = new URL(url).searchParams;
    assert.equal(query.get('strdate'), '2026-11-20');
    assert.equal(query.get('status_exact'), 'Active');
    return response(url, [row]);
  };
  const first = await collectWorldBankApprovals({ ...options, fetcher, now: new Date('2026-11-28T08:00:00Z') });
  const replay = await collectWorldBankApprovals({ ...options, fetcher, now: new Date('2026-11-29T08:00:00Z') });
  row = approval('Renewable Procurement Technical Assistance');
  const updated = await collectWorldBankApprovals({ ...options, fetcher, now: new Date('2026-11-30T08:00:00Z') });
  assert.equal(first.observations, 1);
  assert.equal(first.new_revisions, 1);
  assert.equal(replay.new_revisions, 0);
  assert.equal(replay.new_evidence_links, 0);
  assert.equal(updated.new_revisions, 1);
  const ledger = new MeasureRevisions(options.file);
  try {
    const versions = ledger.timeline(measureId({ authority: source.source_id, reference: 'P511160' }));
    assert.equal(versions.length, 2);
    assert.equal(versions[1].supersedes, versions[0].revision_id);
    assert.equal(versions[0].sources[0].original_published_at, null);
    assert.equal(versions[0].event_at, '2026-11-26');
    assert.equal(versions[0].domain, 'finance');
    assert.equal(versions[0].stage, 'approved');
    assert.ok(!Object.hasOwn(versions[0].value, 'project_abstract'));
    assert.match(versions[0].sources[0].url, /\/P511160$/);
  } finally { ledger.close(); }
});

test('the collector saves private evidence and fails closed on an incomplete source snapshot', async t => {
  const options = fixture(t);
  const fetcher = async url => {
    if (url === source.sdg_intake.robots_url) return new Response('', { status: 200 });
    return response(url, [approval()], 2);
  };
  await assert.rejects(collectWorldBankApprovals({ ...options, fetcher, now: new Date('2026-11-28T08:00:00Z') }),
    /SDG_PROJECT_PAGE_INCOMPLETE/);
  const directory = path.join(options.privateRoot, 'intake', source.source_id);
  assert.equal(fs.existsSync(path.join(directory, 'last-completed.json')), false);
  const [snapshot] = fs.readdirSync(directory);
  assert.ok(fs.existsSync(path.join(directory, snapshot, 'page-0.raw')));
  const ledger = new MeasureRevisions(options.file);
  try { assert.equal(ledger.db.prepare('SELECT count(*) AS count FROM measures').get().count, 0); }
  finally { ledger.close(); }
});

test('declared robots rules prevent the project request', async t => {
  const options = fixture(t);
  const fetcher = async url => {
    assert.equal(url, source.sdg_intake.robots_url);
    return new Response('User-agent: *\nDisallow: /api/v3/projects\n');
  };
  await assert.rejects(collectWorldBankApprovals({ ...options, fetcher, now: new Date('2026-11-28T08:00:00Z') }),
    /SDG_PROJECT_ROBOTS_DISALLOWED/);
});
