import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeDatabase } from "../server/database/initializeDatabase.js";

const db = new Database(":memory:");
try {
  initializeDatabase(db);
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT pilot_id, time, flying, turtle
    FROM training_samples
    WHERE event_id = ? AND time >= ? AND time <= ?
    ORDER BY pilot_id ASC, time ASC, id ASC
  `).all("event-1", 1000, 2000);
  assert.ok(plan.some((step) =>
    step.detail.includes("idx_training_samples_event_time")
    && step.detail.includes("time>?")),
  `timeline patch must use the event/time range index: ${JSON.stringify(plan)}`);
  console.log("Timeline patch uses the event/time range index.");
} finally {
  db.close();
}
