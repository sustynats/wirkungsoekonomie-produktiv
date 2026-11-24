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
