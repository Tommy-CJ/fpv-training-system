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
  VALUES ('pilot-verify', '测试飞手', '', 1, ?, ?)
`).run(now, now);

const app = express();
app.use(express.json({ limit: "4mb" }));
registerGroundStationRoutes({ app, db });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const coachHeaders = {
  "Content-Type": "application/json",
  "x-coach-password": "verify-coach",
  "x-operator-label": encodeURIComponent("验证员"),
};
const configuration = [
  "set report_cell_voltage = ON",
  "set craftname = VERIFY_CRAFT",
  "set pilotname = VERIFY_PILOT",
  "set vtx_band = 5",
  "set vtx_channel = 3",
  "set motor_direction = REVERSED",
  "profile 0",
  "set p_pitch = 45",
  "profile 1",
  "set p_pitch = 45",
  "profile 2",
  "set p_pitch = 45",
  "profile 3",
  "set p_pitch = 45",
  "rateprofile 0",
  "set rates_type = ACTUAL",
  "set roll_rc_rate = 10",
  "rateprofile 1",
  "set rates_type = ACTUAL",
  "set roll_rc_rate = 10",
  "rateprofile 2",
  "set rates_type = ACTUAL",
  "set roll_rc_rate = 10",
  "rateprofile 3",
  "set rates_type = ACTUAL",
  "set roll_rc_rate = 10",
].join("\n");
const capturedConfiguration = [
  configuration,
  "# agent-vtxtable-begin",
  "vtxtable band 5 RACEBAND R FACTORY 8 5658 5695 5732 5769 5806 5843 5880 5917",
  "# agent-vtxtable-end",
].join("\n");

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

try {
  const baselineV1 = await jsonRequest("/api/ground-station/presets", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      name: "验证基线",
      kind: "team_baseline",
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      content: configuration,
    }),
  });
  const baselineV2 = await jsonRequest("/api/ground-station/presets", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      name: "验证基线",
      kind: "team_baseline",
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      parentPresetId: baselineV1.id,
      content: `${configuration}\nset throttle_limit_percent = 90`,
    }),
  });
  if (
    baselineV1.versionNumber !== 1
    || baselineV2.versionNumber !== 2
    || baselineV1.mappingVersion !== 7
  ) {
    throw new Error("基线版本号没有递增");
  }

  const pilotVersion = await jsonRequest("/api/ground-station/presets", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      kind: "pilot",
      pilotId: "pilot-verify",
      parentPresetId: baselineV1.id,
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      content: configuration,
    }),
  });
  if (pilotVersion.pilotName !== "测试飞手" || pilotVersion.createdBy !== "验证员") {
    throw new Error("飞手标签或提交者未写入预设版本");
  }

  const match = await jsonRequest("/api/ground-station/preset-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      content: capturedConfiguration,
    }),
  });
  if (
    match.matchType !== "exact"
    || match.important.craftName !== "VERIFY_CRAFT"
    || match.important.pilotName !== "VERIFY_PILOT"
    || match.important.vtxChannel !== "R3"
    || match.important.vtxFrequency !== "5732"
    || match.important.vtxOptions?.length !== 8
    || match.important.motorDirection !== "REVERSED"
    || match.checklist.profileConsistency?.matches !== true
  ) {
    throw new Error(`预设匹配或检查单错误：${JSON.stringify(match)}`);
  }
  if (
    match.differences?.baseline?.differenceCount !== 1
    || match.differences?.baseline?.diff?.summary?.total !== 1
  ) {
    throw new Error(`基线差异摘要错误：${JSON.stringify(match.differences)}`);
  }

  const unsafeProfiles = await jsonRequest("/api/ground-station/preset-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boardIdentifier: "VERIFY_TARGET",
      firmwareVersion: "4.5.4",
      content: capturedConfiguration.replace("profile 3\nset p_pitch = 45", "profile 3\nset p_pitch = 46"),
    }),
  });
  if (unsafeProfiles.checklist.profileConsistency?.matches !== false) {
    throw new Error(`Profile 1–4 不一致未被识别：${JSON.stringify(unsafeProfiles.checklist)}`);
  }

  const canonicalProfile = {
    axes: {
      roll: { p: 45, i: 80, d: 35 },
      pitch: { p: 45, i: 80, d: 35 },
      yaw: { p: 45, i: 80, d: 0 },
    },
    advanced: { feedforward: 120 },
  };
  const canonicalRate = {
    axes: {
      roll: { rcRate: 10, expo: 0, superRate: 70 },
      pitch: { rcRate: 10, expo: 0, superRate: 70 },
      yaw: { rcRate: 10, expo: 0, superRate: 70 },
    },
    throttle: { limitType: 1, limitPercent: 90 },
  };
  const canonicalSnapshot = {
    schemaVersion: 1,
    source: "msp",
    capturedAt: 100,
    device: {
      deviceUid: "json-device",
      target: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      craftName: "JSON_CRAFT",
      pilotName: "JSON_PILOT",
      kernel: "modern",
    },
    profiles: {
      pid: Array.from({ length: 4 }, (_, index) => ({ index, ...structuredClone(canonicalProfile) })),
      rates: Array.from({ length: 4 }, (_, index) => ({ index, ...structuredClone(canonicalRate) })),
    },
    settings: {
      mixer: { reverseMotorDir: 1 },
      vtx: { vtx_band: 5, vtx_channel: 3 },
      vtxTableBands: [{
        vtxtable_band_number: 5,
        vtxtable_band_name: "RACEBAND",
        vtxtable_band_letter: "R",
        vtxtable_band_frequencies: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
      }],
      battery: { reportCellVoltage: 1 },
    },
    coverage: { level: "msp-ui", errors: [{ command: "temporary" }] },
  };
  const jsonBaseline = await jsonRequest("/api/ground-station/presets", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      name: "JSON 基线",
      kind: "team_baseline",
      boardIdentifier: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      contentFormat: "json",
      content: JSON.stringify(canonicalSnapshot),
    }),
  });
  const firmware = await jsonRequest("/api/ground-station/firmware", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      fileName: "verify.hex",
      boardIdentifier: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      sourceType: "cloud",
      buildKey: "verify-build-key",
      contentBase64: Buffer.from(":00000001FF\n").toString("base64"),
    }),
  });
  const metadataFirmware = await jsonRequest("/api/ground-station/firmware/metadata", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      boardIdentifier: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      buildKey: "0123456789abcdef0123456789abcdef",
      buildTime: "Aug 05 2026 02:06:56",
    }),
  });
  const sameMetadataFirmware = await jsonRequest("/api/ground-station/firmware/metadata", {
    method: "POST",
    headers: coachHeaders,
    body: JSON.stringify({
      boardIdentifier: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      buildKey: "0123456789abcdef0123456789abcdef",
      buildTime: "Aug 05 2026 02:06:56",
    }),
  });
  if (
    metadataFirmware.hasBinary !== false
    || metadataFirmware.id !== sameMetadataFirmware.id
    || !metadataFirmware.buildTime
  ) {
    throw new Error(`MSP 固件元数据资产登记失败：${JSON.stringify(metadataFirmware)}`);
  }
  const completedBaseline = await jsonRequest(`/api/ground-station/presets/${jsonBaseline.id}/assets`, {
    method: "PATCH",
    headers: coachHeaders,
    body: JSON.stringify({
      rawCliText: "set craftname = JSON_CRAFT\nset pilotname = JSON_PILOT",
      firmwareFileId: firmware.id,
    }),
  });
  if (
    completedBaseline.calibrationStatus !== "complete"
    || !completedBaseline.hasRawCli
    || !completedBaseline.hasCanonicalSnapshot
    || !completedBaseline.hasFirmware
    || completedBaseline.firmwareBuildKey !== "verify-build-key"
  ) {
    throw new Error(`三层预设资产没有正确合并：${JSON.stringify(completedBaseline)}`);
  }
  await jsonRequest("/api/ground-station/settings/display", {
    method: "PUT",
    headers: coachHeaders,
    body: JSON.stringify({
      deviceFields: ["boardIdentifier", "firmwareVersion"],
      criticalFields: ["settings.mixer.reverseMotorDir"],
      checks: [{
        id: "motor-direction",
        label: "电机外转",
        path: "settings.mixer.reverseMotorDir",
        operator: "eq",
        value: "1",
      }],
    }),
  });
  const recapturedSnapshot = structuredClone(canonicalSnapshot);
  recapturedSnapshot.capturedAt = 200;
  recapturedSnapshot.device.deviceUid = "same-config-different-controller";
  recapturedSnapshot.coverage = { level: "selective", domains: ["rates"], errors: [] };
  const jsonMatch = await jsonRequest("/api/ground-station/preset-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      boardIdentifier: "JSON_TARGET",
      firmwareVersion: "4.5.4",
      contentFormat: "json",
      buildKey: "verify-build-key",
      content: JSON.stringify(recapturedSnapshot),
    }),
  });
  if (
    jsonMatch.matchType !== "exact"
    || jsonMatch.important.craftName !== "JSON_CRAFT"
    || jsonMatch.important.pilotName !== "JSON_PILOT"
    || jsonMatch.important.motorDirection !== "1"
    || jsonMatch.important.vtxChannel !== "R3"
    || jsonMatch.important.vtxFrequency !== "5732"
    || jsonMatch.important.vtxOptions?.length !== 8
    || jsonMatch.checklist.profileConsistency?.matches !== true
  ) {
    throw new Error(`统一 JSON 快照匹配错误：${JSON.stringify(jsonMatch)}`);
  }
  if (
    jsonMatch.configuredDisplay?.critical?.[0]?.value !== "1"
    || jsonMatch.configuredDisplay?.checks?.[0]?.passed !== true
  ) {
    throw new Error(`自定义展示或检查条件未生效：${JSON.stringify(jsonMatch.configuredDisplay)}`);
  }

  const download = await fetch(`${baseUrl}/api/ground-station/presets/${pilotVersion.id}/download`);
  if (!download.ok || await download.text() !== configuration) throw new Error("TXT 下载内容错误");

  const session = await jsonRequest("/api/ground-station/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firmwareVersion: "4.5.4" }),
  });
  await jsonRequest(`/api/ground-station/sessions/${session.id}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-token": session.uploadToken },
    body: JSON.stringify({
      eventType: "configuration.write",
      domain: "rates",
      mspCode: 204,
      mspName: "MSP_SET_RC_TUNING",
      payload: { byteLength: 12 },
    }),
  });
  if (db.prepare("SELECT COUNT(*) AS count FROM fleet_tuning_events WHERE session_id = ?").get(session.id).count !== 1) {
    throw new Error("调参写入事件未保存");
  }
  for (const snapshotType of ["before", "after"]) {
    await jsonRequest(`/api/ground-station/sessions/${session.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-token": session.uploadToken },
      body: JSON.stringify({ snapshotType, content: configuration }),
    });
  }
  const finish = await jsonRequest(`/api/ground-station/sessions/${session.id}/finish`, {
    method: "POST",
    headers: { "x-session-token": session.uploadToken },
  });
  if (
    !finish.deleted
    || db.prepare("SELECT id FROM fleet_tuning_sessions WHERE id = ?").get(session.id)
    || db.prepare("SELECT id FROM fleet_tuning_events WHERE session_id = ?").get(session.id)
  ) {
    throw new Error("无变化调参会话未自动删除");
  }

  console.log("ground-station-preset-versions-ok");
  console.log("ground-station-preset-match-ok");
  console.log("ground-station-json-snapshot-match-ok");
  console.log("ground-station-empty-session-cleanup-ok");
  console.log("ground-station-event-journal-ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  db.close();
}
