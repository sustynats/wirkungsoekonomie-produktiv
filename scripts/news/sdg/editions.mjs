import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { berlinInstant, lageDefinition, lageId } from "../lage.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function utc(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError("Expected canonical UTC timestamp");
  }
  return value;
}

function checkHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("Expected SHA-256");
  }
}

// This module stores already-reviewed items from an explicit caller. It does
// not determine what passed review and has no publisher or provider.
export class EditionLedger {
  constructor(database) {
    this.db = new DatabaseSync(database);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS qualified (
        id TEXT PRIMARY KEY NOT NULL,
        analysis_hash TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        ready_at TEXT NOT NULL,
        dossier_hash TEXT NOT NULL,
        dossier TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS editions (
        id TEXT PRIMARY KEY NOT NULL,
        scheduled_at TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        sealed_at TEXT NOT NULL,
        hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'staged'),
        publication_at TEXT CHECK (publication_at IS NULL)
      );
      CREATE TABLE IF NOT EXISTS edition_items (
        edition_id TEXT NOT NULL REFERENCES editions(id),
        item_id TEXT PRIMARY KEY NOT NULL REFERENCES qualified(id)
      );
    `);
  }

  close() {
    this.db.close();
  }

  transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordReady(items) {
    const add = this.db.prepare(`
      INSERT INTO qualified VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `);
    const read = this.db.prepare("SELECT * FROM qualified WHERE id = ?");
    return this.transaction(() => {
      for (const { id, analysisHash, sourceHash, readyAt, dossier } of items) {
        if (typeof id !== "string" || !id.trim()) throw new TypeError("Expected a qualified item ID");
        checkHash(analysisHash);
        checkHash(sourceHash);
        utc(readyAt);
        if (!dossier || typeof dossier !== "object" || Array.isArray(dossier)) throw new TypeError("Expected a reviewed dossier");
        const bytes = JSON.stringify(dossier);
        const dossierHash = sha(bytes);
        if (add.run(id, analysisHash, sourceHash, readyAt, dossierHash, bytes).changes === 0) {
          const existing = read.get(id);
          if (existing.analysis_hash !== analysisHash || existing.source_hash !== sourceHash ||
              existing.ready_at !== readyAt || existing.dossier_hash !== dossierHash || existing.dossier !== bytes) {
            throw new Error("Qualified item revision changed");
          }
        }
      }
    });
  }

  stage({ date, slot, cutoff, sealedAt }) {
    const definition = lageDefinition(slot);
    const scheduledAt = definition && berlinInstant(date, definition.hour);
    if (!scheduledAt) throw new TypeError("Unknown Berlin edition window");
    const id = lageId(date, slot);
    utc(cutoff);
    utc(sealedAt);
    if (cutoff > sealedAt) throw new Error("Cutoff is after sealing");
    return this.transaction(() => {
      const current = this.read(id);
      if (current) {
        if (current.cutoff !== cutoff) throw new Error("Edition is already sealed at another cutoff");
        return current;
      }
      const items = this.db.prepare(`
        SELECT q.id, q.analysis_hash, q.source_hash, q.ready_at, q.dossier_hash
        FROM qualified q LEFT JOIN edition_items i ON q.id = i.item_id
        WHERE q.ready_at <= ? AND i.item_id IS NULL
        ORDER BY q.ready_at, q.id
      `).all(cutoff);
      const hash = sha(JSON.stringify({ id, scheduledAt, cutoff, sealedAt, items }));
      this.db.prepare("INSERT INTO editions VALUES (?, ?, ?, ?, ?, 'staged', NULL)")
        .run(id, scheduledAt, cutoff, sealedAt, hash);
      const link = this.db.prepare("INSERT INTO edition_items VALUES (?, ?)");
      for (const item of items) link.run(id, item.id);
      return this.read(id);
    });
  }

  read(id) {
    const edition = this.db.prepare("SELECT * FROM editions WHERE id = ?").get(id);
    if (!edition) return null;
    const items = this.db.prepare(`
      SELECT q.id, q.analysis_hash, q.source_hash, q.ready_at, q.dossier_hash
      FROM edition_items i JOIN qualified q ON q.id = i.item_id
      WHERE i.edition_id = ? ORDER BY q.ready_at, q.id
    `).all(id);
    return { ...edition, items };
  }

  readDossier(id) {
    const row = this.db.prepare("SELECT dossier, dossier_hash FROM qualified WHERE id = ?").get(id);
    if (!row) return null;
    if (sha(row.dossier) !== row.dossier_hash) throw new Error("Reviewed dossier content changed");
    return { dossierHash: row.dossier_hash, dossier: JSON.parse(row.dossier) };
  }
}
