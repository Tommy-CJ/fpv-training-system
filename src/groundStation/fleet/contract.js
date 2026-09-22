export const FLEET_BRIDGE_CHANNEL = "fpv-fleet-betaflight";
export const FLEET_SCHEMA_VERSION = 1;

export const FLEET_KERNELS = Object.freeze({
  MODERN: "modern",
  LEGACY: "legacy",
});

export const FLEET_MESSAGE_KINDS = Object.freeze({
  COMMAND: "command",
  RESPONSE: "response",
  EVENT: "event",
});

export const FLEET_EVENTS = Object.freeze({
  BRIDGE_READY: "bridge.ready",
  CONNECTION_PHASE: "connection.phase",
  DEVICE_IDENTIFIED: "device.identified",
  KERNEL_SWITCH_REQUIRED: "kernel.switch-required",
  CONFIGURATION_WRITE: "configuration.write",
  CONFIGURATION_COMMIT: "configuration.commit",
  CONTROLLER_REBOOT: "controller.reboot",
  CONNECTION_CLOSED: "connection.closed",
  OPERATION_ERROR: "operation.error",
});

export const FLEET_COMMANDS = Object.freeze({
  STATE_GET: "state.get",
  SNAPSHOT_CAPTURE: "snapshot.capture",
  CONNECTION_CONNECT: "connection.connect",
  CONNECTION_DISCONNECT: "connection.disconnect",
  SETTING_SET_CRAFT_NAME: "setting.setCraftName",
  SETTING_SET_VTX_CHANNEL: "setting.setVtxChannel",
  SETTING_SET_THROTTLE_LIMIT: "setting.setThrottleLimit",
  CONFIGURATION_COMMIT: "configuration.commit",
  CLI_DIFF_ALL: "cli.diffAll",
});

function parseApiVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
}

export function kernelForApiVersion(apiVersion) {
  const parsed = parseApiVersion(apiVersion);
  if (!parsed || parsed.major !== 1) return null;
  if (parsed.minor >= 44 && parsed.minor <= 48) return FLEET_KERNELS.MODERN;
  if (parsed.minor >= 41 && parsed.minor <= 46) return FLEET_KERNELS.LEGACY;
  return null;
}

export function normalizeDeviceIdentity(value = {}, kernel = "") {
  return {
    deviceUid: String(value.deviceUid || value.deviceIdentifier || ""),
    target: String(
      value.target
      || value.boardName
      || value.targetName
      || value.boardIdentifier
      || "",
    ),
    boardIdentifier: String(value.boardIdentifier || value.target || value.boardName || ""),
    hardwareName: String(value.hardwareName || ""),
    manufacturerId: String(value.manufacturerId || ""),
    firmwareVariant: String(value.firmwareVariant || value.flightControllerIdentifier || ""),
    firmwareVersion: String(value.firmwareVersion || value.flightControllerVersion || ""),
    apiVersion: String(value.apiVersion || ""),
    buildKey: String(value.buildKey || ""),
    buildTime: String(value.buildTime || value.buildInfo || ""),
    craftName: String(value.craftName || value.name || ""),
    pilotName: String(value.pilotName || ""),
    kernel: String(value.kernel || kernel || ""),
  };
}

const MSP_DOMAIN_RULES = [
  ["PID", "pid"],
  ["RC_TUNING", "rates"],
  ["RC_DEADBAND", "pid"],
  ["SIMPLIFIED_TUNING", "pid"],
  ["RESET_CURR_PID", "pid"],
  ["FILTER", "filters"],
  ["MIXER", "motor"],
  ["ADVANCED_CONFIG", "motor"],
  ["MOTOR_OUTPUT", "motor"],
  ["MOTOR", "motor"],
  ["VTX", "vtx"],
  ["FAILSAFE", "failsafe"],
  ["ARMING", "failsafe"],
  ["RXFAIL", "failsafe"],
  ["RX", "receiver"],
  ["RSSI", "receiver"],
  ["SERIAL", "ports"],
  ["MODE_RANGE", "modes"],
  ["ADJUSTMENT_RANGE", "modes"],
  ["BOX", "modes"],
  ["OSD", "osd"],
  ["BATTERY", "battery"],
  ["VOLTAGE", "battery"],
  ["CURRENT", "battery"],
  ["MISC", "legacy"],
  ["BF_CONFIG", "legacy"],
  ["LOOP_TIME", "legacy"],
  ["GPS", "gps"],
  ["WP", "gps"],
  ["LED", "led"],
  ["BOARD_ALIGNMENT", "sensors"],
  ["SENSOR_ALIGNMENT", "sensors"],
  ["SENSOR_CONFIG", "sensors"],
  ["COMPASS", "sensors"],
  ["ACC_TRIM", "sensors"],
  ["BLACKBOX", "blackbox"],
  ["SERVO", "servos"],
  ["TRANSPONDER", "transponder"],
  ["TEXT", "identity"],
  ["NAME", "identity"],
  ["BOARD_INFO", "identity"],
  ["FEATURE", "features"],
  ["BEEPER", "features"],
];

export function domainForMspName(name) {
  const normalized = String(name || "").toUpperCase();
  return MSP_DOMAIN_RULES.find(([fragment]) => normalized.includes(fragment))?.[1] || "other";
}

export function createFleetEnvelope(kind, body = {}) {
  return {
    channel: FLEET_BRIDGE_CHANNEL,
    schemaVersion: FLEET_SCHEMA_VERSION,
    kind,
    ...body,
  };
}

export function isFleetEnvelope(value) {
  return Boolean(
    value
    && value.channel === FLEET_BRIDGE_CHANNEL
    && value.schemaVersion === FLEET_SCHEMA_VERSION
    && Object.values(FLEET_MESSAGE_KINDS).includes(value.kind),
  );
}

export function serializeFleetSnapshot(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}
