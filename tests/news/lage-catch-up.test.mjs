import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildLage, dueLage, dueLagen, upsertLage } from '../../scripts/news/lage.mjs';
import { checkDueLagen, schreibeLage } from '../../scripts/news/lage-schreiben.mjs';

const now = '2026-11-09T18:20:00.000Z'; // 19:20 Berlin; all three windows are due.
const ids = ['morgenlage', 'mittagslage', 'abendlage'];
const story = (id, published) => ({ story_id: id, slug: id, title: id,
  published: true, analysis: {}, published_at: published, last_updated: published });
const stories = [story('morning', '2026-11-09T04:00:00Z'),
  story('noon', '2026-11-09T09:00:00Z'), story('evening', '2026-11-09T15:00:00Z')];
const edition = (slot, at = now, extra = {}) => ({ ...buildLage({ slot, now: at, stories }), ...extra });
const storeOf = (lagen) => ({ schema_version: '1.0', updated_at: lagen[0]?.stand || null, lagen });
const jsonFile = (root, name, value) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
};
function fixture(t, lagen = [], catalog = stories) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lage-catch-up-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  jsonFile(root, 'data/news/lagen.json', storeOf(lagen));
  if (catalog !== null) jsonFile(root, 'data/news/stories.json', { stories: catalog });
  return root;
}
const readStore = (root) => JSON.parse(fs.readFileSync(path.join(root, 'data/news/lagen.json'), 'utf8'));
function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  walk(root);
  return result;
}

test('fällige Slots folgen Berliner Grenzen einschließlich beider Zeitumstellungen', () => {
  for (const [day, start] of [['2026-03-29', 4], ['2026-10-25', 5]]) {
    const stamp = (hour, minute = '00') => `${day}T${String(hour).padStart(2, '0')}:${minute}:00Z`;
    assert.deepEqual(dueLagen(stamp(start - 1, '59')), []);
    assert.deepEqual(dueLagen(stamp(start)), ['morgenlage']);
    assert.deepEqual(dueLagen(stamp(start + 6)), ['morgenlage', 'mittagslage']);
    assert.deepEqual(dueLagen(stamp(start + 12)), ids);
    assert.equal(dueLage(stamp(start + 6)), 'mittagslage');
  }
  assert.deepEqual(dueLagen('invalid'), []);
});

test('check-due liest ausschließlich die lokale Lagenablage', (t) => {
  const root = fixture(t, [edition('morgenlage')], null);
  const before = snapshot(root);
  const result = checkDueLagen({ root, now });
  assert.equal(result.status, 'ok');
  assert.equal(result.date, '2026-11-09');
  assert.equal(result.current_slot, 'abendlage');
  assert.deepEqual(result.due_slots, ids);
  assert.deepEqual(result.missing_slots, ['mittagslage', 'abendlage']);
  assert.deepEqual(result.missing_lage_ids, ['2026-11-09-mittagslage', '2026-11-09-abendlage']);
  assert.equal(result.publication_needed, true);
  assert.deepEqual(snapshot(root), before);
});

test('defekte oder doppelte Ablage ist kein Auftrag zu neuen Ausgaben', (t) => {
  const root = fixture(t, [], null);
  for (const value of [{ lagen: {} }, { lagen: [edition('morgenlage'), edition('morgenlage')] }]) {
    jsonFile(root, 'data/news/lagen.json', value);
    assert.throws(() => checkDueLagen({ root, now }), /LAGE_STORE_INVALID/);
  }
  jsonFile(root, 'data/news/lagen.json', storeOf([]));
  assert.equal(checkDueLagen({ root, now: 'invalid' }).status, 'fenster_unlesbar');
});

test('normaler Lauf ergänzt Lücken und aktualisiert nur die aktuelle Ausgabe', (t) => {
  const old = edition('abendlage', '2026-08-01T20:00:00Z', { custom: 'historisch unverändert' });
  const morning = edition('morgenlage', now, { headline: 'Persönlich erhalten', custom: 'erhalten' });
  const current = edition('abendlage', now, { entries: [], counts: { total: 0, neu: 0, fortgeschrieben: 0 } });
  const root = fixture(t, [current, morning, old]);
  const result = schreibeLage({ root, now });
  assert.deepEqual(result.geschrieben.map((e) => e.slot), ['mittagslage', 'abendlage']);
  assert.equal(result.changed, true);
  assert.equal(result.gespeichert, true);
  const store = readStore(root);
  assert.equal(store.lagen.length, 4);
  assert.deepEqual(store.lagen.find((e) => e.lage_id === morning.lage_id), morning);
  assert.deepEqual(store.lagen.find((e) => e.lage_id === old.lage_id), old);
  assert.equal(store.lagen[0].counts.total, 1);
  const noon = store.lagen.find((e) => e.slot === 'mittagslage');
  assert.equal(noon.window_to, '2026-11-09T11:00:00.000Z');
  assert.equal(noon.publication_recovery.recovered_at, now);
  assert.match(noon.publication_recovery.note, /nachträglich.*zusammengestellt/);
  assert.equal(store.updated_at, current.stand);
});

