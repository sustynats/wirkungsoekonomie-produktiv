import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hash } from '../../scripts/news/bridge/contract.mjs';
import { dispatchSdgPagesRelease } from '../../scripts/news/sdg/dispatch-pages.mjs';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';
import { writeSdgEditionCandidate } from '../../scripts/news/sdg/package-edition.mjs';

const morning = { date: '2026-11-24', slot: 'morgenlage', cutoff: '2026-11-24T05:00:00.000Z', sealedAt: '2026-11-24T05:05:00.000Z' };
const lunch = { date: morning.date, slot: 'mittagslage', cutoff: '2026-11-24T11:00:00.000Z', sealedAt: '2026-11-24T11:05:00.000Z' };

function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-sdg-dispatch-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  const database = path.join(scratch, 'editions.sqlite');
  const ledger = new EditionLedger(database);
  const editions = [ledger.stage(morning), ledger.stage(lunch)];
  ledger.close();
  const data = path.join(root, 'data/news/sdg');
  const releases = editions.map(edition => {
    const manifest = {
      schema_version: 1, kind: 'sdg_edition_candidate', edition_id: edition.id,
      ledger_sha256: edition.hash, scheduled_at: edition.scheduled_at, cutoff_at: edition.cutoff,
      sealed_at: edition.sealed_at, published_at: null, items: [{ synthetic_dispatch_fixture: true }],
    };
    const pack = { manifest, sha256: hash(manifest) };
    writeSdgEditionCandidate(path.join(data, 'editions'), pack);
    return { edition_id: edition.id, sha256: pack.sha256 };
  });
  const catalog = Buffer.from(JSON.stringify({ schema_version: 1, releases }));
  const catalogHash = createHash('sha256').update(catalog).digest('hex');
  const catalogFile = path.join(data, 'release-catalog.json');
  fs.writeFileSync(catalogFile, catalog);
  fs.writeFileSync(path.join(data, 'ticker-mode.json'), JSON.stringify({ schema_version: 1, mode: 'sdg', anchor: releases[0] }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com',
    'commit', '-qm', '[wirkungsticker] fixture', '-m', `WOEK-SDG-Catalog: ${catalogHash}`);
  const head = git('rev-parse', 'HEAD').toString().trim();
  const runGit = args => args[0] === 'ls-remote' ? Buffer.from(`${head}\trefs/heads/main\n`) : git(...args);
  return { root, database, releases, catalogFile, catalogHash, head, git, runGit };
}

test('a committed SDG catalog survives a lost runner before dispatch and never replays an ambiguous POST', async t => {
  const setup = fixture(t);
  const { root, runGit, database, releases, catalogHash, head } = setup;
  let sends = 0;
  const options = {
    root, runGit,
    withReservation(committed, sourceCommit) {
      assert.deepEqual(committed, { ...releases[1], catalog_sha256: catalogHash });
      assert.equal(sourceCommit, head);
      const ledger = new EditionLedger(database);
      try {
        return ledger.reservePagesDispatch({ editionId: committed.edition_id, editionHash: committed.sha256,
          catalogHash: committed.catalog_sha256, sourceCommit, runOwner: '42:1', reservedAt: '2026-11-24T11:10:00.000Z' });
      } finally { ledger.close(); }
    },
    send(sourceCommit, expectedCatalogHash) {
      assert.equal(sourceCommit, head);
      assert.equal(expectedCatalogHash, catalogHash);
      sends += 1;
      throw Error('Fixture response lost');
    },
  };
  await assert.rejects(dispatchSdgPagesRelease(options), /response lost/);
  assert.deepEqual(await dispatchSdgPagesRelease(options), { status: 'dispatch_held' });
  assert.equal(sends, 1);
});

test('a moved main, altered catalog or later editorial commit never reserves the old automatic dispatch', async t => {
  const { root, runGit, git, catalogFile } = fixture(t);
  const options = { root, runGit, withReservation: () => assert.fail('No reserve allowed'),
    send: () => assert.fail('No send allowed') };
  assert.deepEqual(await dispatchSdgPagesRelease({ ...options, runGit: args =>
    args[0] === 'ls-remote' ? Buffer.from(`${'f'.repeat(40)}\trefs/heads/main\n`) : runGit(args) }), { status: 'main_moved' });
  fs.appendFileSync(catalogFile, '\n');
  await assert.rejects(dispatchSdgPagesRelease(options), /SDG_PAGES_DISPATCH_BINDING_REQUIRED/);
  git('restore', '--', 'data/news/sdg/release-catalog.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com',
    'commit', '--allow-empty', '-qm', '[wirkungsticker] editor release');
  assert.deepEqual(await dispatchSdgPagesRelease(options), { status: 'no_committed_sdg_dispatch' });
});

test('the existing Pages workflow rejects a stale automatic source before building or deploying', t => {
  const yaml = fs.readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const script = name => {
    const step = yaml.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
    const shell = step?.split('        run: |\n')[1];
    assert.ok(shell);
    return shell;
  };
  const gate = script('Validate requested ticker commit');
  const commit = 'a'.repeat(40);
  const moved = 'b'.repeat(40);
  const env = { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', TICKER_ONLY: 'true',
    TICKER_COMMIT: commit, GITHUB_SHA: moved, SDG_CATALOG_SHA256: 'c'.repeat(64) };
  const execute = (body, overrides) => spawnSync('bash', ['-c', body], {
    env: { ...env, ...overrides }, encoding: 'utf8',
  });
  assert.equal(execute(gate, {}).status, 1);
  assert.equal(execute(gate, { GITHUB_SHA: commit }).status, 0);
  assert.equal(execute(gate, { SDG_CATALOG_SHA256: '' }).status, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woek-sdg-deploy-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$FIXTURE_MAIN"\n', { mode: 0o700 });
  const reachDeploy = expected => execute(script('Refuse a stale automatic SDG deployment'), {
    RELEASE_COMMIT: commit, FIXTURE_MAIN: expected, PATH: dir + path.delimiter + process.env.PATH,
    GITHUB_REPOSITORY: 'sustynats/wirkungsoekonomie-produktiv',
  }).status;
  assert.equal(reachDeploy(moved), 1);
  assert.equal(reachDeploy(commit), 0);
});
