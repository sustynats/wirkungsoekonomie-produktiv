import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EditionLedger } from '../../scripts/news/sdg/editions.mjs';

test('all 1,000 prepared revisions and their dossiers survive reopening the edition store', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'woek-sdg-editions-'));
  const file = path.join(directory, 'editions.sqlite');
  const cutoff = '2026-11-24T05:00:00.000Z';
  const settings = { date: '2026-11-24', slot: 'morgenlage', cutoff, sealedAt: '2026-11-24T05:03:00.000Z' };
  const items = Array.from({ length: 1000 }, (_, n) => ({
    id: n.toString(16).padStart(64, '0'),
    analysisHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    readyAt: cutoff,
    dossier: { revision: n, synthetic_fixture: true },
  }));
  let store = new EditionLedger(file);
  try {
    store.recordReady(items);
    const edition = store.stage(settings);
    assert.equal(edition.items.length, items.length);
    store.close();
    store = new EditionLedger(file);
    assert.deepEqual(store.stage(settings), edition);
    for (const [i, item] of edition.items.entries()) {
      assert.deepEqual(store.readDossier(item.id), { dossierHash: item.dossier_hash, dossier: items[i].dossier });
    }
    assert.throws(() => store.recordReady([{ ...items[0], dossier: { changed: true } }]), /Qualified item revision changed/);
    assert.equal(edition.publication_at, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('scheduled editions catch up in Berlin order across the clock change and retain pending records', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'woek-sdg-scheduled-'));
  const file = path.join(directory, 'editions.sqlite');
  const startAt = '2026-10-24T16:00:00.000Z';
  const checkedThrough = '2026-10-25T11:00:00.000Z';
  const sealedAt = '2026-10-26T06:15:00.000Z';
  const ready = (id, readyAt) => ({ id, readyAt, analysisHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64), dossier: { synthetic_fixture: id } });
  let store = new EditionLedger(file);
  try {
    store.recordReady([
      ready('older-backlog', '2026-10-18T06:00:00.000Z'),
      ready('before-morning', '2026-10-25T04:59:59.999Z'),
      ready('after-morning', '2026-10-25T05:00:00.001Z'),
      ready('will-be-evening', '2026-10-25T16:59:59.999Z'),
    ]);
    assert.throws(() => store.stageDue({ startAt, checkedThrough, sealedAt: startAt }), /CHECK_AFTER_SEALING/);
    const initial = store.stageDue({ startAt, checkedThrough, sealedAt });
    assert.deepEqual(initial.map(row => row.id), ['2026-10-24-abendlage', '2026-10-25-morgenlage', '2026-10-25-mittagslage']);
    assert.equal(store.read(initial[0].id).scheduled_at, startAt);
    assert.equal(store.read(initial[1].id).scheduled_at, '2026-10-25T05:00:00.000Z');
    assert.deepEqual(initial.map(({ id }) => store.read(id).items.map(item => item.id)),
      [['older-backlog'], ['before-morning'], ['after-morning']]);
    assert.equal(store.read('2026-10-25-abendlage'), null);

    store.close();
    store = new EditionLedger(file);
    assert.deepEqual(store.stageDue({ startAt, checkedThrough, sealedAt: '2026-10-27T10:00:00.000Z' }), initial);
    assert.throws(() => store.stageDue({ startAt: checkedThrough, checkedThrough, sealedAt }), /SCHEDULE_START_CHANGED/);
    assert.throws(() => store.stageDue({ startAt, checkedThrough: startAt, sealedAt }), /CHECK_BEHIND_CURSOR/);
    store.recordReady([ready('recovered-handoff', '2026-10-25T04:58:00.000Z')]);
    const resumed = store.stageDue({ startAt, checkedThrough: '2026-10-26T05:00:00.000Z', sealedAt });
    assert.deepEqual(resumed.slice(0, 3), initial);
    const evening = store.read('2026-10-25-abendlage');
    assert.equal(evening.scheduled_at, '2026-10-25T17:00:00.000Z');
    assert.equal(evening.sealed_at, sealedAt);
    assert.deepEqual(evening.items.map(item => item.id), ['recovered-handoff', 'will-be-evening']);
    assert.equal(evening.publication_at, null);
    assert.deepEqual(store.read('2026-10-26-morgenlage').items, []);
    assert.equal(store.read('2026-10-26-mittagslage'), null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
