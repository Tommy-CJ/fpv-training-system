import crypto from "node:crypto";
import {
  CONFIGURATION_MAPPING_VERSION,
  decorateConfigurationDifference,
  describeConfigurationKey,
  formatConfigurationValue,
} from "./configurationSemantics.js";

const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024;
const MAX_FIRMWARE_BYTES = 8 * 1024 * 1024;
const VALID_SNAPSHOT_TYPES = new Set(["before", "intermediate", "after"]);
const DEFAULT_DISPLAY_SETTINGS = Object.freeze({
  deviceFields: [
    "boardIdentifier",
    "deviceUid",
    "firmwareVersion",
    "firmwareBuildKey",
    "kernel",
    "ownerName",
    "serialNumber",
  ],
  criticalFields: [
    "settings.receiver.serialProvider",
    "settings.failsafe.procedure",
  ],
  checks: [],
  showPidTable: false,
  showRateTable: false,
  excludedDiffFields: [],
});

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function json(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function flattenJson(value, prefix = "", output = {}) {
  if (Array.isArray(value)) {
    const indexedProfiles = prefix === "profiles.pid" || prefix === "profiles.rates";
    const namedOsdItems = /^settings\.osd\.(displayItems|statistics|warnings)$/.test(prefix);
    value.forEach((item, position) => {
      if (indexedProfiles && item && typeof item === "object" && Number.isInteger(Number(item.index))) {
        const profile = { ...item };
        const profileIndex = Number(profile.index);
        delete profile.index;
        flattenJson(profile, `${prefix}[${profileIndex}]`, output);
      } else if (namedOsdItems && item && typeof item === "object" && item.name) {
        const osdItem = { ...item };
        const itemName = String(osdItem.name).replaceAll("]", "_");
        delete osdItem.index;
        delete osdItem.name;
        flattenJson(osdItem, `${prefix}[${itemName}]`, output);
      } else {
        flattenJson(item, `${prefix}[${position}]`, output);
      }
    });
    if (value.length === 0) output[prefix || "$"] = "[]";
    return output;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    entries.forEach(([key, item]) => flattenJson(item, prefix ? `${prefix}.${key}` : key, output));
    if (entries.length === 0) output[prefix || "$"] = "{}";
    return output;
  }
  output[prefix || "$"] = value === null ? "null" : String(value);
  return output;
}

function removeRedundantCanonicalFields(snapshot) {
  for (const profile of snapshot.profiles?.pid || []) {
    for (const axis of Object.values(profile.axes || {})) {
      if (axis && typeof axis === "object") delete axis.raw;
    }
    if (Array.isArray(profile.pidsRaw)) {
      profile.otherPidsRaw = profile.pidsRaw.slice(3);
      delete profile.pidsRaw;
    }
  }
  const normalizedRateKeys = new Set([
    "RC_RATE",
    "RC_EXPO",
    "roll_pitch_rate",
    "roll_rate",
    "roll_rate_limit",
    "rcPitchRate",
    "RC_PITCH_EXPO",
    "pitch_rate",
    "pitch_rate_limit",
    "rcYawRate",
    "RC_YAW_EXPO",
    "yaw_rate",
    "yaw_rate_limit",
    "throttle_MID",
    "throttle_EXPO",
    "throttleLimitType",
    "throttleLimitPercent",
    "rates_type",
  ]);
  for (const profile of snapshot.profiles?.rates || []) {
    if (!profile.raw || typeof profile.raw !== "object") continue;
    for (const key of normalizedRateKeys) delete profile.raw[key];
    if (!Object.keys(profile.raw).length) delete profile.raw;
  }
  const removeReadOnlyMetadata = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      delete value.debugModeCount;
      delete value.debug_mode_count;
    }
    for (const child of Object.values(value)) removeReadOnlyMetadata(child);
  };
  removeReadOnlyMetadata(snapshot);
  return snapshot;
}

function validateMspSnapshot(content) {
  try {
    const snapshot = JSON.parse(String(content || ""));
    const errors = Array.isArray(snapshot?.coverage?.errors) ? snapshot.coverage.errors : [];
    const profileError = errors.find((error) => (
      error?.critical === true
      || error?.stage === "pid-profile"
      || error?.stage === "rate-profile"
    ));
    if (profileError) {
      return {
        valid: false,
        error: profileError.message || "PID / Rate Profile 扫描不完整",
      };
    }
    for (const [type, profiles] of Object.entries(snapshot?.profiles || {})) {
      if (!Array.isArray(profiles)) continue;
      const indexes = profiles.map((profile) => Number(profile?.index));
      if (indexes.some((index) => !Number.isInteger(index)) || new Set(indexes).size !== indexes.length) {
        return { valid: false, error: `${type} Profile 索引无效` };
      }
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "MSP 状态 JSON 无效" };
  }
}

export function parseConfiguration(content, format = "betaflight_cli") {
  const text = String(content || "").replace(/\r\n|\r/g, "\n");
  if (format === "json") {
    try {
      const snapshot = JSON.parse(text);
      // These fields describe how the read was performed, not what is stored
      // on the flight controller. In particular, a post-save selective read
      // contains a smaller coverage domain list than the initial full read.
      delete snapshot.capturedAt;
      delete snapshot.coverage;
      delete snapshot.source;
      delete snapshot.schemaVersion;
      if (snapshot.device && typeof snapshot.device === "object") {
        snapshot.device = {
          craftName: snapshot.device.craftName ?? "",
          pilotName: snapshot.device.pilotName ?? "",
        };
      }
      return flattenJson(removeRedundantCanonicalFields(snapshot));
    } catch {
      return { "$raw": text };
    }
  }

  const values = {};
  let unkeyedIndex = 0;
  let profileScope = "";
  let supplementalVtxTable = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^#\s*agent-vtxtable-begin$/i.test(line)) {
      supplementalVtxTable = true;
      continue;
    }
    if (/^#\s*agent-vtxtable-end$/i.test(line)) {
      supplementalVtxTable = false;
      continue;
    }
    if (supplementalVtxTable) continue;
    if (
      !line
      || line.startsWith("#")
      || /^(save|exit|batch\s+(start|end))$/i.test(line)
      || /^defaults\s+nosave$/i.test(line)
      || /^(board_name|manufacturer_id|mcu_id)(?:\s+.*)?$/i.test(line)
      || /^signature(?:\s+.*)?$/i.test(line)
      || /^Entering CLI Mode/i.test(line)
    ) continue;

    const profile = line.match(/^(profile|rateprofile)\s+(\d+)$/i);
    if (profile) {
      profileScope = `${profile[1].toLowerCase()} ${profile[2]}`;
      continue;
    }

    const setting = line.match(/^set\s+([^=\s]+)\s*=\s*(.*)$/i);
    if (setting) {
      const key = `set ${setting[1]}`;
      values[profileScope ? `${profileScope} · ${key}` : key] = setting[2].trim();
      continue;
    }

    const command = line.match(/^(feature|beeper|map|mixer|mmix|smix|servo|resource|timer|dma|serial|aux|adjrange|rxrange|rxfail|vtxtable|vtx|led|color|mode_color)\s+(.+)$/i);
    if (command) {
      const parts = command[2].trim().split(/\s+/);
      const identityWidth = ["resource", "timer", "dma", "serial", "aux", "adjrange", "rxrange"].includes(command[1].toLowerCase()) ? 2 : 1;
      const identity = parts.slice(0, identityWidth).join(" ");
      values[`${command[1].toLowerCase()} ${identity}`] = parts.slice(identityWidth).join(" ") || "enabled";
      continue;
    }

    values[`line ${String(unkeyedIndex).padStart(4, "0")}`] = line;
    unkeyedIndex += 1;
  }
  return values;
}

function normalizeComparableValue(value) {
  const text = String(value ?? "").trim();
  const upper = text.toUpperCase();
  if (["ON", "TRUE", "ENABLED"].includes(upper)) return "1";
  if (["OFF", "FALSE", "DISABLED"].includes(upper)) return "0";
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return String(Number(text));
  return upper;
}

function compareCliAndCanonical(rawCliText, canonicalSnapshot) {
  if (!String(rawCliText || "").trim() || !String(canonicalSnapshot || "").trim()) {
    return {
      status: "incomplete",
      comparable: 0,
      matching: 0,
      different: [],
      missingInMsp: [],
      unmapped: [],
    };
  }
  const cli = parseConfiguration(rawCliText, "betaflight_cli");
  const msp = parseConfiguration(canonicalSnapshot, "json");
  const mspSemantic = new Map();
  for (const [path, value] of Object.entries(msp)) {
    const descriptor = describeConfigurationKey(path, "json");
    const semanticKey = [
      descriptor.category,
      descriptor.profileType,
      descriptor.profileIndex ?? "",
      descriptor.label,
    ].join("|");
    if (!mspSemantic.has(semanticKey)) mspSemantic.set(semanticKey, { path, value });
  }
  const mapped = [];
  const unmapped = [];
  for (const [rawKey, value] of Object.entries(cli)) {
    const descriptor = describeConfigurationKey(rawKey, "betaflight_cli");
    if (!descriptor.mapped || descriptor.canonicalPath.startsWith("cli.")) {
      unmapped.push(rawKey);
      continue;
    }
    mapped.push({ rawKey, canonicalPath: descriptor.canonicalPath, value });
  }
  const different = [];
  const missingInMsp = [];
  let matching = 0;
  for (const item of mapped) {
    const descriptor = describeConfigurationKey(item.rawKey, "betaflight_cli");
    const semanticKey = [
      descriptor.category,
      descriptor.profileType,
      descriptor.profileIndex ?? "",
      descriptor.label,
    ].join("|");
    const semanticMatch = mspSemantic.get(semanticKey);
    const mspPath = item.canonicalPath in msp ? item.canonicalPath : semanticMatch?.path;
    if (!mspPath) {
      missingInMsp.push(item.canonicalPath);
      continue;
    }
    if (normalizeComparableValue(item.value) === normalizeComparableValue(msp[mspPath])) {
      matching += 1;
    } else {
      different.push({
        path: item.canonicalPath,
        cli: item.value,
        msp: msp[mspPath],
      });
    }
  }
  const comparable = matching + different.length;
  return {
    status: different.length ? "different" : comparable ? "consistent" : "unverified",
    comparable,
    matching,
    different: different.slice(0, 200),
    missingInMsp: missingInMsp.slice(0, 200),
    unmapped: unmapped.slice(0, 200),
  };
}

function presetContentForFormat(row, format) {
  if (format === "json") return String(row.canonical_snapshot || "");
  return String(row.raw_cli_text || "");
}

function readDisplaySettings(db) {
  const stored = db.prepare(
    "SELECT value_json FROM fleet_ground_station_settings WHERE setting_key = 'display'",
  ).get();
  const value = json(stored?.value_json, {});
  return {
    deviceFields: Array.isArray(value.deviceFields)
      ? value.deviceFields
        .map((item) => cleanText(item, 80))
        .filter((item) => DEFAULT_DISPLAY_SETTINGS.deviceFields.includes(item))
      : [...DEFAULT_DISPLAY_SETTINGS.deviceFields],
    criticalFields: Array.isArray(value.criticalFields)
      ? value.criticalFields
        .map((item) => cleanText(item, 240))
        .filter(Boolean)
        .slice(0, 120)
      : [...DEFAULT_DISPLAY_SETTINGS.criticalFields],
    checks: Array.isArray(value.checks)
      ? value.checks.map((item) => ({
          id: cleanText(item?.id, 120) || makeId("check"),
          label: cleanText(item?.label, 120),
          path: cleanText(item?.path, 240),
          operator: ["eq", "neq", "gt", "gte", "lt", "lte", "includes", "enabled"].includes(item?.operator)
            ? item.operator
            : "eq",
          value: cleanText(item?.value, 240),
        })).filter((item) => item.path).slice(0, 100)
      : [],
    showPidTable: value.showPidTable === true,
    showRateTable: value.showRateTable === true,
    excludedDiffFields: Array.isArray(value.excludedDiffFields)
      ? value.excludedDiffFields
        .map((item) => cleanText(item, 240))
        .filter(Boolean)
        .slice(0, 240)
      : [],
  };
}

