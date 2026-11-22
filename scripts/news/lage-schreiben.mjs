#!/usr/bin/env node
import { readRepositoryJson, readNewsroom } from './newsroom-store.mjs';
// Schreibt eine Lage in data/news/lagen.json. Kein Modellaufruf, keine Kosten:
// die Lage ist eine Ableitung aus den bereits veroeffentlichten Wirkungsakten.
// Derselbe Lauf zweimal ergibt dieselbe Lage (upsertLage), ein abgebrochener
// Lauf kann also einfach wiederholt werden.
//
// Aufruf: node scripts/news/lage-schreiben.mjs [--missing-only] [--dry-run]
// Nur lokale Faelligkeit pruefen: node scripts/news/lage-schreiben.mjs --check-due
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLage, upsertLage, dueLagen, lageDefinition, lageId, lageWindow } from './lage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// A normal scheduled build may finish after the edition cutoff. This grace
// only controls the visible recovery note; it is not a punctuality guarantee.
const PUBLICATION_GRACE_MS = 60 * 60 * 1000;
function readLagen(lagenFile) {
  const store = fs.existsSync(lagenFile) ? JSON.parse(fs.readFileSync(lagenFile, 'utf8')) : { lagen: [] };
  if (!store || !Array.isArray(store.lagen)) throw Error('LAGE_STORE_INVALID');
  const ids = new Set();
  for (const entry of store.lagen) {
    if (!entry || typeof entry.lage_id !== 'string' || ids.has(entry.lage_id)) throw Error('LAGE_STORE_INVALID');
    ids.add(entry.lage_id);
  }
  return store;
}

function duePlan(store, now) {
  const date = lageWindow('morgenlage', now)?.isoDate;
  if (!date) return { status: 'fenster_unlesbar', publication_needed: false, now };
  const due_slots = dueLagen(now);
  const ids = new Set(store.lagen.map((entry) => entry.lage_id));
  const missing_slots = due_slots.filter((slot) => !ids.has(lageId(date, slot)));
  return { status: 'ok', date, current_slot: due_slots.at(-1) || null, due_slots, missing_slots,
    missing_lage_ids: missing_slots.map((slot) => lageId(date, slot)), publication_needed: missing_slots.length > 0 };
}

// This path never reads stories, reports or released parts and never writes.
export function checkDueLagen({ now = new Date().toISOString(), root = ROOT } = {}) {
  return duePlan(readLagen(path.join(root, 'data/news/lagen.json')), now);
}

export function schreibeLage({ slot, now = new Date().toISOString(), root = ROOT, dryRun = false, missingOnly = false } = {}) {
  const storiesFile = path.join(root, 'data/news/stories.json');
  const lagenFile = path.join(root, 'data/news/lagen.json');
  const vorher = readLagen(lagenFile);
  const plan = duePlan(vorher, now);
  const unchanged = { changed: false, gespeichert: false, geschrieben: [] };
  if (plan.status !== 'ok') return { ...plan, ...unchanged };
  if (slot && !lageDefinition(slot)) return { status: 'slot_unbekannt', slot, ...unchanged };
  if (slot && !plan.due_slots.includes(slot)) return { status: 'lage_noch_nicht_faellig', slot, ...unchanged };
  const slots = (slot ? [slot] : plan.due_slots)
    .filter((entry) => plan.missing_slots.includes(entry) || !missingOnly && entry === plan.current_slot);
  if (!slots.length) return { ...plan, ...unchanged, status: 'keine_lage_faellig' };
  // Dry runs may use already verified local parts, but must not hydrate/cache a
  // missing part. The publication workflow hydrates separately before writing.
  const catalog = dryRun ? readNewsroom(storiesFile, undefined, { readReleasePart: () => {
    throw Error('LAGE_DRY_RUN_REQUIRES_LOCAL_STORY_PARTS');
  } }) : readRepositoryJson(storiesFile);
  const stories = (catalog.stories || [])
    .filter((story) => story.published && story.analysis && story.listed !== false);
  const reportFile = path.join(root, 'reports/wirkungsticker-latest-run.json');
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : undefined;
  let store = vorher;
  const geschrieben = [];
  for (const selected of slots) {
    const lage = buildLage({ slot: selected, now, stories, report });
    if (!lage) return { status: 'fenster_unlesbar', slot: selected, now, ...unchanged };
    if (plan.missing_slots.includes(selected) && (selected !== plan.current_slot
        || Date.parse(now) - Date.parse(lage.window_to) > PUBLICATION_GRACE_MS)) {
      lage.publication_recovery = { recovered_at: new Date(now).toISOString(),
        note: 'Diese Ausgabe wurde nachträglich aus bereits veröffentlichten Nachrichten zusammengestellt. Ihr Stand bezeichnet das Nachrichtenfenster, nicht den Zeitpunkt der Bereitstellung.' };
    }
    // Catch-up is not retention maintenance: leave all older editions intact.
    store = upsertLage(store, lage, { now, prune: false });
    geschrieben.push(store.lagen.find((entry) => entry.lage_id === lage.lage_id));
  }
  store = { ...vorher, ...store, updated_at: store.lagen[0]?.stand || store.updated_at };
  const changed = JSON.stringify(store) !== JSON.stringify(vorher);
  if (!dryRun && changed) fs.writeFileSync(lagenFile, `${JSON.stringify(store, null, 2)}\n`);
  const lage = geschrieben.at(-1);
  return { status: 'ok', lage_id: lage.lage_id, slot: lage.slot, counts: lage.counts,
    headline: lage.headline, window: { from: lage.window_from, to: lage.window_to },
    geschrieben: geschrieben.map((entry) => ({ lage_id: entry.lage_id, slot: entry.slot, counts: entry.counts,
      window: { from: entry.window_from, to: entry.window_to }, recovered: Boolean(entry.publication_recovery) })),
    changed, gespeichert: !dryRun && changed, lagen_in_ablage: store.lagen.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const slotArg = process.argv.indexOf('--slot');
  const ergebnis = process.argv.includes('--check-due') ? checkDueLagen() : schreibeLage({
    slot: slotArg > -1 ? process.argv[slotArg + 1] : undefined,
    dryRun: process.argv.includes('--dry-run'),
    missingOnly: process.argv.includes('--missing-only'),
  });
  console.log(JSON.stringify(ergebnis, null, 2));
  if (!['ok', 'keine_lage_faellig'].includes(ergebnis.status)) process.exit(1);
}