test('noch aktuelle verspätete Erstausgabe trägt ebenfalls einen transparenten Hinweis', (t) => {
  const root = fixture(t, [edition('morgenlage')]);
  const result = schreibeLage({ root, now: '2026-11-09T15:40:00Z' });
  assert.deepEqual(result.geschrieben.map((e) => e.slot), ['mittagslage']);
  assert.equal(result.geschrieben[0].recovered, true);
  assert.equal(readStore(root).lagen[0].publication_recovery.recovered_at, '2026-11-09T15:40:00.000Z');
  assert.ok(!readStore(root).lagen.some((e) => e.slot === 'abendlage'));
});

test('aktuelle Ausgabe hat60Minuten Hinweis-Toleranz, frühere fehlende Ausgabe nie', (t) => {
  for (const [at, recovered] of [['2026-11-09T05:04:00Z', false],
    ['2026-11-09T06:00:00Z', false], ['2026-11-09T06:00:00.001Z', true]]) {
    const root = fixture(t);
    const result = schreibeLage({ root, now: at, missingOnly: true });
    assert.equal(result.geschrieben[0].recovered, recovered);
    assert.equal(Boolean(readStore(root).lagen[0].publication_recovery), recovered);
  }
  const root = fixture(t);
  const result = schreibeLage({ root, now: '2026-11-09T11:04:00Z', missingOnly: true });
  assert.deepEqual(result.geschrieben.map((e) => [e.slot, e.recovered]),
    [['morgenlage', true], ['mittagslage', false]]);
});

test('missing-only ergänzt alle fehlenden Slots und lässt vorhandene aktuelle Ausgabe unverändert', (t) => {
  const current = edition('abendlage', now, { headline: 'Bereits veröffentlichte Fassung', entries: [] });
  const root = fixture(t, [current]);
  const result = schreibeLage({ root, now, missingOnly: true });
  assert.deepEqual(result.geschrieben.map((e) => e.slot), ['morgenlage', 'mittagslage']);
  assert.deepEqual(readStore(root).lagen.find((e) => e.lage_id === current.lage_id), current);
  assert.equal(readStore(root).updated_at, current.stand);
  const before = snapshot(root);
  fs.unlinkSync(path.join(root, 'data/news/stories.json'));
  delete before['data/news/stories.json'];
  const repeated = schreibeLage({ root, now, missingOnly: true });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.gespeichert, false);
  assert.deepEqual(repeated.geschrieben, []);
  assert.deepEqual(snapshot(root), before);
});

test('wiederholter normaler Lauf ist bytegleich und behält den ersten Nachlieferungsvermerk', (t) => {
  const root = fixture(t);
  const first = schreibeLage({ root, now });
  assert.equal(first.geschrieben.length, 3);
  const before = snapshot(root);
  const second = schreibeLage({ root, now: '2026-11-09T18:40:00Z' });
  assert.equal(second.changed, false);
  assert.equal(second.gespeichert, false);
  assert.equal(second.geschrieben.length, 1);
  assert.equal(second.geschrieben[0].recovered, true);
  assert.deepEqual(snapshot(root), before);
  assert.equal(readStore(root).lagen[0].publication_recovery.recovered_at, now);
  assert.equal(new Set(readStore(root).lagen.map((e) => e.lage_id)).size, 3);
});

test('Mitternacht und vor06:00 holen keine alten Tage nach und benötigen keine Geschichten', (t) => {
  const previous = edition('morgenlage');
  const root = fixture(t, [previous], null);
  const before = snapshot(root);
  for (const at of ['2026-11-09T23:00:00Z', '2026-11-10T04:59:00Z']) {
    assert.equal(checkDueLagen({ root, now: at }).publication_needed, false);
    const result = schreibeLage({ root, now: at, missingOnly: true });
    assert.equal(result.status, 'keine_lage_faellig');
    assert.equal(result.changed, false);
  }
  assert.deepEqual(snapshot(root), before);
});