function configuredDisplay(content, format, settings) {
  const values = parseConfiguration(content, format);
  const profileScope = (descriptor) => ({
    profileType: descriptor.profileType || null,
    profileIndex: Number.isInteger(descriptor.profileIndex) ? descriptor.profileIndex : null,
    profileLabel: descriptor.profileType && Number.isInteger(descriptor.profileIndex)
      ? `${descriptor.profileType === "pid" ? "PID" : "Rate"} Profile ${descriptor.profileIndex}`
      : "",
  });
  const select = (paths) => paths.map((path) => {
    const descriptor = describeConfigurationKey(path, "json");
    return {
      path,
      label: descriptor.label,
      category: descriptor.categoryLabel,
      ...profileScope(descriptor),
      available: Object.prototype.hasOwnProperty.call(values, path),
      value: values[path] ?? null,
      formattedValue: Object.prototype.hasOwnProperty.call(values, path)
        ? formatConfigurationValue(values[path], descriptor)
        : "不支持",
    };
  });
  const compare = (actual, operator, expected) => {
    if (actual === undefined || actual === null) return false;
    const leftNumber = Number(actual);
    const rightNumber = Number(expected);
    if (operator === "enabled") return ["1", "TRUE", "ON", "ENABLED"].includes(String(actual).toUpperCase());
    if (operator === "includes") return String(actual).includes(String(expected));
    if (operator === "neq") return normalizeComparableValue(actual) !== normalizeComparableValue(expected);
    if (operator === "gt") return Number.isFinite(leftNumber) && leftNumber > rightNumber;
    if (operator === "gte") return Number.isFinite(leftNumber) && leftNumber >= rightNumber;
    if (operator === "lt") return Number.isFinite(leftNumber) && leftNumber < rightNumber;
    if (operator === "lte") return Number.isFinite(leftNumber) && leftNumber <= rightNumber;
    return normalizeComparableValue(actual) === normalizeComparableValue(expected);
  };
  let snapshot = {};
  if (format === "json") {
    try {
      snapshot = JSON.parse(String(content || "{}"));
    } catch {
      snapshot = {};
    }
  }
  const pidProfiles = Array.isArray(snapshot?.profiles?.pid)
    ? snapshot.profiles.pid.map((profile, index) => {
        const tuning = profile?.tuning || {};
        const feedforward = {
          roll: tuning.feedforwardRoll ?? null,
          pitch: tuning.feedforwardPitch ?? null,
          yaw: tuning.feedforwardYaw ?? null,
        };
        const baseAxes = profile?.axes || {};
        const axes = {};
        for (const axis of ["roll", "pitch", "yaw"]) {
          axes[axis] = { ...(baseAxes[axis] || {}), f: feedforward[axis] };
        }
        return {
          index: Number.isInteger(Number(profile?.index)) ? Number(profile.index) : index,
          name: String(profile?.name || ""),
          axes,
        };
      })
    : [];
  const rateProfiles = Array.isArray(snapshot?.profiles?.rates)
    ? snapshot.profiles.rates.map((profile, index) => ({
        index: Number.isInteger(Number(profile?.index)) ? Number(profile.index) : index,
        name: String(profile?.name || ""),
        axes: profile?.axes || {},
        throttle: profile?.throttle || {},
        ratesType: profile?.ratesType ?? null,
        ratesTypeDisplay: formatConfigurationValue(profile?.ratesType, { valueType: "ratesType" }),
        throttleLimitTypeDisplay: formatConfigurationValue(
          profile?.throttle?.limitType,
          { valueType: "throttleLimitType" },
        ),
      }))
    : [];
  const hiddenCatalogPath = (path) => (
    /^(schemaVersion|source|capturedAt)(?:\.|$)/.test(path)
    || /^coverage(?:\.|$)/.test(path)
    || /^device\.(?!craftName$|pilotName$)/.test(path)
    || /^settings\.(legacyCore|legacyMisc)(?:\.|$)/.test(path)
    || /\.(?:raw|pidsRaw|otherPidsRaw)(?:\.|$)/.test(path)
    || /\.(?:index|name)$/.test(path)
  );
  const availableFields = [];
  const semanticFields = new Set();
  for (const path of Object.keys(values)) {
    if (hiddenCatalogPath(path)) continue;
    const descriptor = describeConfigurationKey(path, format);
    const semanticKey = [
      descriptor.category,
      descriptor.profileType,
      descriptor.profileIndex ?? "",
      descriptor.label,
    ].join("|");
    if (semanticFields.has(semanticKey)) continue;
    semanticFields.add(semanticKey);
    availableFields.push({
      path,
      label: descriptor.label,
      category: descriptor.categoryLabel,
      ...profileScope(descriptor),
      value: values[path],
      formattedValue: formatConfigurationValue(values[path], descriptor),
    });
    if (availableFields.length >= 800) break;
  }
  return {
    critical: select(settings.criticalFields),
    checks: settings.checks.map((rule) => ({
      ...rule,
      actual: values[rule.path] ?? null,
      actualDisplay: Object.prototype.hasOwnProperty.call(values, rule.path)
        ? formatConfigurationValue(values[rule.path], describeConfigurationKey(rule.path, "json"))
        : "不支持",
      available: Object.prototype.hasOwnProperty.call(values, rule.path),
      passed: compare(values[rule.path], rule.operator, rule.value),
    })),
    availableFields,
    tables: {
      pidProfiles,
      rateProfiles,
    },
  };
}

function unmappedCliCommands(content) {
  const unmapped = [];
  let profileScope = "";
  for (const rawLine of String(content || "").replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (
      !line
      || line.startsWith("#")
      || /^(defaults\s+nosave|save|exit|batch\s+(start|end))$/i.test(line)
      || /^(board_name|manufacturer_id|mcu_id|signature)\b/i.test(line)
    ) continue;
    const profile = line.match(/^(profile|rateprofile)\s+(\d+)$/i);
    if (profile) {
      profileScope = `${profile[1].toLowerCase()} ${profile[2]}`;
      continue;
    }
    const setting = line.match(/^set\s+([^=\s]+)\s*=\s*(.*)$/i);
    if (setting) {
      const rawKey = `${profileScope ? `${profileScope} · ` : ""}set ${setting[1]}`;
      if (!describeConfigurationKey(rawKey).mapped) unmapped.push(line);
      continue;
    }
    if (/^(resource|timer|dma)\b/i.test(line)) {
      unmapped.push(line);
      continue;
    }
    const command = line.match(/^([a-z_]+)\s*(.*)$/i);
    const rawKey = command ? `${command[1]} ${command[2]}`.trim() : line;
    if (!describeConfigurationKey(rawKey).mapped) unmapped.push(line);
  }
  return unmapped.slice(0, 2000);
}

export function diffConfigurations(beforeContent, afterContent, format = "betaflight_cli", excludedPaths = []) {
  const excludedSet = excludedPaths instanceof Set ? excludedPaths : new Set(excludedPaths || []);
  const before = parseConfiguration(beforeContent, format);
  const after = parseConfiguration(afterContent, format);
  let comparableNamedModes = false;
  if (format === "json") {
    try {
      const beforeSnapshot = JSON.parse(String(beforeContent || ""));
      const afterSnapshot = JSON.parse(String(afterContent || ""));
      comparableNamedModes = (
        Number(beforeSnapshot?.schemaVersion) >= 2
        && Number(afterSnapshot?.schemaVersion) >= 2
        && beforeSnapshot?.settings?.modes
        && afterSnapshot?.settings?.modes
        && !Array.isArray(beforeSnapshot.settings.modes)
        && !Array.isArray(afterSnapshot.settings.modes)
      );
    } catch {
      comparableNamedModes = false;
    }
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const added = [];
  const removed = [];
  const changed = [];
  const jsonUnknown = (value) => (
    value === "null"
    || value === "undefined"
    || value === "NaN"
  );

  for (const key of keys) {
    if (excludedSet.size) {
      const canonicalPath = describeConfigurationKey(key, format).canonicalPath;
      if (excludedSet.has(canonicalPath) || excludedSet.has(key)) continue;
    }
    const beforeHasKey = key in before;
    const afterHasKey = key in after;
    if (format === "json") {
      // Canonical MSP objects describe fixed firmware fields. A key which is
      // absent, null or NaN means that this scan did not establish its value;
      // it is not evidence that the flight-controller setting was added,
      // removed or reset. Schema v2 named mode ranges are the exception:
      // adding/removing an active range is itself a real configuration change.
      const namedModeKey = comparableNamedModes && key.startsWith("settings.modes.");
      if (
        ((!beforeHasKey || !afterHasKey) && !namedModeKey)
        || (beforeHasKey && jsonUnknown(before[key]))
        || (afterHasKey && jsonUnknown(after[key]))
      ) continue;
    }
    if (!beforeHasKey) added.push({ key, value: after[key] });
    else if (!afterHasKey) removed.push({ key, value: before[key] });
    else if (before[key] !== after[key]) changed.push({ key, before: before[key], after: after[key] });
  }

  const decoratedAdded = added.map((item) => decorateConfigurationDifference(item, format, ["value"]));
  const decoratedRemoved = removed.map((item) => decorateConfigurationDifference(item, format, ["value"]));
  const decoratedChanged = changed.map((item) => decorateConfigurationDifference(item, format, ["before", "after"]));
  const items = [...decoratedAdded, ...decoratedRemoved, ...decoratedChanged];
  const mapped = items.filter((item) => item.mapped).length;
  return {
    mappingVersion: CONFIGURATION_MAPPING_VERSION,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      total: added.length + removed.length + changed.length,
      mapped,
      unmapped: items.length - mapped,
    },
    added: decoratedAdded,
    removed: decoratedRemoved,
    changed: decoratedChanged,
  };
}

function settingValue(configuration, settingName, preferredScope = "") {
  const exactKey = preferredScope ? `${preferredScope} · set ${settingName}` : `set ${settingName}`;
  if (exactKey in configuration) return configuration[exactKey];
  const suffix = `set ${settingName}`;
  const match = Object.entries(configuration).find(([key]) => key === suffix || key.endsWith(` · ${suffix}`));
  return match?.[1] || "";
}

function firstSettingValue(configuration, settingNames, preferredScope = "") {
  for (const settingName of settingNames) {
    const value = settingValue(configuration, settingName, preferredScope);
    if (value !== "") return value;
  }
  return "";
}

function firstSettingEntry(configuration, settingNames, preferredScope = "") {
  for (const settingName of settingNames) {
    const value = settingValue(configuration, settingName, preferredScope);
    if (value !== "") return { name: settingName, value };
  }
  return { name: settingNames[0] || "", value: "" };
}

function lastProfileScope(content, command) {
  const matches = [...String(content || "").matchAll(new RegExp(`^${command}\\s+(\\d+)\\s*$`, "gim"))];
  return matches.length ? `${command.toLowerCase()} ${matches.at(-1)[1]}` : "";
}

// Betaflight standard VTX band letters (vtx_common band numbering). Used so a
// merged label like "R8" can be produced even when the vtxtable is absent from
// an MSP snapshot (band 5 = RaceBand = "R").
const VTX_BAND_LETTERS = ["", "A", "B", "E", "F", "R", "L", "H", "U"];
function vtxBandLabel(band, channel) {
  const bandNumber = Number(band);
  const channelNumber = Number(channel);
  if (!Number.isInteger(bandNumber) || !Number.isInteger(channelNumber)) return "";
  const letter = VTX_BAND_LETTERS[bandNumber] || `B${bandNumber}-`;
  return `${letter}${channelNumber}`;
}

