import { diffConfigurations } from "../server/features/groundStation/registerGroundStationRoutes.js";

const cliBefore = [
  "set craftname = TEAM-01",
  "set motor_direction = NORMAL",
  "set report_cell_voltage = OFF",
  "set custom_experimental_value = 1",
  "profile 0",
  "set p_roll = 45",
  "rateprofile 0",
  "set roll_rc_rate = 100",
].join("\n");

const cliAfter = [
  "set craftname = TEAM-02",
  "set motor_direction = REVERSED",
  "set report_cell_voltage = ON",
  "set custom_experimental_value = 2",
  "profile 0",
  "set p_roll = 48",
  "rateprofile 0",
  "set roll_rc_rate = 110",
].join("\n");

const cliDiff = diffConfigurations(cliBefore, cliAfter, "betaflight_cli");
const byCanonicalPath = new Map(cliDiff.changed.map((item) => [item.canonicalPath, item]));

if (
  byCanonicalPath.get("device.craftName")?.label !== "飞行器名称"
  || byCanonicalPath.get("settings.motor.direction")?.afterDisplay !== "外转"
  || byCanonicalPath.get("settings.battery.reportCellVoltage")?.afterDisplay !== "开启"
  || byCanonicalPath.get("profiles.pid[0].axes.roll.p")?.profileLabel !== "PID Profile 1"
  || byCanonicalPath.get("profiles.rates[0].axes.roll.rcRate")?.label !== "横滚 RC Rate"
) {
  throw new Error(`CLI 语义映射错误：${JSON.stringify(cliDiff)}`);
}

const custom = cliDiff.changed.find((item) => item.key.includes("custom_experimental_value"));
if (!custom || custom.mapped !== false || cliDiff.summary.unmapped !== 1) {
  throw new Error(`CLI 未映射字段没有明确标记：${JSON.stringify(custom)}`);
}

const snapshotBefore = {
  schemaVersion: 1,
  device: { craftName: "TEAM-01", pilotName: "A" },
  profiles: {
    pid: [{
      index: 0,
      axes: { roll: { p: 45, raw: [45] } },
      pidsRaw: [[45], [], [], [10]],
    }],
    rates: [{
      index: 0,
      axes: { yaw: { limit: 700 } },
      throttle: { limitPercent: 100 },
      raw: { yaw_rate_limit: 700, throttleLimitPercent: 100, dynamic_THR_PID: 0 },
    }],
  },
  settings: { vtx: { vtx_band: 5, vtx_channel: 1 } },
};
const snapshotAfter = structuredClone(snapshotBefore);
snapshotAfter.profiles.pid[0].axes.roll.p = 48;
snapshotAfter.profiles.pid[0].axes.roll.raw[0] = 48;
snapshotAfter.profiles.pid[0].pidsRaw[0][0] = 48;
snapshotAfter.profiles.rates[0].axes.yaw.limit = 800;
snapshotAfter.profiles.rates[0].throttle.limitPercent = 90;
snapshotAfter.profiles.rates[0].raw.yaw_rate_limit = 800;
snapshotAfter.profiles.rates[0].raw.throttleLimitPercent = 90;
snapshotAfter.settings.vtx.vtx_channel = 3;

const mspDiff = diffConfigurations(
  JSON.stringify(snapshotBefore),
  JSON.stringify(snapshotAfter),
  "json",
);
const mspByKey = new Map(mspDiff.changed.map((item) => [item.key, item]));
if (
  mspByKey.get("profiles.pid[0].axes.roll.p")?.label !== "横滚 P"
  || mspByKey.get("profiles.rates[0].axes.yaw.limit")?.afterDisplay !== "800 °/s"
  || mspByKey.get("profiles.rates[0].throttle.limitPercent")?.afterDisplay !== "90%"
  || mspByKey.get("settings.vtx.vtx_channel")?.label !== "图传频道"
  || mspByKey.get("settings.vtx.vtx_channel")?.afterDisplay !== "频道 3"
  || mspDiff.summary.total !== 4
) {
  throw new Error(`MSP 语义映射错误：${JSON.stringify(mspDiff)}`);
}

