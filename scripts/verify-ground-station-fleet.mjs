import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "../server/database/initializeDatabase.js";
import { diffConfigurations } from "../server/features/groundStation/registerGroundStationRoutes.js";
import {
  FLEET_EVENTS,
  FLEET_KERNELS,
  domainForMspName,
  kernelForApiVersion,
} from "../src/groundStation/fleet/contract.js";

assert.equal(FLEET_EVENTS.CONTROLLER_REBOOT, "controller.reboot");
assert.equal(kernelForApiVersion("1.41.0"), FLEET_KERNELS.LEGACY);
assert.equal(kernelForApiVersion("1.43.0"), FLEET_KERNELS.LEGACY);
assert.equal(kernelForApiVersion("1.44.0"), FLEET_KERNELS.MODERN);
assert.equal(kernelForApiVersion("1.48.0"), FLEET_KERNELS.MODERN);
assert.equal(kernelForApiVersion("1.49.0"), null);
assert.equal(domainForMspName("MSP_SET_PID_ADVANCED"), "pid");
assert.equal(domainForMspName("MSP_SET_VTX_CONFIG"), "vtx");

const snapshot = {
  schemaVersion: 1,
  source: "msp",
  capturedAt: 1,
  device: {
    deviceUid: "verify-device",
    target: "VERIFY_TARGET",
    firmwareVersion: "4.5.4",
    kernel: "modern",
  },
  profiles: {
    pid: [{ index: 0, axes: { roll: { p: 45, i: 80, d: 35 } } }],
    rates: [{ index: 0, axes: { roll: { rcRate: 10, expo: 0, superRate: 70 } } }],
  },
  settings: {
    vtx: { vtx_band: 5, vtx_channel: 3 },
  },
  coverage: {
    level: "msp-ui",
    errors: [{ command: "transient", message: "first read timed out" }],
  },
};
const laterSnapshot = structuredClone(snapshot);
laterSnapshot.capturedAt = 2;
laterSnapshot.coverage.errors = [];

const stableDiff = diffConfigurations(
  JSON.stringify(snapshot),
  JSON.stringify(laterSnapshot),
  "json",
);
assert.equal(stableDiff.summary.total, 0, "capture metadata must not create a configuration change");

const upgradedSnapshot = structuredClone(snapshot);
upgradedSnapshot.schemaVersion = 2;
assert.equal(
  diffConfigurations(
    JSON.stringify(snapshot),
    JSON.stringify(upgradedSnapshot),
    "json",
  ).summary.total,
  0,
  "snapshot schema metadata must not create a configuration change",
);

laterSnapshot.profiles.rates[0].axes.roll.superRate = 72;
const changedDiff = diffConfigurations(
  JSON.stringify(snapshot),
  JSON.stringify(laterSnapshot),
  "json",
);
assert.equal(changedDiff.summary.total, 1);
assert.equal(changedDiff.changed[0].key, "profiles.rates[0].axes.roll.superRate");

const reorderedSnapshot = structuredClone(snapshot);
reorderedSnapshot.profiles.pid = [
  { index: 1, axes: { roll: { p: 40, i: 75, d: 30 } } },
  ...reorderedSnapshot.profiles.pid,
];
const sameProfilesDifferentOrder = structuredClone(reorderedSnapshot);
sameProfilesDifferentOrder.profiles.pid.reverse();
assert.equal(
  diffConfigurations(
    JSON.stringify(reorderedSnapshot),
    JSON.stringify(sameProfilesDifferentOrder),
    "json",
  ).summary.total,
  0,
  "profile arrays must be compared by their explicit profile index",
);

const db = new DatabaseSync(":memory:");
initializeDatabase(db);
const eventColumns = new Set(
  db.prepare("PRAGMA table_info(fleet_tuning_events)").all().map((column) => column.name),
);
for (const column of [
  "session_id",
  "sequence_number",
  "event_type",
  "domain",
  "msp_code",
  "msp_name",
  "payload_json",
  "committed",
]) {
  assert(eventColumns.has(column), `fleet_tuning_events.${column} is missing`);
}
const stateColumns = new Set(
  db.prepare("PRAGMA table_info(fleet_aircraft_states)").all().map((column) => column.name),
);
for (const column of [
  "aircraft_id",
  "flight_controller_id",
  "previous_state_id",
  "source",
  "board_identifier",
  "firmware_version",
  "api_version",
  "content",
  "content_format",
  "content_hash",
  "changed_domains_json",
  "created_at",
]) {
  assert(stateColumns.has(column), `fleet_aircraft_states.${column} is missing`);
}
db.close();

console.log("ground-station-fleet-contract-ok");
console.log("ground-station-canonical-diff-ok");
console.log("ground-station-event-schema-ok");
console.log("ground-station-aircraft-state-schema-ok");
