import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { berlinInstant, LAGEN, lageDefinition, lageId } from "../lage.mjs";
import { berlinParts } from "../lib.mjs";

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
  constructor(database, { readOnly = false } = {}) {
    this.db = new DatabaseSync(database, { readOnly });
    if (readOnly) return;
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
      CREATE TABLE IF NOT EXISTS edition_schedule (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        start_at TEXT NOT NULL,
        last_scheduled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS edition_deliveries (
        edition_id TEXT PRIMARY KEY NOT NULL REFERENCES editions(id),
        ledger_hash TEXT NOT NULL,
        receipt TEXT NOT NULL,
        receipt_hash TEXT NOT NULL
      ) STRICT;
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
    return this.transaction(() => this.#stageWindow({ id, scheduledAt, cutoff, sealedAt }));
  }

  #stageWindow({ id, scheduledAt, cutoff, sealedAt }) {
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
  }

  stageDue({ startAt, checkedThrough, sealedAt, acceptedReviews }) {
    utc(startAt);
    utc(checkedThrough);
    utc(sealedAt);
    const start = berlinParts(new Date(startAt));
    if (!LAGEN.some(({ hour }) => berlinInstant(start.isoDate, hour) === startAt)) {
      throw new Error("SDG_SCHEDULE_START_MUST_BE_A_BERLIN_EDITION");
    }
    if (checkedThrough > sealedAt) throw new Error("SDG_SCHEDULE_CHECK_AFTER_SEALING");
    const lastDate = berlinParts(new Date(checkedThrough)).isoDate;

    return this.transaction(() => {
      if (acceptedReviews !== undefined) {
        const rows = this.db.prepare("SELECT id, ready_at, dossier_hash FROM qualified WHERE ready_at <= ?").all(checkedThrough);
        if (rows.length !== acceptedReviews.size || rows.some(row => {
          const review = acceptedReviews.get(row.id);
          return review?.readyAt !== row.ready_at || review?.dossierHash !== row.dossier_hash;
        })) throw new Error("SDG_SCHEDULE_REVIEW_LEDGER_MISMATCH");
      }
      this.db.prepare("INSERT INTO edition_schedule VALUES (1, ?, NULL) ON CONFLICT(id) DO NOTHING")
        .run(startAt);
      const schedule = this.db.prepare("SELECT * FROM edition_schedule WHERE id = 1").get();
      if (schedule.start_at !== startAt) throw new Error("SDG_SCHEDULE_START_CHANGED");
      let latest = schedule.last_scheduled_at;
      if (latest !== null && checkedThrough < latest) throw new Error("SDG_SCHEDULE_CHECK_BEHIND_CURSOR");
      const firstDate = berlinParts(new Date(latest ?? startAt)).isoDate;
      // Advance civil dates in UTC, then resolve each slot in Berlin.
      for (const day = new Date(firstDate + "T12:00:00Z");
        day.toISOString().slice(0, 10) <= lastDate;
        day.setUTCDate(day.getUTCDate() + 1)) {
        const date = day.toISOString().slice(0, 10);
        for (const { slot, hour } of LAGEN) {
          const scheduledAt = berlinInstant(date, hour);
          if (scheduledAt < startAt || scheduledAt > checkedThrough ||
              (latest !== null && scheduledAt <= latest)) continue;
          this.#stageWindow({ id: lageId(date, slot), scheduledAt, cutoff: scheduledAt, sealedAt });
          latest = scheduledAt;
        }
      }
      if (latest !== schedule.last_scheduled_at) {
        this.db.prepare("UPDATE edition_schedule SET last_scheduled_at = ? WHERE id = 1").run(latest);
      }
      return this.db.prepare(`
        SELECT id, hash FROM editions WHERE scheduled_at >= ? AND scheduled_at <= ? ORDER BY scheduled_at
      `).all(startAt, latest);
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

  editionHash(id) {
    return this.db.prepare("SELECT hash FROM editions WHERE id = ?").get(id)?.hash ?? null;
  }

  readDelivery(id) {
    const row = this.db.prepare("SELECT * FROM edition_deliveries WHERE edition_id = ?").get(id);
    if (!row) return null;
    if (row.ledger_hash !== this.editionHash(id) || sha(row.receipt) !== row.receipt_hash) {
      throw new Error("SDG_EDITION_DELIVERY_CHANGED");
    }
    const receipt = JSON.parse(row.receipt);
    if (receipt.edition_id !== id) throw new Error("SDG_EDITION_DELIVERY_CHANGED");
    return receipt;
  }

  recordVerifiedDelivery(receipt, ledgerHash) {
    const { edition_id: id, edition_sha256: editionHash, observed_at: observedAt,
      deployment_job_completed_at: deployedAt } = receipt;
    checkHash(ledgerHash);
    checkHash(editionHash);
    utc(observedAt);
    utc(deployedAt);
    return this.transaction(() => {
      const edition = this.db.prepare("SELECT hash, sealed_at FROM editions WHERE id = ?").get(id);
      if (!edition || edition.hash !== ledgerHash || deployedAt < edition.sealed_at || observedAt < deployedAt) {
        throw new Error("SDG_EDITION_DELIVERY_BINDING_MISMATCH");
      }
      const existing = this.readDelivery(id);
      if (existing) {
        if (existing.edition_sha256 !== editionHash) throw new Error("SDG_EDITION_DELIVERY_BINDING_MISMATCH");
        return { status: "already_confirmed", receipt: existing };
      }
      const body = JSON.stringify(receipt);
      this.db.prepare("INSERT INTO edition_deliveries VALUES (?, ?, ?, ?)").run(id, ledgerHash, body, sha(body));
      return { status: "confirmed", receipt };
    });
  }

  readDossier(id) {
    const row = this.db.prepare("SELECT dossier, dossier_hash FROM qualified WHERE id = ?").get(id);
    if (!row) return null;
    if (sha(row.dossier) !== row.dossier_hash) throw new Error("Reviewed dossier content changed");
    return { dossierHash: row.dossier_hash, dossier: JSON.parse(row.dossier) };
  }
}