const reorderedBefore = structuredClone(snapshotBefore);
reorderedBefore.profiles.pid.push({
  index: 1,
  axes: { roll: { p: 42 } },
  tuning: { antiGravityGain: 35 },
});
reorderedBefore.settings.systemAdvanced = {
  dshotIdlePercent: 5.5,
  gyroCalibrationDuration: 125,
  debugModeCount: 90,
};
const reorderedAfter = structuredClone(reorderedBefore);
reorderedAfter.profiles.pid.reverse();
reorderedAfter.settings.systemAdvanced.debugModeCount = 91;
const reorderedDiff = diffConfigurations(
  JSON.stringify(reorderedBefore),
  JSON.stringify(reorderedAfter),
  "json",
);
if (reorderedDiff.summary.total !== 0) {
  throw new Error(`Profile 必须按显式 index 比较，不能按数组位置比较：${JSON.stringify(reorderedDiff)}`);
}

reorderedAfter.settings.systemAdvanced.dshotIdlePercent = 6;
reorderedAfter.settings.systemAdvanced.gyroCalibrationDuration = 150;
const systemAdvancedDiff = diffConfigurations(
  JSON.stringify(reorderedBefore),
  JSON.stringify(reorderedAfter),
  "json",
);
const systemAdvancedByKey = new Map(systemAdvancedDiff.changed.map((item) => [item.key, item]));
if (
  systemAdvancedDiff.summary.total !== 2
  || systemAdvancedByKey.get("settings.systemAdvanced.dshotIdlePercent")?.label !== "DShot 怠速"
  || systemAdvancedByKey.get("settings.systemAdvanced.gyroCalibrationDuration")?.label !== "陀螺仪校准时长"
) {
  throw new Error(`全局 MSP 参数语义或只读字段过滤错误：${JSON.stringify(systemAdvancedDiff)}`);
}

const unknownBefore = structuredClone(snapshotBefore);
const unknownAfter = structuredClone(snapshotBefore);
unknownBefore.settings.osd = {
  selectedProfile: null,
  alarms: {},
};
unknownAfter.settings.osd = {
  selectedProfile: 0,
  alarms: { rssi: { value: 20 } },
};
const unknownDiff = diffConfigurations(
  JSON.stringify(unknownBefore),
  JSON.stringify(unknownAfter),
  "json",
);
if (unknownDiff.summary.total !== 0) {
  throw new Error(`MSP 未知、null 或本次未读取字段不应生成配置变化：${JSON.stringify(unknownDiff)}`);
}

const structuredBefore = structuredClone(snapshotBefore);
structuredBefore.schemaVersion = 2;
structuredBefore.settings.features = {
  features: { _featureMask: 270893592 },
};
structuredBefore.settings.modes = {
  ARM: [{ auxChannel: "AUX 1", start: 1625, end: 2100, logic: "OR" }],
};
structuredBefore.settings.osd = {
  displayItems: [{
    index: 45,
    name: "LINK_QUALITY",
    position: 2200,
    visible: [true, true, true],
  }],
};
const structuredAfter = structuredClone(structuredBefore);
structuredAfter.settings.features.features._featureMask = 270894616;
structuredAfter.settings.modes.ARM[0].start = 1575;
structuredAfter.settings.osd.displayItems[0].position = 2168;

const structuredDiff = diffConfigurations(
  JSON.stringify(structuredBefore),
  JSON.stringify(structuredAfter),
  "json",
);
const structuredByKey = new Map(structuredDiff.changed.map((item) => [item.key, item]));
const featureChange = structuredByKey.get("settings.features.features._featureMask");
const modeChange = structuredByKey.get("settings.modes.ARM[0].start");
const osdChange = structuredByKey.get("settings.osd.displayItems[LINK_QUALITY].position");
if (
  structuredDiff.summary.total !== 3
  || featureChange?.mapped !== true
  || featureChange?.beforeDisplay !== "遥测：关闭"
  || featureChange?.afterDisplay !== "遥测：开启"
  || modeChange?.label !== "解锁 · 范围 1 · 触发范围起点"
  || modeChange?.mapped !== true
  || osdChange?.category !== "osd"
  || osdChange?.mapped !== true
) {
  throw new Error(`功能、模式或 OSD 语义映射错误：${JSON.stringify(structuredDiff)}`);
}

console.log("ground-station-configuration-semantics-ok");
