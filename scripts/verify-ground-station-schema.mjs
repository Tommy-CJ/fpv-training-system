import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../server/database/initializeDatabase.js";

const db = new DatabaseSync(":memory:");
initializeDatabase(db);
const presetColumns = new Set(db.prepare("PRAGMA table_info(fleet_configuration_presets)").all().map((column) => column.name));
for (const requiredColumn of ["pilot_id", "parent_preset_id", "version_number"]) {
  if (!presetColumns.has(requiredColumn)) throw new Error(`预设版本字段缺失：${requiredColumn}`);
}
const now = Date.now();
const addPilot = db.prepare(`
  INSERT INTO fleet_pilots (id, name, note, active, created_at, updated_at)
  VALUES (?, ?, '', 1, ?, ?)
`);
addPilot.run("pilot-a", "A", now, now);
addPilot.run("pilot-b", "B", now, now);

const addAircraft = db.prepare(`
  INSERT INTO fleet_aircraft
    (id, serial_number, owner_pilot_id, status, created_at, updated_at)
  VALUES (?, ?, ?, 'active', ?, ?)
`);
addAircraft.run("aircraft-a", "1", "pilot-a", now, now);
addAircraft.run("aircraft-b", "1", "pilot-b", now, now);

let duplicateBlocked = false;
try {
  addAircraft.run("aircraft-c", "1", "pilot-a", now, now);
} catch {
  duplicateBlocked = true;
}
if (!duplicateBlocked) throw new Error("同一飞手的飞机序号唯一约束未生效");

console.log("ground-station-schema-ok");

const legacyDb = new DatabaseSync(":memory:");
legacyDb.exec(`
  CREATE TABLE fleet_aircraft (
    id TEXT PRIMARY KEY,
    serial_number TEXT NOT NULL UNIQUE,
    owner_pilot_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    configuration_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO fleet_aircraft
    (id, serial_number, owner_pilot_id, status, created_at, updated_at)
  VALUES ('legacy-aircraft', '1', 'pilot-a', 'active', 1, 1);

  CREATE TABLE fleet_configuration_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'team_baseline',
    board_identifier TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'betaflight_cli',
    content_hash TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'coach',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
initializeDatabase(legacyDb);
const legacyPresetColumns = new Set(
  legacyDb.prepare("PRAGMA table_info(fleet_configuration_presets)").all().map((column) => column.name),
);
for (const requiredColumn of ["pilot_id", "parent_preset_id", "version_number"]) {
  if (!legacyPresetColumns.has(requiredColumn)) throw new Error(`旧库预设版本字段迁移失败：${requiredColumn}`);
}
const migratedSql = String(
  legacyDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fleet_aircraft'").get()?.sql || "",
);
if (/serial_number\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(migratedSql)) {
  throw new Error("旧版飞机序号唯一约束未完成迁移");
}
legacyDb.prepare(`
  INSERT INTO fleet_aircraft
    (id, serial_number, owner_pilot_id, status, created_at, updated_at)
  VALUES ('migrated-aircraft', '1', 'pilot-b', 'active', 2, 2)
`).run();

console.log("ground-station-migration-ok");