test('neuer Morgen ergänzt nur den neuen Tag; frühere Lücken bleiben unverändert', (t) => {
  const previous = edition('morgenlage');
  const root = fixture(t, [previous], []);
  const result = schreibeLage({ root, now: '2026-11-10T05:00:00Z', missingOnly: true });
  assert.deepEqual(result.geschrieben.map((e) => e.lage_id), ['2026-11-10-morgenlage']);
  assert.deepEqual(readStore(root).lagen[1], previous);
  assert.equal(readStore(root).lagen[0].publication_recovery, undefined, 'exakter Cutoff ist keine Nachlieferung');
});

test('expliziter Slot erzeugt nichts Zukünftiges und überschreibt keine frühere Ausgabe', (t) => {
  const morning = edition('morgenlage');
  const root = fixture(t, [morning], null);
  const before = snapshot(root);
  assert.equal(schreibeLage({ root, now: '2026-11-09T11:01:00Z', slot: 'abendlage' }).status, 'lage_noch_nicht_faellig');
  assert.equal(schreibeLage({ root, now, slot: 'morgenlage' }).changed, false);
  assert.equal(schreibeLage({ root, now, slot: 'invalid' }).status, 'slot_unbekannt');
  assert.deepEqual(snapshot(root), before);
});

test('Dryrun berechnet Lücken ohne Mutation; unbekannte Slots/Zeitpunkte schreiben nichts', (t) => {
  const root = fixture(t, [edition('morgenlage')]);
  const before = snapshot(root);
  const result = schreibeLage({ root, now, missingOnly: true, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(result.gespeichert, false);
  assert.deepEqual(result.geschrieben.map((e) => e.slot), ['mittagslage', 'abendlage']);
  assert.equal(schreibeLage({ root, now: 'invalid' }).status, 'fenster_unlesbar');
  assert.deepEqual(snapshot(root), before);
});

test('Dryrun lädt keine fehlenden Release-Teile und materialisiert keinen Cache', (t) => {
  const root = fixture(t, [], null);
  const raw = Buffer.from(JSON.stringify(stories));
  const zip = gzipSync(raw);
  const digest = (b) => createHash('sha256').update(b).digest('hex');
  const sha256 = digest(raw);
  jsonFile(root, 'data/news/stories.json', { storage_format: 'woek-newsroom-parts-1', fields: [
    { key: 'stories', kind: 'array', count: stories.length, parts: [{ sha256, bytes: raw.length,
      release: { storage_format: 'woek-release-part-gzip-1', tag: 'wirkungsticker-data-2026-11',
        asset: `${sha256}.json.gz`, bytes: zip.length, sha256: digest(zip) } }] },
  ] });
  const before = snapshot(root);
  assert.throws(() => schreibeLage({ root, now, dryRun: true }), /LAGE_DRY_RUN_REQUIRES_LOCAL_STORY_PARTS/);
  assert.deepEqual(snapshot(root), before);
  assert.ok(!fs.existsSync(path.join(root, 'data/news/stories.json.parts')));
});

test('Catch-up kann Historie bewahren, reguläres upsert behält seinen Retentionsvertrag', () => {
  const old = edition('morgenlage', '2026-01-01T06:00:00Z');
  const current = edition('abendlage');
  assert.equal(upsertLage(storeOf([old]), current).lagen.length, 1);
  assert.equal(upsertLage(storeOf([old]), current, { prune: false }).lagen.length, 2);
});

test('echte CLI check-due und missing-only brauchen bei geschlossenem Tagesbestand keine Geschichten', (t) => {
  const at = new Date().toISOString();
  const root = fixture(t, dueLagen(at).map((slot) => edition(slot, at)), null);
  const sourceScripts = fileURLToPath(new URL('../../scripts', import.meta.url));
  fs.cpSync(sourceScripts, path.join(root, 'scripts'), { recursive: true });
  const impactRelease = fileURLToPath(new URL('../../content/news/impact-release.json', import.meta.url));
  jsonFile(root, 'content/news/impact-release.json', JSON.parse(fs.readFileSync(impactRelease, 'utf8')));
  const before = snapshot(root);
  const cli = fs.realpathSync(path.join(root, 'scripts/news/lage-schreiben.mjs'));
  const run = (flag) => JSON.parse(execFileSync(process.execPath, [cli, flag], { encoding: 'utf8', timeout: 10000 }));
  assert.equal(run('--check-due').publication_needed, false);
  const result = run('--missing-only');
  assert.equal(result.changed, false);
  assert.deepEqual(result.geschrieben, []);
  assert.deepEqual(snapshot(root), before);
});