function vtxOptionsFromTable(content) {
  const options = [];
  for (const line of String(content || "").split(/\r\n|\r|\n/)) {
    if (!/^\s*vtxtable\s+band\s+\d+\s+/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const band = Number(parts[2]);
    const name = parts[3] || "";
    const letter = parts[4] || "";
    const channelCount = Number(parts[6]);
    if (!Number.isInteger(band) || !Number.isInteger(channelCount)) continue;
    const prefix = /race/i.test(name) ? "R" : letter || `B${band}-`;
    for (let channel = 1; channel <= channelCount; channel += 1) {
      const frequency = parts[6 + channel] || "";
      options.push({
        value: `${band}:${channel}`,
        band,
        channel,
        label: `${prefix}${channel}`,
        frequency,
      });
    }
  }
  return options;
}

function vtxChannelFromTable(content, configuration) {
  const band = Number(firstSettingValue(configuration, ["vtx_band", "vtxband"]));
  const channel = Number(firstSettingValue(configuration, ["vtx_channel", "vtxchannel"]));
  const options = vtxOptionsFromTable(content);
  if (!band || !channel) return { label: "", frequency: "", options };
  const selected = options.find((option) => option.band === band && option.channel === channel);
  return selected
    ? { label: selected.label, frequency: selected.frequency, options }
    : { label: vtxBandLabel(band, channel), frequency: "", options };
}

function parseFleetSnapshot(content) {
  try {
    const snapshot = JSON.parse(String(content || ""));
    return snapshot && typeof snapshot === "object" ? snapshot : null;
  } catch {
    return null;
  }
}

function summarizeFleetSnapshot(content) {
  const snapshot = parseFleetSnapshot(content);
  if (!snapshot) return null;
  const firstRate = snapshot.profiles?.rates?.[0] || {};
  const vtx = snapshot.settings?.vtx || {};
  const motor = snapshot.settings?.motor || {};
  const mixer = snapshot.settings?.mixer || {};
  const vtxBands = Array.isArray(snapshot.settings?.vtxTableBands)
    ? snapshot.settings.vtxTableBands
    : [];
  const rateAxis = (axis) => {
    const values = firstRate.axes?.[axis] || {};
    return [values.rcRate, values.expo, values.superRate]
      .filter((value) => value !== null && value !== undefined && value !== "")
      .join(" / ");
  };
  const band = Number(vtx.vtx_band ?? vtx.band ?? 0);
  const channel = Number(vtx.vtx_channel ?? vtx.channel ?? 0);
  const vtxOptions = vtxBands.flatMap((item) => {
    const bandNumber = Number(item.vtxtable_band_number || 0);
    const name = String(item.vtxtable_band_name || "");
    const letter = String(item.vtxtable_band_letter || "");
    const prefix = /race/i.test(name) ? "R" : letter || `B${bandNumber}-`;
    return (item.vtxtable_band_frequencies || []).map((frequency, index) => ({
      value: `${bandNumber}:${index + 1}`,
      band: bandNumber,
      channel: index + 1,
      label: `${prefix}${index + 1}`,
      frequency: String(frequency || ""),
    }));
  });
  const selectedVtx = vtxOptions.find((option) => (
    option.band === band && option.channel === channel
  ));
  return {
    vtxChannel: selectedVtx?.label || vtxBandLabel(band, channel),
    vtxFrequency: selectedVtx?.frequency || "",
    vtxOptions,
    throttleLimit: [
      firstRate.throttle?.limitType,
      firstRate.throttle?.limitPercent != null ? `${firstRate.throttle.limitPercent}%` : "",
    ].filter((value) => value !== null && value !== undefined && value !== "").join(" "),
    craftName: String(snapshot.device?.craftName || ""),
    craftNameField: "craftname",
    pilotName: String(snapshot.device?.pilotName || ""),
    motorDirection: String(
      mixer.reverseMotorDir
      ?? mixer.reverse_motor_dir
      ?? motor.motor_direction_reversed
      ?? motor.motorDirectionReversed
      ?? "",
    ),
    rollRate: rateAxis("roll"),
    pitchRate: rateAxis("pitch"),
    yawRate: rateAxis("yaw"),
    reportCellVoltage: String(
      snapshot.settings?.battery?.report_cell_voltage
      ?? snapshot.settings?.battery?.reportCellVoltage
      ?? "",
    ),
  };
}

function summarizeConfiguration(content, format = "betaflight_cli") {
  if (format === "json") return summarizeFleetSnapshot(content) || {};
  const configuration = parseConfiguration(content);
  const rateScope = lastProfileScope(content, "rateprofile");
  const rate = (name) => settingValue(configuration, name, rateScope);
  const vtxChannel = vtxChannelFromTable(content, configuration);
  const craftName = firstSettingEntry(configuration, ["craftname", "craft_name", "name"]);
  const axisRate = (axis) => [
    rate(`${axis}_rc_rate`),
    rate(`${axis}_expo`),
    rate(`${axis}_srate`) || rate(`${axis}_rate`),
  ].filter(Boolean).join(" / ");

  return {
    vtxChannel: vtxChannel.label,
    vtxFrequency: vtxChannel.frequency,
    vtxOptions: vtxChannel.options,
    throttleLimit: [
      firstSettingValue(configuration, ["throttle_limit_type", "throttlelimit_type"]),
      firstSettingValue(configuration, ["throttle_limit_percent", "throttlelimit_percent"])
        ? `${firstSettingValue(configuration, ["throttle_limit_percent", "throttlelimit_percent"])}%`
        : "",
    ].filter(Boolean).join(" "),
    craftName: craftName.value,
    craftNameField: craftName.name,
    pilotName: firstSettingValue(configuration, ["pilotname", "pilot_name"]),
    motorDirection: firstSettingValue(configuration, [
      "motor_direction",
      "motor_direction_reversed",
      "motor_output_reordering",
    ]),
    rateProfile: rateScope.replace("rateprofile ", "") || "0",
    rateType: rate("rates_type"),
    rollRate: axisRate("roll"),
    pitchRate: axisRate("pitch"),
    yawRate: axisRate("yaw"),
    reportCellVoltage: settingValue(configuration, "report_cell_voltage"),
  };
}

function profileFamilyEqual(content, command) {
  const profileIndexes = [0, 1, 2, 3];
  const seen = new Set(
    [...String(content || "").matchAll(new RegExp(`^${command}\\s+(\\d+)\\s*$`, "gim"))]
      .map((match) => Number(match[1])),
  );
  if (!seen.size) return null;
  if (profileIndexes.some((profileIndex) => !seen.has(profileIndex))) return false;

  const configuration = parseConfiguration(content);
  const profiles = profileIndexes.map((profileIndex) => {
    const prefix = `${command} ${profileIndex} · `;
    return Object.fromEntries(
      Object.entries(configuration)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  });
  const keys = new Set(profiles.flatMap((profile) => Object.keys(profile)));
  return [...keys].every((key) => profiles.every((profile) => profile[key] === profiles[0][key]));
}

function fleetProfileFamilyEqual(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 4) return false;
  const comparable = profiles.slice(0, 4).map((profile) => {
    const value = { ...profile };
    delete value.index;
    delete value.name;
    return value;
  });
  return comparable.slice(1).every((profile) => (
    JSON.stringify(profile) === JSON.stringify(comparable[0])
  ));
}

function configurationChecklist(currentContent, format = "betaflight_cli") {
  const current = summarizeConfiguration(currentContent, format);
  if (format === "json") {
    const snapshot = parseFleetSnapshot(currentContent);
    const pidProfilesEqual = fleetProfileFamilyEqual(snapshot?.profiles?.pid);
    const rateProfilesEqual = fleetProfileFamilyEqual(snapshot?.profiles?.rates);
    return {
      profileConsistency: {
        matches: pidProfilesEqual && rateProfilesEqual,
        pidProfilesEqual,
        rateProfilesEqual,
      },
      reportCellVoltage: String(current.reportCellVoltage).toUpperCase() === "ON"
        || current.reportCellVoltage === "1",
    };
  }
  const pidProfilesEqual = profileFamilyEqual(currentContent, "profile");
  const rateProfilesEqual = profileFamilyEqual(currentContent, "rateprofile");
  return {
    profileConsistency: {
      matches: pidProfilesEqual == null && rateProfilesEqual == null
        ? null
        : pidProfilesEqual === true && rateProfilesEqual === true,
      pidProfilesEqual,
      rateProfilesEqual,
    },
    reportCellVoltage: String(current.reportCellVoltage).toUpperCase() === "ON",
  };
}

function aircraftFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    serialNumber: row.serial_number,
    ownerPilotId: row.owner_pilot_id,
    ownerName: row.owner_name || "",
    model: row.model,
    configurationNote: row.configuration_note,
    status: row.status,
    controller: row.flight_controller_id ? {
      id: row.flight_controller_id,
      deviceUid: row.device_uid,
      boardIdentifier: row.board_identifier,
      boardName: row.board_name,
      firmwareVariant: row.firmware_variant,
      firmwareVersion: row.firmware_version,
      apiVersion: row.api_version,
      buildKey: row.build_key || "",
      lastSeenAt: row.last_seen_at,
    } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pilotFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    sourceTrainingPilotId: row.source_training_pilot_id,
    note: row.note,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presetFromRow(row, includeContent = false) {
  const preset = {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    boardIdentifier: row.board_identifier || "",
    firmwareVersion: row.firmware_version,
    pilotId: row.pilot_id || "",
    pilotName: row.pilot_name || "",
    parentPresetId: row.parent_preset_id || "",
    versionNumber: Number(row.version_number) || 1,
    contentFormat: row.content_format,
    contentHash: row.content_hash,
    mappingVersion: Number(row.mapping_version) || 1,
    calibrationStatus: row.calibration_status || "pending",
    coveragePercent: Number(row.coverage_percent) || 0,
    useCaseCategory: row.use_case_category || "默认",
    variantCategory: row.variant_category || "基准",
    versionLabel: row.version_label || "",
    firmwareFileId: row.firmware_file_id || "",
    firmwareSource: row.firmware_source || "",
    firmwareBuildKey: row.firmware_build_key || "",
    firmwareBuildTime: row.firmware_build_time || null,
    consistency: json(row.consistency_json, {}),
    unmappedCliCommands: json(row.unmapped_cli_json, []),
    hasRawCli: Boolean(row.raw_cli_text),
    hasCanonicalSnapshot: Boolean(row.canonical_snapshot),
    hasFirmware: Boolean(row.firmware_file_id),
    published: Boolean(row.published),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeContent) {
    preset.content = row.content;
    preset.rawCliText = row.raw_cli_text || "";
    preset.canonicalSnapshot = row.canonical_snapshot || "";
  }
  return preset;
}

function firmwareFromRow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    boardIdentifier: row.board_identifier || "",
    firmwareVersion: row.firmware_version || "",
    sizeBytes: Number(row.size_bytes),
    contentHash: row.content_hash,
    sourceType: row.source_type || "local",
    buildKey: row.build_key || "",
    buildTime: row.build_time || null,
    hasBinary: Number(row.size_bytes) > 0,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aircraftStateFromRow(row, diff = null) {
  return {
    id: row.id,
    aircraftId: row.aircraft_id || "",
    aircraftSerialNumber: row.serial_number || "",
    ownerName: row.owner_name || "",
    flightControllerId: row.flight_controller_id,
    deviceUid: row.device_uid || "",
    boardName: row.board_identifier || row.controller_board_identifier || row.controller_board_name || "",
    firmwareVersion: row.firmware_version || "",
    apiVersion: row.api_version || "",
    operatorRole: row.operator_role,
    operatorLabel: row.operator_label,
    source: row.source,
    contentFormat: row.content_format,
    contentHash: row.content_hash,
    changedDomains: json(row.changed_domains_json, []),
    previousStateId: row.previous_state_id || "",
    startedAt: row.created_at,
    endedAt: row.created_at,
    createdAt: row.created_at,
    status: "completed",
    snapshotCount: 1,
    eventCount: json(row.changed_domains_json, []).length,
    eventDomains: json(row.changed_domains_json, []),
    diff,
  };
}

export function registerGroundStationRoutes({
  app,
  db,
  betaflightMountPath = "/betaflight",
  betaflightAvailable = false,
  betaflightKernels = [],
}) {
  const coachPassword = String(process.env.COACH_PASSWORD || "");
  const teamPassword = String(process.env.TEAM_PASSWORD || "");

  function roleFromRequest(req) {
    const providedCoach = String(req.headers["x-coach-password"] || "");
    const providedTeam = String(req.headers["x-team-password"] || "");
    if (coachPassword && safeEqual(providedCoach, coachPassword)) return "coach";
    if (teamPassword && safeEqual(providedTeam, teamPassword)) return "team";
    return "guest";
  }

  function requireMember(req, res, next) {
    const role = roleFromRequest(req);
    if (role === "guest") return res.status(403).json({ error: "需要队伍密码或教练密码" });
    req.groundStationRole = role;
    next();
  }

  function requireCoach(req, res, next) {
    const role = roleFromRequest(req);
    if (role !== "coach") return res.status(403).json({ error: "需要教练密码" });
    req.groundStationRole = role;
    next();
  }

  const GUEST_WRITE_WINDOW_MS = 60_000;
  const GUEST_WRITE_MAX = 30;
  const guestWriteHits = new Map();

  function limitGuestWrites(req, res, next) {
    if (roleFromRequest(req) !== "guest") return next();
    const now = Date.now();
    if (guestWriteHits.size > 5000) {
      for (const [key, entry] of guestWriteHits) {
        if (now - entry.windowStart >= GUEST_WRITE_WINDOW_MS) guestWriteHits.delete(key);
      }
    }
    const ip = String(req.ip || "unknown");
    const entry = guestWriteHits.get(ip);
    if (!entry || now - entry.windowStart >= GUEST_WRITE_WINDOW_MS) {
      guestWriteHits.set(ip, { count: 1, windowStart: now });
      return next();
    }
    if (entry.count >= GUEST_WRITE_MAX) {
      return res.status(429).json({ error: "访客请求过于频繁，请稍后再试" });
    }
    entry.count += 1;
    next();
  }

  function requestLabel(req) {
    const raw = String(req.headers["x-operator-label"] || req.body?.operatorLabel || "");
    try {
      return cleanText(decodeURIComponent(raw), 80);
    } catch {
      return cleanText(raw, 80);
    }
  }

  function audit(req, action, entityType, entityId = "", detail = {}) {
    db.prepare(`
      INSERT INTO fleet_audit_log
        (actor_role, actor_label, action, entity_type, entity_id, detail_json, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.groundStationRole || roleFromRequest(req),
      requestLabel(req),
      action,
      entityType,
      String(entityId || ""),
      JSON.stringify(detail || {}),
      cleanText(req.ip, 80),
      Date.now(),
    );
  }

  function resolveOwnerPilotId(value, newOwnerName = "") {
    const requested = cleanText(value, 200);
    if (!requested) {
      const name = cleanText(newOwnerName, 100);
      if (!name) return null;
      const existingByName = db.prepare("SELECT id FROM fleet_pilots WHERE active = 1 AND name = ?").get(name);
      if (existingByName) return existingByName.id;
      const id = makeId("fleet-pilot");
      const now = Date.now();
      db.prepare(`
        INSERT INTO fleet_pilots
          (id, name, source_training_pilot_id, note, active, created_at, updated_at)
        VALUES (?, ?, NULL, '', 1, ?, ?)
      `).run(id, name, now, now);
      return id;
    }
    if (!requested.startsWith("training:")) {
      return db.prepare("SELECT id FROM fleet_pilots WHERE id = ? AND active = 1").get(requested)?.id || null;
    }

    const source = db.prepare("SELECT id, name, note FROM pilots WHERE id = ?").get(requested.slice("training:".length));
    if (!source) return null;
    const existing = db.prepare("SELECT id FROM fleet_pilots WHERE source_training_pilot_id = ?").get(source.id);
    if (existing) return existing.id;

    const id = makeId("fleet-pilot");
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_pilots
        (id, name, source_training_pilot_id, note, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, source.name, source.id, source.note || "", now, now);
    return id;
  }

  function hardDeleteAircraft(aircraftId) {
    db.prepare("DELETE FROM fleet_aircraft_states WHERE aircraft_id = ?").run(aircraftId);
    db.prepare(`
      DELETE FROM fleet_tuning_events
      WHERE session_id IN (SELECT id FROM fleet_tuning_sessions WHERE aircraft_id = ?)
    `).run(aircraftId);
    db.prepare(`
      DELETE FROM fleet_configuration_snapshots
      WHERE session_id IN (SELECT id FROM fleet_tuning_sessions WHERE aircraft_id = ?)
    `).run(aircraftId);
    db.prepare("DELETE FROM fleet_tuning_sessions WHERE aircraft_id = ?").run(aircraftId);
    db.prepare("DELETE FROM fleet_aircraft_controllers WHERE aircraft_id = ?").run(aircraftId);
    db.prepare("DELETE FROM fleet_aircraft WHERE id = ?").run(aircraftId);
  }

  function inTransaction(callback) {
    db.exec("BEGIN");
    try {
      const result = callback();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const aircraftSelect = `
    SELECT a.*, p.name AS owner_name,
      fc.id AS flight_controller_id, fc.device_uid, fc.board_identifier, fc.board_name,
      fc.firmware_variant, fc.firmware_version, fc.api_version, fc.build_key, fc.last_seen_at
    FROM fleet_aircraft a
    LEFT JOIN fleet_pilots p ON p.id = a.owner_pilot_id
    LEFT JOIN fleet_aircraft_controllers afc
      ON afc.aircraft_id = a.id AND afc.removed_at IS NULL
    LEFT JOIN fleet_flight_controllers fc ON fc.id = afc.flight_controller_id
  `;
  const presetSelect = `
    SELECT pr.*, p.name AS pilot_name
    FROM fleet_configuration_presets pr
    LEFT JOIN fleet_pilots p ON p.id = pr.pilot_id
  `;

  app.post("/api/ground-station/auth", (req, res) => {
    const role = roleFromRequest(req);
    if (role === "guest") return res.status(403).json({ error: "密码错误或服务器尚未配置对应密码" });
    res.json({ ok: true, role });
  });

  app.get("/api/ground-station/bootstrap", (req, res) => {
    const role = roleFromRequest(req);
    const presets = db.prepare(`
      ${presetSelect}
      WHERE pr.published = 1 OR ? = 'coach'
      ORDER BY pr.board_identifier, pr.use_case_category, pr.firmware_version,
        pr.variant_category, pr.updated_at DESC
    `).all(role).map((row) => presetFromRow(row));
    res.json({
      role,
      permissions: {
        useStation: true,
        viewFleet: role !== "guest",
        addAircraft: role !== "guest",
        deleteAircraft: role === "coach",
        managePresets: role === "coach",
      },
      betaflight: {
        available: betaflightAvailable,
        url: betaflightMountPath,
        defaultKernel: "modern",
        kernels: betaflightKernels,
      },
      presets,
      displaySettings: readDisplaySettings(db),
    });
  });

  app.put("/api/ground-station/settings/display", requireCoach, (req, res) => {
    const requested = {
      deviceFields: Array.isArray(req.body?.deviceFields) ? req.body.deviceFields : [],
      criticalFields: Array.isArray(req.body?.criticalFields) ? req.body.criticalFields : [],
      checks: Array.isArray(req.body?.checks) ? req.body.checks : [],
      showPidTable: req.body?.showPidTable === true,
      showRateTable: req.body?.showRateTable === true,
      excludedDiffFields: Array.isArray(req.body?.excludedDiffFields) ? req.body.excludedDiffFields : [],
    };
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_ground_station_settings (setting_key, value_json, updated_at)
      VALUES ('display', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(requested), now);
    const stored = readDisplaySettings(db);
    audit(req, "update_display_settings", "ground_station_settings", "display", {
      deviceCount: stored.deviceFields.length,
      criticalCount: stored.criticalFields.length,
      checkCount: stored.checks.length,
    });
    res.json(stored);
  });

  app.get("/api/ground-station/pilots", requireMember, (req, res) => {
    const fleetPilots = db.prepare("SELECT * FROM fleet_pilots WHERE active = 1 ORDER BY name").all().map(pilotFromRow);
    const trainingPilots = db.prepare("SELECT id, name, note, updated_at FROM pilots ORDER BY name").all().map((row) => ({
      id: row.id,
      name: row.name,
      note: row.note,
      updatedAt: row.updated_at,
      readOnly: true,
    }));
    const linkedTrainingIds = new Set(fleetPilots.map((pilot) => pilot.sourceTrainingPilotId).filter(Boolean));
    const visiblePilots = [
      ...fleetPilots,
      ...trainingPilots
        .filter((pilot) => !linkedTrainingIds.has(pilot.id))
        .map((pilot) => ({
          ...pilot,
          id: `training:${pilot.id}`,
          sourceTrainingPilotId: pilot.id,
          readOnly: true,
        })),
    ].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    res.json({ fleetPilots: visiblePilots, trainingPilots });
  });

  app.post("/api/ground-station/pilots", requireMember, (req, res) => {
    const now = Date.now();
    const sourceId = cleanText(req.body?.sourceTrainingPilotId, 120) || null;
    const source = sourceId ? db.prepare("SELECT id, name FROM pilots WHERE id = ?").get(sourceId) : null;
    if (sourceId && !source) return res.status(404).json({ error: "训练系统飞手不存在" });
    const name = cleanText(req.body?.name || source?.name, 100);
    if (!name) return res.status(400).json({ error: "飞手姓名不能为空" });
    const existing = sourceId ? db.prepare("SELECT * FROM fleet_pilots WHERE source_training_pilot_id = ?").get(sourceId) : null;
    if (existing) return res.json(pilotFromRow(existing));
    const id = makeId("fleet-pilot");
    db.prepare(`
      INSERT INTO fleet_pilots
        (id, name, source_training_pilot_id, note, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, sourceId, cleanText(req.body?.note, 1000), now, now);
    audit(req, sourceId ? "import_training_pilot" : "create_pilot", "fleet_pilot", id, { sourceTrainingPilotId: sourceId });
    res.status(201).json(pilotFromRow(db.prepare("SELECT * FROM fleet_pilots WHERE id = ?").get(id)));
  });

  app.put("/api/ground-station/pilots/:id", requireMember, (req, res) => {
    const existing = db.prepare("SELECT * FROM fleet_pilots WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "飞手不存在" });
    const name = cleanText(req.body?.name, 100);
    if (!name) return res.status(400).json({ error: "飞手姓名不能为空" });
    const now = Date.now();
    db.prepare("UPDATE fleet_pilots SET name = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(name, cleanText(req.body?.note, 1000), now, existing.id);
    audit(req, "update_pilot", "fleet_pilot", existing.id);
    res.json(pilotFromRow(db.prepare("SELECT * FROM fleet_pilots WHERE id = ?").get(existing.id)));
  });

  app.delete("/api/ground-station/pilots/:id", requireCoach, (req, res) => {
    const existing = db.prepare("SELECT * FROM fleet_pilots WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "飞手不存在" });
    inTransaction(() => {
      const ownedAircraft = db.prepare("SELECT id FROM fleet_aircraft WHERE owner_pilot_id = ?").all(existing.id);
      ownedAircraft.forEach((aircraft) => hardDeleteAircraft(aircraft.id));
      db.prepare("DELETE FROM fleet_pilots WHERE id = ?").run(existing.id);
    });
    audit(req, "delete_pilot", "fleet_pilot", existing.id);
    res.json({ ok: true });
  });

  app.get("/api/ground-station/aircraft", requireMember, (req, res) => {
    const rows = db.prepare(`${aircraftSelect} ORDER BY a.updated_at DESC`).all();
    res.json(rows.map(aircraftFromRow));
  });

  app.post("/api/ground-station/aircraft", requireMember, (req, res) => {
    const serialNumber = cleanText(req.body?.serialNumber, 100);
    if (!serialNumber) return res.status(400).json({ error: "飞机序号不能为空" });
    const requestedOwnerPilotId = cleanText(req.body?.ownerPilotId, 200) || null;
    const newOwnerName = cleanText(req.body?.newOwnerName, 100);
    const ownerPilotId = resolveOwnerPilotId(requestedOwnerPilotId, newOwnerName);
    if ((requestedOwnerPilotId || newOwnerName) && !ownerPilotId) {
      return res.status(400).json({ error: "机主不在车队飞手库中" });
    }
    if (!ownerPilotId) return res.status(400).json({ error: "请选择机主或填写新人姓名" });
    const controllerId = cleanText(req.body?.flightControllerId, 160);
    if (controllerId && !db.prepare("SELECT id FROM fleet_flight_controllers WHERE id = ?").get(controllerId)) {
      return res.status(400).json({ error: "飞控记录不存在" });
    }
    const now = Date.now();
    const id = makeId("aircraft");
    try {
      db.prepare(`
        INSERT INTO fleet_aircraft
          (id, serial_number, owner_pilot_id, model, configuration_note, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(id, serialNumber, ownerPilotId, cleanText(req.body?.model, 120), cleanText(req.body?.configurationNote, 2000), now, now);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return res.status(409).json({ error: "该飞手名下已存在相同飞机序号" });
      throw error;
    }

    if (controllerId) {
      db.prepare("UPDATE fleet_aircraft_controllers SET removed_at = ? WHERE flight_controller_id = ? AND removed_at IS NULL").run(now, controllerId);
      db.prepare(`
        INSERT INTO fleet_aircraft_controllers
          (id, aircraft_id, flight_controller_id, installed_at, removed_at, note)
        VALUES (?, ?, ?, ?, NULL, ?)
      `).run(makeId("installation"), id, controllerId, now, cleanText(req.body?.controllerNote, 500));
    }
    audit(req, "create_aircraft", "aircraft", id, { serialNumber, controllerId: controllerId || null });
    res.status(201).json(aircraftFromRow(db.prepare(`${aircraftSelect} WHERE a.id = ?`).get(id)));
  });

  app.put("/api/ground-station/aircraft/:id", requireMember, (req, res) => {
    const existing = db.prepare("SELECT * FROM fleet_aircraft WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "飞机不存在" });
    const serialNumber = cleanText(req.body?.serialNumber, 100);
    if (!serialNumber) return res.status(400).json({ error: "飞机序号不能为空" });
    const requestedOwnerPilotId = cleanText(req.body?.ownerPilotId, 200) || null;
    const newOwnerName = cleanText(req.body?.newOwnerName, 100);
    const ownerPilotId = resolveOwnerPilotId(requestedOwnerPilotId, newOwnerName);
    if ((requestedOwnerPilotId || newOwnerName) && !ownerPilotId) {
      return res.status(400).json({ error: "机主不在车队飞手库中" });
    }
    if (!ownerPilotId) return res.status(400).json({ error: "请选择机主或填写新人姓名" });
    const now = Date.now();
    try {
      db.prepare(`
        UPDATE fleet_aircraft SET serial_number = ?, owner_pilot_id = ?, model = ?, configuration_note = ?, updated_at = ?
        WHERE id = ?
      `).run(serialNumber, ownerPilotId, cleanText(req.body?.model, 120), cleanText(req.body?.configurationNote, 2000), now, existing.id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return res.status(409).json({ error: "该飞手名下已存在相同飞机序号" });
      throw error;
    }
    audit(req, "update_aircraft", "aircraft", existing.id);
    res.json(aircraftFromRow(db.prepare(`${aircraftSelect} WHERE a.id = ?`).get(existing.id)));
  });

  app.delete("/api/ground-station/aircraft/:id", requireCoach, (req, res) => {
    const existing = db.prepare("SELECT * FROM fleet_aircraft WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "飞机不存在" });
    inTransaction(() => hardDeleteAircraft(req.params.id));
    audit(req, "delete_aircraft", "aircraft", req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/ground-station/controllers/identify", limitGuestWrites, (req, res) => {
    const deviceUid = cleanText(req.body?.deviceUid, 200);
    if (!deviceUid) return res.status(400).json({ error: "无法读取飞控唯一 ID" });
    const now = Date.now();
    let controller = db.prepare("SELECT * FROM fleet_flight_controllers WHERE device_uid = ?").get(deviceUid);
    if (!controller) {
      const id = makeId("fc");
      db.prepare(`
        INSERT INTO fleet_flight_controllers
          (id, device_uid, board_identifier, board_name, usb_vendor_id, usb_product_id,
           firmware_variant, firmware_version, api_version, build_key, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        deviceUid,
        cleanText(req.body?.boardIdentifier, 80),
        cleanText(req.body?.boardName, 120),
        Number.isFinite(Number(req.body?.usbVendorId)) ? Number(req.body.usbVendorId) : null,
        Number.isFinite(Number(req.body?.usbProductId)) ? Number(req.body.usbProductId) : null,
        cleanText(req.body?.firmwareVariant, 40),
        cleanText(req.body?.firmwareVersion, 40),
        cleanText(req.body?.apiVersion, 40),
        cleanText(req.body?.buildKey, 160),
        now,
        now,
      );
      controller = db.prepare("SELECT * FROM fleet_flight_controllers WHERE id = ?").get(id);
      audit(req, "discover_controller", "flight_controller", id, { deviceUid });
    } else {
      db.prepare(`
        UPDATE fleet_flight_controllers SET
          board_identifier = COALESCE(NULLIF(?, ''), board_identifier),
          board_name = COALESCE(NULLIF(?, ''), board_name),
          usb_vendor_id = COALESCE(?, usb_vendor_id),
          usb_product_id = COALESCE(?, usb_product_id),
          firmware_variant = COALESCE(NULLIF(?, ''), firmware_variant),
          firmware_version = COALESCE(NULLIF(?, ''), firmware_version),
          api_version = COALESCE(NULLIF(?, ''), api_version),
          build_key = COALESCE(NULLIF(?, ''), build_key),
          last_seen_at = ?
        WHERE id = ?
      `).run(
        cleanText(req.body?.boardIdentifier, 80),
        cleanText(req.body?.boardName, 120),
        Number.isFinite(Number(req.body?.usbVendorId)) ? Number(req.body.usbVendorId) : null,
        Number.isFinite(Number(req.body?.usbProductId)) ? Number(req.body.usbProductId) : null,
        cleanText(req.body?.firmwareVariant, 40),
        cleanText(req.body?.firmwareVersion, 40),
        cleanText(req.body?.apiVersion, 40),
        cleanText(req.body?.buildKey, 160),
        now,
        controller.id,
      );
      controller = db.prepare("SELECT * FROM fleet_flight_controllers WHERE id = ?").get(controller.id);
    }

    const role = roleFromRequest(req);
    const match = db.prepare(`${aircraftSelect} WHERE fc.id = ?`).get(controller.id);
    res.json({
      flightControllerId: controller.id,
      deviceUid: controller.device_uid,
      knownAircraft: Boolean(match),
      aircraft: role === "guest" ? null : aircraftFromRow(match),
    });
  });

  app.post("/api/ground-station/states", limitGuestWrites, (req, res) => {
    const role = roleFromRequest(req);
    const aircraftId = cleanText(req.body?.aircraftId, 160) || null;
    const controllerId = cleanText(req.body?.flightControllerId, 160);
    const content = String(req.body?.content || "");
    const contentFormat = req.body?.contentFormat === "betaflight_cli" ? "betaflight_cli" : "json";
    const source = cleanText(req.body?.source, 40) || "connection_scan";
    const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
    const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
    const apiVersion = cleanText(req.body?.apiVersion, 40);
    const changedDomains = [...new Set(
      (Array.isArray(req.body?.changedDomains) ? req.body.changedDomains : [])
        .map((value) => cleanText(value, 80))
        .filter(Boolean),
    )].slice(0, 40);

    if (!controllerId) return res.status(400).json({ error: "无法识别飞控" });
    if (!content.trim()) return res.status(400).json({ error: "MSP 状态不能为空" });
    if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) {
      return res.status(413).json({ error: "MSP 状态不能超过 2MB" });
    }
    if (contentFormat === "json") {
      const validation = validateMspSnapshot(content);
      if (!validation.valid) {
        return res.status(422).json({ error: `${validation.error}；本次状态未写入数据库` });
      }
    }
    const controller = db.prepare("SELECT * FROM fleet_flight_controllers WHERE id = ?").get(controllerId);
    if (!controller) return res.status(404).json({ error: "飞控不存在" });
    if (aircraftId && !db.prepare("SELECT id FROM fleet_aircraft WHERE id = ? AND status = 'active'").get(aircraftId)) {
      return res.status(404).json({ error: "飞机不存在" });
    }
    if (aircraftId && role === "guest") return res.status(403).json({ error: "访客状态不能关联飞机库" });

    const previous = db.prepare(`
      SELECT * FROM fleet_aircraft_states
      WHERE COALESCE(aircraft_id, '') = COALESCE(?, '')
        AND flight_controller_id = ?
        AND board_identifier = ?
        AND firmware_version = ?
        AND content_format = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(aircraftId, controllerId, boardIdentifier, firmwareVersion, contentFormat);
    const diff = previous
      ? diffConfigurations(previous.content, content, contentFormat)
      : null;
    if (previous && diff.summary.total === 0) {
      const previousConfiguration = parseConfiguration(previous.content, contentFormat);
      const currentConfiguration = parseConfiguration(content, contentFormat);
      const coverageEnriched = contentFormat === "json" && Object.keys(currentConfiguration).some(
        (key) => !(key in previousConfiguration)
          && !["null", "undefined", "NaN"].includes(currentConfiguration[key]),
      );
      let unchangedState = previous;
      if (coverageEnriched) {
        db.prepare(`
          UPDATE fleet_aircraft_states
          SET content = ?, content_hash = ?, api_version = ?
          WHERE id = ?
        `).run(content, sha256(content), apiVersion, previous.id);
        unchangedState = db.prepare(
          "SELECT * FROM fleet_aircraft_states WHERE id = ?",
        ).get(previous.id);
      }
      return res.json({
        created: false,
        unchanged: true,
        coverageEnriched,
        state: aircraftStateFromRow(unchangedState, diff),
        diff,
      });
    }

    const id = makeId("state");
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_aircraft_states
        (id, aircraft_id, flight_controller_id, previous_state_id, operator_role,
         operator_label, source, board_identifier, firmware_version, api_version,
         content, content_format, content_hash, changed_domains_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      aircraftId,
      controllerId,
      previous?.id || null,
      role,
      requestLabel(req),
      source,
      boardIdentifier,
      firmwareVersion,
      apiVersion,
      content,
      contentFormat,
      sha256(content),
      JSON.stringify(changedDomains),
      now,
    );
    const stored = db.prepare("SELECT * FROM fleet_aircraft_states WHERE id = ?").get(id);
    audit(req, "save_aircraft_state", "aircraft_state", id, {
      source,
      changedDomains,
      differenceCount: diff?.summary?.total ?? null,
    });
    res.status(201).json({
      created: true,
      unchanged: false,
      state: aircraftStateFromRow(stored, diff),
      diff,
    });
  });

  app.post("/api/ground-station/sessions", limitGuestWrites, (req, res) => {
    const role = roleFromRequest(req);
    const aircraftId = cleanText(req.body?.aircraftId, 160) || null;
    const controllerId = cleanText(req.body?.flightControllerId, 160) || null;
    if (aircraftId && role === "guest") return res.status(403).json({ error: "访客会话不能关联飞机库" });
    if (aircraftId && !db.prepare("SELECT id FROM fleet_aircraft WHERE id = ? AND status = 'active'").get(aircraftId)) {
      return res.status(404).json({ error: "飞机不存在" });
    }
    if (controllerId && !db.prepare("SELECT id FROM fleet_flight_controllers WHERE id = ?").get(controllerId)) {
      return res.status(404).json({ error: "飞控不存在" });
    }
    const now = Date.now();
    const id = makeId("tuning");
    const uploadToken = crypto.randomBytes(24).toString("base64url");
    db.prepare(`
      INSERT INTO fleet_tuning_sessions
        (id, aircraft_id, flight_controller_id, operator_role, operator_label, purpose,
         status, firmware_version, upload_token_hash, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      aircraftId,
      controllerId,
      role,
      requestLabel(req),
      cleanText(req.body?.purpose, 500),
      cleanText(req.body?.firmwareVersion, 80),
      sha256(uploadToken),
      now,
      now,
      now,
    );
    audit(req, "start_tuning_session", "tuning_session", id, { aircraftId, controllerId });
    res.status(201).json({ id, uploadToken, status: "active", startedAt: now });
  });

  function canAccessSession(req, session) {
    if (roleFromRequest(req) !== "guest") return true;
    const token = String(req.headers["x-session-token"] || "");
    return token && safeEqual(sha256(token), session.upload_token_hash);
  }

  app.post("/api/ground-station/sessions/:id/snapshots", limitGuestWrites, (req, res) => {
    const session = db.prepare("SELECT * FROM fleet_tuning_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "调参会话不存在" });
    if (!canAccessSession(req, session)) return res.status(403).json({ error: "无权写入该调参会话" });
    if (session.status !== "active") return res.status(409).json({ error: "调参会话已经结束" });

    const snapshotType = cleanText(req.body?.snapshotType, 30);
    if (!VALID_SNAPSHOT_TYPES.has(snapshotType)) return res.status(400).json({ error: "快照类型无效" });
    const content = String(req.body?.content || "");
    const byteLength = Buffer.byteLength(content);
    if (!content.trim()) return res.status(400).json({ error: "配置快照不能为空" });
    if (byteLength > MAX_CONFIGURATION_BYTES) return res.status(413).json({ error: "配置快照不能超过 2MB" });
    const contentFormat = req.body?.contentFormat === "json" ? "json" : "betaflight_cli";
    const sequence = Number(db.prepare(`
      SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next_sequence
      FROM fleet_configuration_snapshots WHERE session_id = ?
    `).get(session.id).next_sequence);
    const id = makeId("snapshot");
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_configuration_snapshots
        (id, session_id, snapshot_type, sequence_number, content, content_format, content_hash, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      session.id,
      snapshotType,
      sequence,
      content,
      contentFormat,
      sha256(content),
      JSON.stringify(req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {}),
      now,
    );
    db.prepare("UPDATE fleet_tuning_sessions SET updated_at = ? WHERE id = ?").run(now, session.id);
    audit(req, "save_configuration_snapshot", "configuration_snapshot", id, { sessionId: session.id, snapshotType, sequence });
    res.status(201).json({ id, snapshotType, sequenceNumber: sequence, contentHash: sha256(content), createdAt: now });
  });

  app.post("/api/ground-station/sessions/:id/events", limitGuestWrites, (req, res) => {
    const session = db.prepare("SELECT * FROM fleet_tuning_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "调参会话不存在" });
    if (!canAccessSession(req, session)) return res.status(403).json({ error: "无权写入该调参会话" });
    if (session.status !== "active") return res.status(409).json({ error: "调参会话已经结束" });

    const supplied = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    const events = supplied.slice(0, 200);
    if (!events.length) return res.status(400).json({ error: "调参事件不能为空" });
    const nextSequence = Number(db.prepare(`
      SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
      FROM fleet_tuning_events WHERE session_id = ?
    `).get(session.id).next_sequence);
    const insert = db.prepare(`
      INSERT INTO fleet_tuning_events
        (id, session_id, sequence_number, event_type, domain, msp_code, msp_name, payload_json, committed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const stored = [];

    db.exec("BEGIN");
    try {
      events.forEach((event, index) => {
        const eventType = cleanText(event?.eventType, 80);
        if (!eventType) throw new Error("调参事件类型不能为空");
        const id = makeId("event");
        const sequenceNumber = nextSequence + index;
        const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
        insert.run(
          id,
          session.id,
          sequenceNumber,
          eventType,
          cleanText(event?.domain, 80),
          Number.isInteger(Number(event?.mspCode)) ? Number(event.mspCode) : null,
          cleanText(event?.mspName, 120),
          JSON.stringify(payload),
          event?.committed ? 1 : 0,
          Number(event?.createdAt) || now,
        );
        stored.push({ id, sequenceNumber, eventType });
      });
      db.prepare("UPDATE fleet_tuning_sessions SET updated_at = ? WHERE id = ?").run(now, session.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      return res.status(400).json({ error: error.message || "调参事件保存失败" });
    }

    res.status(201).json({ stored });
  });

  app.post("/api/ground-station/sessions/:id/finish", limitGuestWrites, (req, res) => {
    const session = db.prepare("SELECT * FROM fleet_tuning_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "调参会话不存在" });
    if (!canAccessSession(req, session)) return res.status(403).json({ error: "无权结束该调参会话" });
    const before = db.prepare(`
      SELECT * FROM fleet_configuration_snapshots
      WHERE session_id = ? AND snapshot_type = 'before'
      ORDER BY sequence_number ASC LIMIT 1
    `).get(session.id);
    const after = db.prepare(`
      SELECT * FROM fleet_configuration_snapshots
      WHERE session_id = ? AND snapshot_type = 'after'
      ORDER BY sequence_number DESC LIMIT 1
    `).get(session.id);
    if (!before || !after) return res.status(409).json({ error: "结束前必须同时保存调参前和调参后快照" });
    const now = Date.now();
    const diff = diffConfigurations(before.content, after.content, after.content_format);
    if (diff.summary.total === 0) {
      inTransaction(() => {
        db.prepare("DELETE FROM fleet_tuning_events WHERE session_id = ?").run(session.id);
        db.prepare("DELETE FROM fleet_configuration_snapshots WHERE session_id = ?").run(session.id);
        db.prepare("DELETE FROM fleet_tuning_sessions WHERE id = ?").run(session.id);
      });
      audit(req, "discard_unchanged_tuning_session", "tuning_session", session.id);
      return res.json({ ok: true, deleted: true, endedAt: now, diff });
    }
    db.prepare("UPDATE fleet_tuning_sessions SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, session.id);
    audit(req, "finish_tuning_session", "tuning_session", session.id, { diffSummary: diff.summary });
    res.json({ ok: true, deleted: false, endedAt: now, beforeSnapshotId: before.id, afterSnapshotId: after.id, diff });
  });

  app.get("/api/ground-station/history", requireMember, (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const rows = db.prepare(`
      SELECT st.*, a.serial_number, p.name AS owner_name, fc.device_uid,
        fc.board_identifier AS controller_board_identifier,
        fc.board_name AS controller_board_name
      FROM fleet_aircraft_states st
      LEFT JOIN fleet_aircraft a ON a.id = st.aircraft_id
      LEFT JOIN fleet_pilots p ON p.id = a.owner_pilot_id
      LEFT JOIN fleet_flight_controllers fc ON fc.id = st.flight_controller_id
      ORDER BY st.created_at DESC
      LIMIT ?
    `).all(limit);
    const previousState = db.prepare("SELECT content, content_format FROM fleet_aircraft_states WHERE id = ?");
    res.json(rows.map((row) => {
      const previous = row.previous_state_id ? previousState.get(row.previous_state_id) : null;
      const diff = previous?.content_format === row.content_format
        ? diffConfigurations(previous.content, row.content, row.content_format)
        : null;
      return aircraftStateFromRow(row, diff);
    }));
  });

  app.delete("/api/ground-station/history/:id", requireCoach, (req, res) => {
    const existing = db.prepare(
      "SELECT id, previous_state_id FROM fleet_aircraft_states WHERE id = ?",
    ).get(req.params.id);
    if (!existing) return res.status(404).json({ error: "飞机状态版本不存在" });
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE fleet_aircraft_states SET previous_state_id = ? WHERE previous_state_id = ?",
      ).run(existing.previous_state_id || null, existing.id);
      db.prepare("DELETE FROM fleet_aircraft_states WHERE id = ?").run(existing.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit(req, "delete_aircraft_state", "aircraft_state", existing.id);
    res.json({ ok: true });
  });

  app.get("/api/ground-station/sessions/:id", requireMember, (req, res) => {
    const session = db.prepare("SELECT * FROM fleet_tuning_sessions WHERE id = ?").get(req.params.id);
    if (!session) return res.status(404).json({ error: "调参会话不存在" });
    const snapshots = db.prepare(`
      SELECT id, snapshot_type, sequence_number, content_format, content_hash, metadata_json, created_at
      FROM fleet_configuration_snapshots WHERE session_id = ?
      ORDER BY sequence_number
    `).all(session.id);
    const events = db.prepare(`
      SELECT id, sequence_number, event_type, domain, msp_code, msp_name,
        payload_json, committed, created_at
      FROM fleet_tuning_events
      WHERE session_id = ?
      ORDER BY sequence_number, created_at
    `).all(session.id);
    const before = db.prepare(`
      SELECT content, content_format FROM fleet_configuration_snapshots
      WHERE session_id = ? AND snapshot_type = 'before' ORDER BY sequence_number LIMIT 1
    `).get(session.id);
    const after = db.prepare(`
      SELECT content, content_format FROM fleet_configuration_snapshots
      WHERE session_id = ? AND snapshot_type = 'after' ORDER BY sequence_number DESC LIMIT 1
    `).get(session.id);
    res.json({
      id: session.id,
      aircraftId: session.aircraft_id,
      flightControllerId: session.flight_controller_id,
      operatorRole: session.operator_role,
      operatorLabel: session.operator_label,
      purpose: session.purpose,
      status: session.status,
      firmwareVersion: session.firmware_version,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      snapshots: snapshots.map((row) => ({
        id: row.id,
        snapshotType: row.snapshot_type,
        sequenceNumber: row.sequence_number,
        contentFormat: row.content_format,
        contentHash: row.content_hash,
        metadata: json(row.metadata_json),
        createdAt: row.created_at,
      })),
      events: events.map((row) => ({
        id: row.id,
        sequenceNumber: row.sequence_number,
        eventType: row.event_type,
        domain: row.domain,
        mspCode: row.msp_code,
        mspName: row.msp_name,
        payload: json(row.payload_json),
        committed: Boolean(row.committed),
        createdAt: row.created_at,
      })),
      diff: before && after ? diffConfigurations(before.content, after.content, after.content_format) : null,
    });
  });

  app.post("/api/ground-station/preset-match", (req, res) => {
    const role = roleFromRequest(req);
    const content = String(req.body?.content || "");
    const contentFormat = req.body?.contentFormat === "json" ? "json" : "betaflight_cli";
    const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
    const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
    const buildKey = cleanText(req.body?.buildKey, 160);
    if (!content.trim()) return res.status(400).json({ error: "当前配置不能为空" });
    if (!boardIdentifier || !firmwareVersion) return res.status(400).json({ error: "无法识别当前飞控 target 或固件版本" });
    if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) return res.status(413).json({ error: "当前配置不能超过 2MB" });

    const previewDisplaySettings = readDisplaySettings(db);
    const excludedDiffFields = previewDisplaySettings.excludedDiffFields || [];

    const catalog = db.prepare(`
      ${presetSelect}
      WHERE pr.board_identifier = ?
        AND pr.firmware_version = ?
        AND (pr.firmware_build_key = '' OR (? <> '' AND pr.firmware_build_key = ?))
        AND (pr.published = 1 OR ? = 'coach')
      ORDER BY pr.updated_at DESC
    `).all(boardIdentifier, firmwareVersion, buildKey, buildKey, role)
      .map((row) => ({
        row,
        comparableContent: presetContentForFormat(row, contentFormat),
      }))
      .filter((candidate) => candidate.comparableContent.trim())
      .map((candidate) => ({
        row: candidate.row,
        diff: diffConfigurations(candidate.comparableContent, content, contentFormat, excludedDiffFields),
      }));
    const candidates = [...catalog].sort((left, right) => (
      left.diff.summary.total - right.diff.summary.total
      || right.row.updated_at - left.row.updated_at
    ));

    const reference = candidates[0] || null;
    const latestBaseline = catalog
      .filter((candidate) => candidate.row.kind === "team_baseline")
      .sort((left, right) => (
        right.row.version_number - left.row.version_number
        || right.row.updated_at - left.row.updated_at
      ))[0] || null;
    const latestAdvancedPreset = db.prepare(`
      ${presetSelect}
      WHERE pr.board_identifier = ?
        AND pr.firmware_version = ?
        AND pr.raw_cli_text <> ''
        AND (pr.firmware_build_key = '' OR (? <> '' AND pr.firmware_build_key = ?))
        AND (pr.published = 1 OR ? = 'coach')
      ORDER BY pr.updated_at DESC
      LIMIT 1
    `).get(boardIdentifier, firmwareVersion, buildKey, buildKey, role);
    const aircraftId = cleanText(req.body?.aircraftId, 160);
    const ownerPilotId = cleanText(req.body?.ownerPilotId, 200);
    const latestAircraftState = db.prepare(`
      SELECT content, content_format, created_at AS ended_at
      FROM fleet_aircraft_states
      WHERE aircraft_id = ?
        AND firmware_version = ?
        AND board_identifier = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const comparisonStateSpecified = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "comparisonStateId",
    );
    const comparisonStateId = cleanText(req.body?.comparisonStateId, 160);
    const selectedComparisonState = comparisonStateSpecified && comparisonStateId && role !== "guest" && aircraftId
      ? db.prepare(`
          SELECT content, content_format, created_at AS ended_at
          FROM fleet_aircraft_states
          WHERE id = ?
            AND aircraft_id = ?
            AND firmware_version = ?
            AND board_identifier = ?
          LIMIT 1
        `).get(comparisonStateId, aircraftId, firmwareVersion, boardIdentifier)
      : null;
    const previous = role !== "guest" && aircraftId
      ? (
          comparisonStateSpecified
            ? selectedComparisonState
            : latestAircraftState.get(aircraftId, firmwareVersion, boardIdentifier)
        )
      : null;
    const previousDiff = previous?.content_format === contentFormat
      ? diffConfigurations(previous.content, content, contentFormat, excludedDiffFields)
      : null;
    const otherAircraft = [];
    if (role !== "guest" && ownerPilotId) {
      const ownedAircraft = db.prepare(`
        SELECT a.id, a.serial_number, fc.board_identifier, fc.board_name, fc.firmware_version
        FROM fleet_aircraft a
        LEFT JOIN fleet_aircraft_controllers afc
          ON afc.aircraft_id = a.id AND afc.removed_at IS NULL
        LEFT JOIN fleet_flight_controllers fc ON fc.id = afc.flight_controller_id
        WHERE a.owner_pilot_id = ? AND a.status = 'active' AND a.id <> ?
        ORDER BY a.serial_number
      `).all(ownerPilotId, aircraftId || "");
      for (const aircraft of ownedAircraft) {
        const aircraftTarget = aircraft.board_identifier || aircraft.board_name || "";
        const comparable = (
          aircraft.firmware_version === firmwareVersion
          && (aircraft.board_identifier === boardIdentifier || aircraft.board_name === boardIdentifier)
        );
        const archived = comparable
          ? latestAircraftState.get(
            aircraft.id,
            firmwareVersion,
            boardIdentifier,
          )
          : null;
        const archivedDiff = archived?.content_format === contentFormat
          ? diffConfigurations(archived.content, content, contentFormat, excludedDiffFields)
          : null;
        otherAircraft.push({
          aircraftId: aircraft.id,
          serialNumber: aircraft.serial_number,
          boardIdentifier: aircraftTarget,
          firmwareVersion: aircraft.firmware_version || "",
          comparable,
          differenceCount: archivedDiff?.summary.total ?? null,
          diff: archivedDiff,
        });
      }
    }

    res.json({
      matchType: reference ? (reference.diff.summary.total === 0 ? "exact" : "closest") : "none",
      preset: reference ? presetFromRow(reference.row) : null,
      candidateCount: candidates.length,
      differenceCount: reference?.diff.summary.total ?? null,
      important: summarizeConfiguration(content, contentFormat),
      checklist: configurationChecklist(content, contentFormat),
      configuredDisplay: configuredDisplay(content, contentFormat, previewDisplaySettings),
      advancedConfiguration: latestAdvancedPreset ? {
        presetId: latestAdvancedPreset.id,
        status: latestAdvancedPreset.calibration_status || "pending",
        coveragePercent: Number(latestAdvancedPreset.coverage_percent) || 0,
        unmappedCount: json(latestAdvancedPreset.unmapped_cli_json, []).length,
        consistency: json(latestAdvancedPreset.consistency_json, {}),
        auditedAt: latestAdvancedPreset.updated_at,
      } : {
        status: "unchecked",
        coveragePercent: 0,
        unmappedCount: 0,
        auditedAt: null,
      },
      differences: {
        baseline: latestBaseline ? {
          preset: presetFromRow(latestBaseline.row),
          differenceCount: latestBaseline.diff.summary.total,
          diff: latestBaseline.diff,
        } : null,
        previous: previousDiff ? {
          differenceCount: previousDiff.summary.total,
          endedAt: previous.ended_at,
          diff: previousDiff,
        } : null,
        otherAircraft,
      },
    });
  });

  app.post("/api/ground-station/compare", (req, res) => {
    const role = roleFromRequest(req);
    const content = String(req.body?.content || "");
    const contentFormat = req.body?.contentFormat === "json" ? "json" : "betaflight_cli";
    if (!content.trim()) return res.status(400).json({ error: "当前配置不能为空" });
    if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) return res.status(413).json({ error: "当前配置不能超过 2MB" });
    const targetType = cleanText(req.body?.targetType, 30) || "baseline";
    let target;
    let targetLabel;

    if (targetType === "baseline" || targetType === "preset") {
      const presetId = cleanText(req.body?.presetId, 160);
      const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
      const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
      const row = targetType === "preset" && presetId
        ? db.prepare("SELECT * FROM fleet_configuration_presets WHERE id = ? AND (published = 1 OR ? = 'coach')").get(presetId, role)
        : db.prepare(`
          SELECT * FROM fleet_configuration_presets
          WHERE kind = 'team_baseline'
            AND (published = 1 OR ? = 'coach')
            AND board_identifier = ?
            AND firmware_version = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(role, boardIdentifier, firmwareVersion);
      if (!row) {
        return res.status(404).json({
          error: targetType === "baseline"
            ? `${boardIdentifier || "当前 target"} / ${firmwareVersion || "当前固件"} 尚无可比较预设`
            : "预设不存在",
        });
      }
      if (row.board_identifier !== boardIdentifier || row.firmware_version !== firmwareVersion) {
        return res.status(409).json({ error: "预设与当前飞控 target 或固件版本不一致" });
      }
      const comparablePresetContent = presetContentForFormat(row, contentFormat);
      if (!comparablePresetContent.trim()) {
        return res.status(409).json({
          error: contentFormat === "json"
            ? "该预设尚未补充 MSP 基线"
            : "该预设尚未补充 CLI 基线",
        });
      }
      target = { content: comparablePresetContent, format: contentFormat };
      targetLabel = `${row.name} · ${row.board_identifier} · ${row.firmware_version}`;
    } else {
      if (role === "guest") return res.status(403).json({ error: "需要队伍密码或教练密码" });
      const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
      const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
      let targetAircraftId = cleanText(req.body?.targetAircraftId, 160);
      if (targetType === "previous") {
        targetAircraftId = cleanText(req.body?.aircraftId, 160);
        if (!targetAircraftId) return res.status(400).json({ error: "当前飞机未入库，无法查找上次配置" });
      }
      if (targetType !== "previous" && targetType !== "aircraft") return res.status(400).json({ error: "对比目标无效" });
      const row = db.prepare(`
        SELECT st.content, st.content_format, a.serial_number, st.created_at AS ended_at
        FROM fleet_aircraft_states st
        JOIN fleet_aircraft a ON a.id = st.aircraft_id
        WHERE st.aircraft_id = ?
          AND st.board_identifier = ?
          AND st.firmware_version = ?
        ORDER BY st.created_at DESC
        LIMIT 1
      `).get(targetAircraftId, boardIdentifier, firmwareVersion);
      if (!row) return res.status(404).json({ error: "目标飞机没有相同 target 和固件版本的状态记录" });
      if (row.content_format !== contentFormat) {
        return res.status(409).json({ error: "历史快照与当前快照格式不同，不能直接比较" });
      }
      target = { content: row.content, format: row.content_format };
      targetLabel = targetType === "previous" ? `${row.serial_number} 上次状态` : `${row.serial_number} 当前状态`;
    }

    res.json({
      targetType,
      targetLabel,
      diff: diffConfigurations(target.content, content, contentFormat),
    });
  });

  app.get("/api/ground-station/presets/:id", (req, res) => {
    const role = roleFromRequest(req);
    const row = db.prepare(`${presetSelect} WHERE pr.id = ?`).get(req.params.id);
    if (!row || (!row.published && role !== "coach")) return res.status(404).json({ error: "预设不存在" });
    res.json(presetFromRow(row, true));
  });

  app.get("/api/ground-station/presets/:id/download", (req, res) => {
    const role = roleFromRequest(req);
    const row = db.prepare(`${presetSelect} WHERE pr.id = ?`).get(req.params.id);
    if (!row || (!row.published && role !== "coach")) return res.status(404).json({ error: "预设不存在" });
    const tag = row.version_label || row.created_at;
    const fileName = `${row.board_identifier}_${row.use_case_category}_${row.firmware_version}_${row.variant_category}_${tag}.txt`
      .replace(/[<>:"/\\|?*]/g, "_");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="preset.txt"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(row.raw_cli_text || row.content);
  });

  app.post("/api/ground-station/presets", requireCoach, (req, res) => {
    const content = String(req.body?.content || "");
    const contentFormat = req.body?.contentFormat === "json" ? "json" : "betaflight_cli";
    if (!content.trim()) return res.status(400).json({ error: "预设内容不能为空" });
    if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) return res.status(413).json({ error: "预设不能超过 2MB" });
    const kind = req.body?.kind === "pilot" ? "pilot" : "team_baseline";
    const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
    const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
    if (!boardIdentifier || !firmwareVersion) return res.status(400).json({ error: "必须填写飞控 target 和固件版本" });
    const parentPresetId = cleanText(req.body?.parentPresetId, 160) || null;
    const parent = parentPresetId
      ? db.prepare("SELECT * FROM fleet_configuration_presets WHERE id = ? AND kind = 'team_baseline'").get(parentPresetId)
      : null;
    if (parentPresetId && !parent) return res.status(400).json({ error: "父基线不存在" });
    if (parent && (parent.board_identifier !== boardIdentifier || parent.firmware_version !== firmwareVersion)) {
      return res.status(400).json({ error: "父基线与当前 target 或固件版本不一致" });
    }

    const pilotId = kind === "pilot" ? resolveOwnerPilotId(req.body?.pilotId) : null;
    if (kind === "pilot" && !pilotId) return res.status(400).json({ error: "个性化版本必须选择飞手" });
    if (kind === "pilot" && !parent) return res.status(400).json({ error: "个性化版本必须选择所属基线" });
    const pilot = pilotId ? db.prepare("SELECT name FROM fleet_pilots WHERE id = ?").get(pilotId) : null;
    const name = cleanText(req.body?.name, 120)
      || (kind === "pilot" ? `${pilot?.name || "飞手"} 个性` : "队伍基线");
    const rawCliText = contentFormat === "betaflight_cli"
      ? content
      : String(req.body?.rawCliText || "");
    const canonicalSnapshot = contentFormat === "json"
      ? content
      : String(req.body?.canonicalSnapshot || "");
    const firmwareFileId = cleanText(req.body?.firmwareFileId, 160) || null;
    const firmwareFile = firmwareFileId
      ? db.prepare("SELECT * FROM fleet_firmware_files WHERE id = ?").get(firmwareFileId)
      : null;
    if (firmwareFileId && !firmwareFile) return res.status(400).json({ error: "关联固件不存在" });
    if (firmwareFile && (
      firmwareFile.board_identifier !== boardIdentifier
      || firmwareFile.firmware_version !== firmwareVersion
    )) {
      return res.status(400).json({ error: "关联固件与预设 target 或固件版本不一致" });
    }
    const unmappedCommands = rawCliText ? unmappedCliCommands(rawCliText) : [];
    const consistency = compareCliAndCanonical(rawCliText, canonicalSnapshot);
    const calibrationStatus = rawCliText && canonicalSnapshot
      ? "complete"
      : canonicalSnapshot ? "msp_only" : rawCliText ? "cli_only" : "pending";
    const coveragePercent = canonicalSnapshot
      ? 100
      : Math.max(0, Math.min(99, Number(req.body?.coveragePercent) || 0));
    const useCaseCategory = cleanText(req.body?.useCaseCategory, 80) || "默认";
    const variantCategory = cleanText(req.body?.variantCategory, 80)
      || (kind === "pilot" ? "个性化" : "基准");
    const versionLabel = cleanText(req.body?.versionLabel, 80)
      || new Date().toISOString().slice(2, 10).replaceAll("-", "");
    const firmwareSource = firmwareFile?.source_type || cleanText(req.body?.firmwareSource, 30);
    const firmwareBuildKey = firmwareFile?.build_key || cleanText(req.body?.firmwareBuildKey, 160);
    const firmwareBuildTime = firmwareFile?.build_time || Number(req.body?.firmwareBuildTime) || null;
    const versionNumber = Number(db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
      FROM fleet_configuration_presets
      WHERE board_identifier = ? AND firmware_version = ? AND kind = ?
        AND COALESCE(pilot_id, '') = COALESCE(?, '')
    `).get(boardIdentifier, firmwareVersion, kind, pilotId).next_version);
    const now = Date.now();
    const id = makeId("preset");
    db.prepare(`
      INSERT INTO fleet_configuration_presets
        (id, name, description, kind, board_identifier, firmware_version,
         pilot_id, parent_preset_id, version_number, content,
         content_format, content_hash, raw_cli_text, canonical_snapshot,
         mapping_version, unmapped_cli_json, calibration_status, coverage_percent,
         use_case_category, variant_category, version_label, firmware_file_id,
         firmware_source, firmware_build_key, firmware_build_time, consistency_json,
         published, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      cleanText(req.body?.description, 1000),
      kind,
      boardIdentifier,
      firmwareVersion,
      pilotId,
      parent?.id || null,
      versionNumber,
      content,
      contentFormat,
      sha256(content),
      rawCliText,
      canonicalSnapshot,
      CONFIGURATION_MAPPING_VERSION,
      JSON.stringify(unmappedCommands),
      calibrationStatus,
      coveragePercent,
      useCaseCategory,
      variantCategory,
      versionLabel,
      firmwareFileId,
      firmwareSource,
      firmwareBuildKey,
      firmwareBuildTime,
      JSON.stringify(consistency),
      req.body?.published === false ? 0 : 1,
      requestLabel(req) || "coach",
      now,
      now,
    );
    audit(req, "create_preset_version", "configuration_preset", id, { kind, versionNumber, parentPresetId: parent?.id || null });
    res.status(201).json(presetFromRow(db.prepare(`${presetSelect} WHERE pr.id = ?`).get(id)));
  });

  app.put("/api/ground-station/presets/:id", requireCoach, (req, res) => {
    if (!db.prepare("SELECT id FROM fleet_configuration_presets WHERE id = ?").get(req.params.id)) {
      return res.status(404).json({ error: "预设不存在" });
    }
    res.status(409).json({ error: "版本记录不可覆盖，请发布一个新版本" });
  });

  app.patch("/api/ground-station/presets/:id/assets", requireCoach, (req, res) => {
    const existing = db.prepare("SELECT * FROM fleet_configuration_presets WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "预设不存在" });

    const rawCliText = Object.prototype.hasOwnProperty.call(req.body || {}, "rawCliText")
      ? String(req.body.rawCliText || "")
      : existing.raw_cli_text;
    const canonicalSnapshot = Object.prototype.hasOwnProperty.call(req.body || {}, "canonicalSnapshot")
      ? String(req.body.canonicalSnapshot || "")
      : existing.canonical_snapshot;
    if (Buffer.byteLength(rawCliText) > MAX_CONFIGURATION_BYTES
      || Buffer.byteLength(canonicalSnapshot) > MAX_CONFIGURATION_BYTES) {
      return res.status(413).json({ error: "CLI 或 MSP 基线不能超过 2MB" });
    }
    if (canonicalSnapshot.trim()) {
      const validation = validateMspSnapshot(canonicalSnapshot);
      if (!validation.valid) return res.status(422).json({ error: validation.error });
    }

    const requestedFirmwareId = Object.prototype.hasOwnProperty.call(req.body || {}, "firmwareFileId")
      ? cleanText(req.body.firmwareFileId, 160) || null
      : existing.firmware_file_id;
    const firmware = requestedFirmwareId
      ? db.prepare("SELECT * FROM fleet_firmware_files WHERE id = ?").get(requestedFirmwareId)
      : null;
    if (requestedFirmwareId && !firmware) return res.status(400).json({ error: "关联固件不存在" });
    if (firmware && (
      firmware.board_identifier !== existing.board_identifier
      || firmware.firmware_version !== existing.firmware_version
    )) {
      return res.status(400).json({ error: "关联固件与预设 target 或固件版本不一致" });
    }

    const consistency = compareCliAndCanonical(rawCliText, canonicalSnapshot);
    const status = rawCliText.trim() && canonicalSnapshot.trim()
      ? "complete"
      : canonicalSnapshot.trim() ? "msp_only" : rawCliText.trim() ? "cli_only" : "pending";
    const primaryContent = canonicalSnapshot.trim() || rawCliText;
    const primaryFormat = canonicalSnapshot.trim() ? "json" : "betaflight_cli";
    const unmapped = rawCliText.trim() ? unmappedCliCommands(rawCliText) : [];
    const now = Date.now();
    db.prepare(`
      UPDATE fleet_configuration_presets
      SET content = ?,
          content_format = ?,
          content_hash = ?,
          raw_cli_text = ?,
          canonical_snapshot = ?,
          mapping_version = ?,
          unmapped_cli_json = ?,
          calibration_status = ?,
          coverage_percent = ?,
          firmware_file_id = ?,
          firmware_source = ?,
          firmware_build_key = ?,
          firmware_build_time = ?,
          consistency_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      primaryContent,
      primaryFormat,
      sha256(primaryContent),
      rawCliText,
      canonicalSnapshot,
      CONFIGURATION_MAPPING_VERSION,
      JSON.stringify(unmapped),
      status,
      canonicalSnapshot.trim() ? 100 : 0,
      requestedFirmwareId,
      firmware?.source_type || existing.firmware_source || "",
      firmware?.build_key || existing.firmware_build_key || "",
      firmware?.build_time || existing.firmware_build_time || null,
      JSON.stringify(consistency),
      now,
      existing.id,
    );
    audit(req, "update_preset_assets", "configuration_preset", existing.id, {
      hasCli: Boolean(rawCliText.trim()),
      hasMsp: Boolean(canonicalSnapshot.trim()),
      hasFirmware: Boolean(requestedFirmwareId),
      consistency: consistency.status,
    });
    res.json(presetFromRow(db.prepare(`${presetSelect} WHERE pr.id = ?`).get(existing.id), true));
  });

  app.delete("/api/ground-station/presets/:id", requireCoach, (req, res) => {
    const result = db.prepare("DELETE FROM fleet_configuration_presets WHERE id = ?").run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: "预设不存在" });
    audit(req, "delete_preset", "configuration_preset", req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/ground-station/firmware", requireMember, (req, res) => {
    const rows = db.prepare("SELECT * FROM fleet_firmware_files ORDER BY updated_at DESC").all();
    res.json(rows.map(firmwareFromRow));
  });

  app.post("/api/ground-station/firmware", requireCoach, (req, res) => {
    const fileName = cleanText(req.body?.fileName, 180);
    const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
    const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
    if (!boardIdentifier || !firmwareVersion) return res.status(400).json({ error: "必须填写飞控 target 和固件版本" });
    const encoded = String(req.body?.contentBase64 || "").replace(/^data:[^,]+,/, "");
    if (!fileName.toLowerCase().endsWith(".hex")) return res.status(400).json({ error: "只允许上传 .hex 固件" });
    if (!encoded) return res.status(400).json({ error: "固件文件不能为空" });
    let content;
    try {
      content = Buffer.from(encoded, "base64");
    } catch {
      return res.status(400).json({ error: "固件内容格式无效" });
    }
    if (!content.length || content.length > MAX_FIRMWARE_BYTES) return res.status(413).json({ error: "固件必须介于 1B 和 8MB 之间" });
    if (!/^(?:\s*:[0-9A-Fa-f]+\s*)+$/.test(content.toString("utf8"))) {
      return res.status(400).json({ error: "文件不是有效的 Intel HEX 文本" });
    }
    const now = Date.now();
    const id = makeId("firmware");
    const sourceType = req.body?.sourceType === "cloud" ? "cloud" : "local";
    const buildKey = sourceType === "cloud" ? cleanText(req.body?.buildKey, 160) : "";
    const buildTime = Number(req.body?.buildTime) || now;
    db.prepare(`
      INSERT INTO fleet_firmware_files
        (id, file_name, board_identifier, firmware_version, size_bytes, content_hash,
         hex_content, source_type, build_key, build_time, uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fileName,
      boardIdentifier,
      firmwareVersion,
      content.length,
      sha256(content),
      content,
      sourceType,
      buildKey,
      buildTime,
      requestLabel(req) || "coach",
      now,
      now,
    );
    audit(req, "upload_firmware", "firmware", id, { fileName, sizeBytes: content.length });
    res.status(201).json(firmwareFromRow(db.prepare("SELECT * FROM fleet_firmware_files WHERE id = ?").get(id)));
  });

  app.post("/api/ground-station/firmware/metadata", requireCoach, (req, res) => {
    const boardIdentifier = cleanText(req.body?.boardIdentifier, 80);
    const firmwareVersion = cleanText(req.body?.firmwareVersion, 80);
    const buildKey = cleanText(req.body?.buildKey, 160);
    const rawBuildTime = cleanText(req.body?.buildTime, 120);
    const parsedBuildTime = Number(rawBuildTime) || Date.parse(rawBuildTime);
    const buildTime = Number.isFinite(parsedBuildTime) ? parsedBuildTime : null;
    if (!boardIdentifier || !firmwareVersion) {
      return res.status(400).json({ error: "MSP 固件资产缺少飞控 target 或固件版本" });
    }
    if (!buildKey && !buildTime) {
      return res.status(400).json({ error: "MSP 未返回 Build Key 或构建时间，无法唯一登记固件资产" });
    }
    const sourceType = buildKey ? "cloud" : "local";
    const existing = db.prepare(`
      SELECT *
      FROM fleet_firmware_files
      WHERE board_identifier = ?
        AND firmware_version = ?
        AND source_type = ?
        AND build_key = ?
        AND COALESCE(build_time, 0) = COALESCE(?, 0)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(boardIdentifier, firmwareVersion, sourceType, buildKey, buildTime);
    if (existing) return res.json(firmwareFromRow(existing));

    const now = Date.now();
    const id = makeId("firmware");
    const identity = buildKey || String(buildTime);
    const fileName = `${boardIdentifier}_${firmwareVersion}_${identity}.msp-meta`;
    const metadata = JSON.stringify({
      boardIdentifier,
      firmwareVersion,
      sourceType,
      buildKey,
      buildTime,
    });
    db.prepare(`
      INSERT INTO fleet_firmware_files
        (id, file_name, board_identifier, firmware_version, size_bytes, content_hash,
         hex_content, source_type, build_key, build_time, uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fileName,
      boardIdentifier,
      firmwareVersion,
      sha256(metadata),
      Buffer.alloc(0),
      sourceType,
      buildKey,
      buildTime,
      requestLabel(req) || "coach",
      now,
      now,
    );
    audit(req, "register_firmware_metadata", "firmware", id, {
      boardIdentifier,
      firmwareVersion,
      buildKey,
      buildTime,
    });
    res.status(201).json(firmwareFromRow(db.prepare("SELECT * FROM fleet_firmware_files WHERE id = ?").get(id)));
  });

  app.get("/api/ground-station/firmware/:id/download", requireMember, (req, res) => {
    const row = db.prepare("SELECT * FROM fleet_firmware_files WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "固件不存在" });
    if (!Number(row.size_bytes)) {
      return res.status(409).json({ error: "这是由 MSP 识别生成的固件元数据资产，没有可下载的 HEX 文件" });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${row.file_name.replace(/[^\w\s.-]/g, "_")}"`);
    res.send(row.hex_content);
  });

  app.delete("/api/ground-station/firmware/:id", requireCoach, (req, res) => {
    const result = inTransaction(() => {
      db.prepare(`
        UPDATE fleet_configuration_presets
        SET firmware_file_id = NULL,
            firmware_source = '',
            firmware_build_key = '',
            firmware_build_time = NULL,
            updated_at = ?
        WHERE firmware_file_id = ?
      `).run(Date.now(), req.params.id);
      return db.prepare("DELETE FROM fleet_firmware_files WHERE id = ?").run(req.params.id);
    });
    if (!result.changes) return res.status(404).json({ error: "固件不存在" });
    audit(req, "delete_firmware", "firmware", req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/ground-station/errors", limitGuestWrites, (req, res) => {
    const stage = cleanText(req.body?.stage, 100);
    const message = cleanText(req.body?.message, 2000);
    if (!stage || !message) return res.status(400).json({ error: "异常阶段和消息不能为空" });
    db.prepare(`
      INSERT INTO fleet_error_log (session_id, stage, message, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      cleanText(req.body?.sessionId, 160) || null,
      stage,
      message,
      JSON.stringify(req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {}),
      Date.now(),
    );
    res.status(201).json({ ok: true });
  });

  app.get("/api/ground-station/audit", requireCoach, (req, res) => {
    const rows = db.prepare("SELECT * FROM fleet_audit_log ORDER BY created_at DESC LIMIT 200").all();
    res.json(rows.map((row) => ({
      id: row.id,
      actorRole: row.actor_role,
      actorLabel: row.actor_label,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      detail: json(row.detail_json),
      ipAddress: row.ip_address,
      createdAt: row.created_at,
    })));
  });
}
