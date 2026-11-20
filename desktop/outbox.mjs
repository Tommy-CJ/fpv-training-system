import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class CollectorOutbox {
  constructor(filePath) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS packets (
        packet_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        batch_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS packets_sequence ON packets(sequence);
      CREATE TABLE IF NOT EXISTS rejected_packets (
        packet_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        rejected_at INTEGER NOT NULL
      );
    `);
    this.getMetaStatement = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
    this.setMeta = this.db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.sessionId = this.getMetaStatement.get("sessionId")?.value || randomUUID();
    this.setMeta.run("sessionId", this.sessionId);
    this.sequence = Number(this.getMetaStatement.get("sequence")?.value || 0);
    this.insert = this.db.prepare("INSERT INTO packets(packet_id, sequence, event_id, captured_at, batch_json) VALUES (?, ?, ?, ?, ?)");
    this.remove = this.db.prepare("DELETE FROM packets WHERE packet_id = ?");
    this.removeRejected = this.db.prepare("DELETE FROM rejected_packets WHERE packet_id = ?");
    this.insertRejected = this.db.prepare(`
      INSERT OR REPLACE INTO rejected_packets(packet_id, status, reason, rejected_at)
      SELECT packet_id, ?, ?, ? FROM packets WHERE packet_id = ?
    `);
    this.selectPending = this.db.prepare(`
      SELECT packet_id, sequence, event_id, captured_at, batch_json FROM packets
      WHERE sequence <= ? AND packet_id NOT IN (SELECT packet_id FROM rejected_packets)
      ORDER BY sequence LIMIT ?
    `);
    this.selectCount = this.db.prepare("SELECT COUNT(*) AS count FROM packets");
    this.selectPendingCount = this.db.prepare("SELECT COUNT(*) AS count FROM packets WHERE packet_id NOT IN (SELECT packet_id FROM rejected_packets)");
    this.selectRejectedCount = this.db.prepare("SELECT COUNT(*) AS count FROM rejected_packets");
    this.selectRecoveryCount = this.db.prepare("SELECT COUNT(*) AS count FROM packets WHERE sequence <= ? AND packet_id NOT IN (SELECT packet_id FROM rejected_packets)");
    this.selectRecoveryEvents = this.db.prepare("SELECT event_id, MAX(captured_at) AS cutoff_at FROM packets WHERE sequence <= ? AND packet_id NOT IN (SELECT packet_id FROM rejected_packets) GROUP BY event_id");
  }

  cache(eventId, capturedAt, batch) {
    const sequence = this.sequence + 1;
    const packetId = `${this.sessionId}:${sequence}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.setMeta.run("sequence", String(sequence));
      this.insert.run(packetId, sequence, String(eventId || ""), Math.floor(capturedAt), JSON.stringify(batch));
      this.db.exec("COMMIT");
      this.sequence = sequence;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { packetId, clientSequence: sequence, eventId, capturedAt, batch };
  }

  pending(cutoffSequence = Number.MAX_SAFE_INTEGER, limit = 16) {
    return this.selectPending.all(cutoffSequence, limit).map((row) => ({
      packetId: row.packet_id,
      clientSequence: row.sequence,
      eventId: row.event_id,
      capturedAt: row.captured_at,
      batch: JSON.parse(row.batch_json),
    }));
  }

  delete(packetId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.removeRejected.run(String(packetId));
      this.remove.run(String(packetId));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  markRejected(packetId, status, reason) {
    this.insertRejected.run(String(status || "orphaned"), String(reason || ""), Date.now(), String(packetId));
  }
  getMeta(key) { return this.getMetaStatement.get(key)?.value || ""; }
  putMeta(key, value) { this.setMeta.run(key, String(value)); }
  count() { return Number(this.selectCount.get()?.count || 0); }
  pendingCount() { return Number(this.selectPendingCount.get()?.count || 0); }
  rejectedCount() { return Number(this.selectRejectedCount.get()?.count || 0); }
  recoveryCount(cutoffSequence) { return Number(this.selectRecoveryCount.get(cutoffSequence)?.count || 0); }
  recoveryEvents(cutoffSequence) { return this.selectRecoveryEvents.all(cutoffSequence); }
  close() { this.db.close(); }
}
