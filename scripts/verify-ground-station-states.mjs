import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../server/database/initializeDatabase.js";
import { registerGroundStationRoutes } from "../server/features/groundStation/registerGroundStationRoutes.js";

process.env.COACH_PASSWORD = "verify-coach";
process.env.TEAM_PASSWORD = "verify-team";

const db = new Database(":memory:");
initializeDatabase(db);
const now = Date.now();
db.prepare(`
  INSERT INTO fleet_pilots (id, name, note, active, created_at, updated_at)
  VALUES ('pilot-state', '状态飞手', '', 1, ?, ?)
`).run(now, now);
db.prepare(`
  INSERT INTO fleet_aircraft
    (id, serial_number, owner_pilot_id, status, created_at, updated_at)
  VALUES ('aircraft-state', '1', 'pilot-state', 'active', ?, ?)
`).run(now, now);
db.prepare(`
  INSERT INTO fleet_flight_controllers
    (id, device_uid, board_identifier, board_name, firmware_variant,
     firmware_version, api_version, first_seen_at, last_seen_at)
  VALUES ('controller-state', 'state-device', 'VERIFY_TARGET', 'VERIFY_TARGET',
          'BTFL', '4.5.4', '1.46.0', ?, ?)
`).run(now, now);

const app = express();
app.use(express.json({ limit: "4mb" }));
registerGroundStationRoutes({ app, db });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const headers = {
  "Content-Type": "application/json",
  "x-team-password": "verify-team",
  "x-operator-label": encodeURIComponent("状态验证员"),
};

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

const baseSnapshot = {
  schemaVersion: 1,
  source: "msp",
  device: {
    deviceUid: "state-device",
    target: "VERIFY_TARGET",
    firmwareVersion: "4.5.4",
    apiVersion: "1.46.0",
  },
  profiles: {
    pid: [{ index: 0, axes: { roll: { p: 45 } } }],
    rates: [{ index: 0, axes: { roll: { rcRate: 100 } } }],
  },
  settings: { vtx: { vtx_band: 5, vtx_channel: 1 } },
  coverage: { level: "msp-ui", domains: ["pid", "rates", "vtx"], errors: [] },
};

function stateBody(snapshot, source, changedDomains = []) {
  return JSON.stringify({
    aircraftId: "aircraft-state",
    flightControllerId: "controller-state",
    boardIdentifier: "VERIFY_TARGET",
    firmwareVersion: "4.5.4",
    apiVersion: "1.46.0",
    source,
    changedDomains,
    content: JSON.stringify(snapshot),
    contentFormat: "json",
  });
}

try {
  const initial = await request("/api/ground-station/states", {
    method: "POST",
    headers,
    body: stateBody(baseSnapshot, "connection_scan"),
  });
  if (!initial.created) throw new Error("首次 MSP 扫描没有建立飞机状态");

  const recapturedSnapshot = structuredClone(baseSnapshot);
  recapturedSnapshot.capturedAt = Date.now();
  recapturedSnapshot.device.deviceUid = "another-read-identity";
  recapturedSnapshot.coverage.domains = ["rates"];
  recapturedSnapshot.coverage.errors = [{ command: "transient-read-error" }];
  const unchanged = await request("/api/ground-station/states", {
    method: "POST",
    headers,
    body: stateBody(recapturedSnapshot, "connection_scan"),
  });
  if (!unchanged.unchanged) throw new Error("相同 MSP 状态被重复入库");

  const enrichedSnapshot = structuredClone(baseSnapshot);
  enrichedSnapshot.settings.osd = {
    displayItems: [{
      index: 0,
      name: "RSSI_VALUE",
      position: 42,
      visible: [true, true, true],
    }],
  };
  const enriched = await request("/api/ground-station/states", {
    method: "POST",
    headers,
    body: stateBody(enrichedSnapshot, "connection_scan"),
  });
  if (enriched.created || !enriched.unchanged || !enriched.coverageEnriched) {
    throw new Error("新增 MSP 覆盖字段应补齐现有基线，不能生成虚假历史");
  }

  const incompleteSnapshot = structuredClone(baseSnapshot);
  incompleteSnapshot.profiles.pid = [];
  incompleteSnapshot.coverage.errors = [{
    stage: "pid-profile",
    index: 0,
    critical: true,
    message: "PID Profile 1 读取失败",
  }];
  const incompleteResponse = await fetch(`${baseUrl}/api/ground-station/states`, {
    method: "POST",
    headers,
    body: stateBody(incompleteSnapshot, "connection_scan"),
  });
  if (incompleteResponse.status !== 422) {
    throw new Error(`不完整 Profile 扫描不应写入数据库：${incompleteResponse.status}`);
  }

  const changedSnapshot = structuredClone(enrichedSnapshot);
  changedSnapshot.profiles.rates[0].axes.roll.rcRate = 110;
  const changed = await request("/api/ground-station/states", {
    method: "POST",
    headers,
    body: stateBody(changedSnapshot, "msp_commit", ["rates"]),
  });
  if (!changed.created || changed.diff?.summary?.total !== 1) {
    throw new Error("EEPROM 提交后的状态差异没有生成版本");
  }

  const preview = await request("/api/ground-station/preset-match", {
    method: "POST",
    headers,
    body: JSON.stringify({
      aircraftId: "aircraft-state",
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      contentFormat: "json",
      content: JSON.stringify(changedSnapshot),
      comparisonStateId: changed.state.previousStateId,
    }),
  });
  if (preview.differences?.previous?.differenceCount !== 1) {
    throw new Error("当前状态没有和真正的前一版本比较");
  }

  const history = await request("/api/ground-station/history", { headers });
  if (history.length !== 2 || history[0].changedDomains[0] !== "rates") {
    throw new Error("飞机状态历史没有按版本返回");
  }

  console.log("ground-station-aircraft-state-flow-ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
