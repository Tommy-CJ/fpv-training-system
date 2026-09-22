import FC from "../js/fc";
import MSP from "../js/msp";
import MSPCodes from "../js/msp/MSPCodes";
import { OSD } from "../components/tabs/osd/osd";
import {
    createFleetSnapshot,
    currentPidProfileSnapshot,
    currentRateProfileSnapshot,
    fleetDeviceIdentity,
} from "./FleetCanonicalSnapshot";
import { emitFleetEvent } from "./FleetEventBus";
import { FleetEvent } from "./FleetContract";

const PID_PROFILE_COMMANDS = [
    MSPCodes.MSP_PIDNAMES,
    MSPCodes.MSP_PID,
    MSPCodes.MSP_PID_ADVANCED,
    MSPCodes.MSP_FILTER_CONFIG,
    MSPCodes.MSP_RC_DEADBAND,
];

const GENERAL_COMMANDS = [
    MSPCodes.MSP_BF_CONFIG,
    MSPCodes.MSP_MISC,
    MSPCodes.MSP_MIXER_CONFIG,
    MSPCodes.MSP_ARMING_CONFIG,
    MSPCodes.MSP_ADVANCED_CONFIG,
    MSPCodes.MSP_MOTOR_CONFIG,
    MSPCodes.MSP_MOTOR_3D_CONFIG,
    MSPCodes.MSP_RX_CONFIG,
    MSPCodes.MSP_RX_MAP,
    MSPCodes.MSP_RXFAIL_CONFIG,
    MSPCodes.MSP_FAILSAFE_CONFIG,
    MSPCodes.MSP_FEATURE_CONFIG,
    MSPCodes.MSP_BEEPER_CONFIG,
    MSPCodes.MSP_VTX_CONFIG,
    MSPCodes.MSP_BATTERY_CONFIG,
    MSPCodes.MSP_VOLTAGE_METER_CONFIG,
    MSPCodes.MSP_CURRENT_METER_CONFIG,
    MSPCodes.MSP_CF_SERIAL_CONFIG,
    MSPCodes.MSP_BOXNAMES,
    MSPCodes.MSP_BOXIDS,
    MSPCodes.MSP_MODE_RANGES,
    MSPCodes.MSP_MODE_RANGES_EXTRA,
    MSPCodes.MSP_ADJUSTMENT_RANGES,
    MSPCodes.MSP_OSD_CANVAS,
    MSPCodes.MSP_OSD_CONFIG,
    MSPCodes.MSP_GPS_CONFIG,
    MSPCodes.MSP_GPS_RESCUE,
    MSPCodes.MSP_COMPASS_CONFIG,
    MSPCodes.MSP_RSSI_CONFIG,
    MSPCodes.MSP_LED_COLORS,
    MSPCodes.MSP_LED_STRIP_CONFIG,
    MSPCodes.MSP_LED_STRIP_MODECOLOR,
    MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG,
    MSPCodes.MSP_ACC_TRIM,
    MSPCodes.MSP_SENSOR_ALIGNMENT,
    MSPCodes.MSP_SENSOR_CONFIG,
    MSPCodes.MSP_BLACKBOX_CONFIG,
    MSPCodes.MSP_SERVO_CONFIGURATIONS,
    MSPCodes.MSP_SERVO_MIX_RULES,
    MSPCodes.MSP2_MOTOR_OUTPUT_REORDERING,
];

const GENERAL_COMMAND_DOMAINS = new Map<number, string>([
    [MSPCodes.MSP_BF_CONFIG, "legacy"],
    [MSPCodes.MSP_MISC, "legacy"],
    [MSPCodes.MSP_MIXER_CONFIG, "motor"],
    [MSPCodes.MSP_ARMING_CONFIG, "failsafe"],
    [MSPCodes.MSP_ADVANCED_CONFIG, "motor"],
    [MSPCodes.MSP_MOTOR_CONFIG, "motor"],
    [MSPCodes.MSP_MOTOR_3D_CONFIG, "motor"],
    [MSPCodes.MSP_RX_CONFIG, "receiver"],
    [MSPCodes.MSP_RX_MAP, "receiver"],
    [MSPCodes.MSP_RXFAIL_CONFIG, "failsafe"],
    [MSPCodes.MSP_FAILSAFE_CONFIG, "failsafe"],
    [MSPCodes.MSP_FEATURE_CONFIG, "features"],
    [MSPCodes.MSP_BEEPER_CONFIG, "features"],
    [MSPCodes.MSP_VTX_CONFIG, "vtx"],
    [MSPCodes.MSP_BATTERY_CONFIG, "battery"],
    [MSPCodes.MSP_VOLTAGE_METER_CONFIG, "battery"],
    [MSPCodes.MSP_CURRENT_METER_CONFIG, "battery"],
    [MSPCodes.MSP_CF_SERIAL_CONFIG, "ports"],
    [MSPCodes.MSP_BOXNAMES, "modes"],
    [MSPCodes.MSP_BOXIDS, "modes"],
    [MSPCodes.MSP_MODE_RANGES, "modes"],
    [MSPCodes.MSP_MODE_RANGES_EXTRA, "modes"],
    [MSPCodes.MSP_ADJUSTMENT_RANGES, "modes"],
    [MSPCodes.MSP_OSD_CONFIG, "osd"],
    [MSPCodes.MSP_OSD_CANVAS, "osd"],
    [MSPCodes.MSP_GPS_CONFIG, "gps"],
    [MSPCodes.MSP_GPS_RESCUE, "gps"],
    [MSPCodes.MSP_COMPASS_CONFIG, "sensors"],
    [MSPCodes.MSP_RSSI_CONFIG, "receiver"],
    [MSPCodes.MSP_LED_COLORS, "led"],
    [MSPCodes.MSP_LED_STRIP_CONFIG, "led"],
    [MSPCodes.MSP_LED_STRIP_MODECOLOR, "led"],
    [MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG, "sensors"],
    [MSPCodes.MSP_ACC_TRIM, "sensors"],
    [MSPCodes.MSP_SENSOR_ALIGNMENT, "sensors"],
    [MSPCodes.MSP_SENSOR_CONFIG, "sensors"],
    [MSPCodes.MSP_BLACKBOX_CONFIG, "blackbox"],
    [MSPCodes.MSP_SERVO_CONFIGURATIONS, "servos"],
    [MSPCodes.MSP_SERVO_MIX_RULES, "servos"],
    [MSPCodes.MSP2_MOTOR_OUTPUT_REORDERING, "motor"],
]);

const GENERAL_COMMAND_SETTINGS = new Map<number, string[]>([
    [MSPCodes.MSP_BF_CONFIG, ["legacyCore"]],
    [MSPCodes.MSP_MISC, ["legacyMisc"]],
    [MSPCodes.MSP_MIXER_CONFIG, ["mixer"]],
    [MSPCodes.MSP_ARMING_CONFIG, ["arming"]],
    [MSPCodes.MSP_ADVANCED_CONFIG, ["systemAdvanced"]],
    [MSPCodes.MSP_MOTOR_CONFIG, ["motor"]],
    [MSPCodes.MSP_MOTOR_3D_CONFIG, ["motor3d"]],
    [MSPCodes.MSP_RX_CONFIG, ["receiver"]],
    [MSPCodes.MSP_RX_MAP, ["receiverMap"]],
    [MSPCodes.MSP_RXFAIL_CONFIG, ["receiverFailsafe"]],
    [MSPCodes.MSP_FAILSAFE_CONFIG, ["failsafe"]],
    [MSPCodes.MSP_FEATURE_CONFIG, ["features"]],
    [MSPCodes.MSP_BEEPER_CONFIG, ["beeper"]],
    [MSPCodes.MSP_VTX_CONFIG, ["vtx"]],
    [MSPCodes.MSP_BATTERY_CONFIG, ["battery"]],
    [MSPCodes.MSP_VOLTAGE_METER_CONFIG, ["voltageMeters"]],
    [MSPCodes.MSP_CURRENT_METER_CONFIG, ["currentMeters"]],
    [MSPCodes.MSP_CF_SERIAL_CONFIG, ["ports"]],
    [MSPCodes.MSP_BOXNAMES, []],
    [MSPCodes.MSP_BOXIDS, []],
    [MSPCodes.MSP_MODE_RANGES, ["modes"]],
    [MSPCodes.MSP_MODE_RANGES_EXTRA, ["modeRangesExtra"]],
    [MSPCodes.MSP_ADJUSTMENT_RANGES, ["adjustments"]],
    [MSPCodes.MSP_OSD_CONFIG, ["osd"]],
    [MSPCodes.MSP_OSD_CANVAS, []],
    [MSPCodes.MSP_GPS_CONFIG, ["gps"]],
    [MSPCodes.MSP_GPS_RESCUE, ["gpsRescue"]],
    [MSPCodes.MSP_COMPASS_CONFIG, ["compass"]],
    [MSPCodes.MSP_RSSI_CONFIG, ["rssi"]],
    [MSPCodes.MSP_LED_COLORS, ["ledColors"]],
    [MSPCodes.MSP_LED_STRIP_CONFIG, ["ledStrip"]],
    [MSPCodes.MSP_LED_STRIP_MODECOLOR, ["ledModeColors"]],
    [MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG, ["boardAlignment"]],
    [MSPCodes.MSP_ACC_TRIM, ["accelerometerTrims"]],
    [MSPCodes.MSP_SENSOR_ALIGNMENT, ["sensorAlignment"]],
    [MSPCodes.MSP_SENSOR_CONFIG, ["sensors"]],
    [MSPCodes.MSP_BLACKBOX_CONFIG, ["blackbox"]],
    [MSPCodes.MSP_SERVO_CONFIGURATIONS, ["servos"]],
    [MSPCodes.MSP_SERVO_MIX_RULES, ["servoRules"]],
    [MSPCodes.MSP2_MOTOR_OUTPUT_REORDERING, ["motorOutputOrder"]],
]);

let lastFleetSnapshot: ReturnType<typeof createFleetSnapshot> | null = null;

function cachedSnapshotMatchesConnectedDevice() {
    if (!lastFleetSnapshot) return false;
    const current = fleetDeviceIdentity();
    const cached = lastFleetSnapshot.device;
    if (current.deviceUid && cached.deviceUid) return current.deviceUid === cached.deviceUid;
    return (
        current.target === cached.target
        && current.firmwareVersion === cached.firmwareVersion
    );
}

function mergeDomainSnapshot(
    previous: ReturnType<typeof createFleetSnapshot>,
    current: ReturnType<typeof createFleetSnapshot>,
    domains: Set<string>,
) {
    const merged = JSON.parse(JSON.stringify(previous));
    merged.capturedAt = current.capturedAt;
    merged.device = current.device;
    const mergeProfiles = (key: "pid" | "rates") => {
        const profiles = [...(merged.profiles[key] || [])] as Array<{ index?: number }>;
        for (const profileValue of current.profiles[key] || []) {
            const profile = profileValue as { index?: number };
            const index = Number(profile?.index);
            const existing = profiles.findIndex((item) => Number(item?.index) === index);
            if (existing >= 0) profiles[existing] = profile;
            else profiles.push(profile);
        }
        merged.profiles[key] = profiles.sort((left, right) => Number(left?.index) - Number(right?.index));
    };
    if (domains.has("pid") || domains.has("filters")) mergeProfiles("pid");
    if (domains.has("rates")) mergeProfiles("rates");
    const settingKeys: Record<string, string[]> = {
        motor: ["mixer", "systemAdvanced", "motor", "motor3d"],
        legacy: ["legacyCore", "legacyMisc"],
        failsafe: ["arming", "receiverFailsafe", "failsafe"],
        receiver: ["receiver", "receiverMap", "receiverDeadband"],
        features: ["features", "beeper"],
        vtx: ["vtx", "vtxTableBands", "vtxTablePowerLevels"],
        battery: ["battery", "voltageMeters", "currentMeters"],
        ports: ["ports"],
        modes: ["modes", "adjustments"],
        osd: ["osd"],
        gps: ["gps", "gpsRescue"],
        led: ["ledColors", "ledStrip", "ledModeColors"],
        sensors: ["boardAlignment", "accelerometerTrims", "sensorAlignment", "sensors", "compass"],
        blackbox: ["blackbox"],
        servos: ["servos", "servoRules"],
    };
    for (const domain of domains) {
        for (const key of settingKeys[domain] || []) merged.settings[key] = current.settings[key];
    }
    merged.coverage = current.coverage;
    return merged;
}

async function readCommand(
    code: number | undefined,
    errors: unknown[],
    label: string,
    data?: number[],
    maxAttempts = 2,
    responseHandler?: (response: unknown) => void,
) {
    if (typeof code !== "number") return "unsupported" as const;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await MSP.promise(code, data) as { unsupported?: boolean } | undefined;
            if (response?.unsupported) {
                errors.push({ command: label, code, unsupported: true });
                return "unsupported" as const;
            }
            responseHandler?.(response);
            return "ok" as const;
        } catch (error) {
            lastError = error;
        }
    }
    errors.push({
        command: label,
        code,
        attempts: maxAttempts,
        message: String((lastError as Error)?.message || lastError),
    });
    return "failed" as const;
}

export async function readFleetSnapshot(options: { domains?: string[] } = {}) {
    const requestedDomains = new Set(
        (Array.isArray(options.domains) ? options.domains : []).map((value) => String(value)),
    );
    const partial = requestedDomains.size > 0 && cachedSnapshotMatchesConnectedDevice();
    const errors: unknown[] = [];
    const activePidProfile = Number(FC.CONFIG.profile) || 0;
    const activeRateProfile = Number(FC.CONFIG.rateProfile) || 0;
    const pidProfileCount = Math.max(1, Math.min(4, Number(FC.CONFIG.numProfiles) || 3));
    const rateProfileCount = Math.max(1, Math.min(6, Number(FC.CONFIG.numberOfRateProfiles) || 3));
    const pidProfiles = [];
    const rateProfiles = [];
    const vtxBands = [];
    const vtxPowerLevels = [];
    const readFailures: string[] = [];
    const unavailableSettingKeys = new Set<string>();

    const readPidProfiles = !partial || requestedDomains.has("pid") || requestedDomains.has("filters");
    const readRateProfiles = !partial || requestedDomains.has("rates");
    const pidProfileIndexes = readPidProfiles
        ? (partial ? [activePidProfile] : Array.from({ length: pidProfileCount }, (_, index) => index))
        : [];
    const rateProfileIndexes = readRateProfiles
        ? (partial ? [activeRateProfile] : Array.from({ length: rateProfileCount }, (_, index) => index))
        : [];

    emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, { stage: "pid", current: 0, total: pidProfileIndexes.length });
    for (let position = 0; position < pidProfileIndexes.length; position += 1) {
        const index = pidProfileIndexes[position];
        try {
            FC.CONFIG.profile = index;
            await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [index]);
            const commandResults = new Map<number, "ok" | "unsupported" | "failed">();
            for (const code of PID_PROFILE_COMMANDS) {
                const result = await readCommand(code, errors, `pid-profile-${index}:${code}`);
                commandResults.set(code, result);
                if (code === MSPCodes.MSP_PID && result === "failed") {
                    readFailures.push(`PID Profile ${index + 1} / MSP ${code}`);
                }
            }
            if (commandResults.get(MSPCodes.MSP_PID) === "ok") {
                const profile: Record<string, unknown> = currentPidProfileSnapshot(index);
                if (commandResults.get(MSPCodes.MSP_PIDNAMES) !== "ok") delete profile.name;
                if (commandResults.get(MSPCodes.MSP_PID_ADVANCED) !== "ok") delete profile.tuning;
                if (commandResults.get(MSPCodes.MSP_FILTER_CONFIG) !== "ok") delete profile.filters;
                if (commandResults.get(MSPCodes.MSP_RC_DEADBAND) !== "ok") {
                    unavailableSettingKeys.add("receiverDeadband");
                }
                pidProfiles.push(profile);
            } else {
                errors.push({
                    stage: "pid-profile",
                    index,
                    critical: true,
                    message: `PID Profile ${index + 1} 的核心参数读取失败`,
                });
            }
        } catch (error) {
            errors.push({
                stage: "pid-profile",
                index,
                critical: true,
                message: String((error as Error)?.message || error),
            });
        }
        emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, {
            stage: "pid",
            current: position + 1,
            total: pidProfileIndexes.length,
        });
    }

    emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, { stage: "rates", current: 0, total: rateProfileIndexes.length });
    for (let position = 0; position < rateProfileIndexes.length; position += 1) {
        const index = rateProfileIndexes[position];
        try {
            FC.CONFIG.rateProfile = index;
            await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [index | 128]);
            const coreRead = await readCommand(
                MSPCodes.MSP_RC_TUNING,
                errors,
                `rate-profile-${index}:${MSPCodes.MSP_RC_TUNING}`,
            );
            if (coreRead === "ok") {
                rateProfiles.push(currentRateProfileSnapshot(index));
            } else {
                if (coreRead === "failed") readFailures.push(`Rate Profile ${index + 1}`);
                errors.push({
                    stage: "rate-profile",
                    index,
                    critical: true,
                    message: `Rate Profile ${index + 1} 的核心参数读取失败`,
                });
            }
        } catch (error) {
            errors.push({
                stage: "rate-profile",
                index,
                critical: true,
                message: String((error as Error)?.message || error),
            });
        }
        emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, {
            stage: "rates",
            current: position + 1,
            total: rateProfileIndexes.length,
        });
    }

    try {
        FC.CONFIG.profile = activePidProfile;
        await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [activePidProfile]);
        FC.CONFIG.rateProfile = activeRateProfile;
        await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [activeRateProfile | 128]);
    } catch (error) {
        errors.push({ stage: "restore-active-profile", message: String((error as Error)?.message || error) });
    }

    const missingPidProfiles = pidProfileIndexes.filter(
        (index) => !pidProfiles.some((profile) => Number(profile?.index) === index),
    );
    const missingRateProfiles = rateProfileIndexes.filter(
        (index) => !rateProfiles.some((profile) => Number(profile?.index) === index),
    );
    if (missingPidProfiles.length || missingRateProfiles.length) {
        const messages = [];
        if (missingPidProfiles.length) {
            messages.push(`PID Profile ${missingPidProfiles.map((index) => index + 1).join("、")}`);
        }
        if (missingRateProfiles.length) {
            messages.push(`Rate Profile ${missingRateProfiles.map((index) => index + 1).join("、")}`);
        }
        throw new Error(`${messages.join("，")} 读取不完整；本次状态不会保存`);
    }

    const generalCommands = partial
        ? GENERAL_COMMANDS.filter((code) => requestedDomains.has(GENERAL_COMMAND_DOMAINS.get(code) || "other"))
        : GENERAL_COMMANDS;
    emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, { stage: "general", current: 0, total: generalCommands.length });
    for (let index = 0; index < generalCommands.length; index += 1) {
        const code = generalCommands[index];
        const responseHandler = code === MSPCodes.MSP_OSD_CONFIG
            ? (response: unknown) => {
                OSD.loadDisplayFields();
                OSD.chooseFields();
                OSD.msp.decode(response);
            }
            : undefined;
        const result = await readCommand(code, errors, `general:${code}`, undefined, 2, responseHandler);
        if (result !== "ok") {
            for (const key of GENERAL_COMMAND_SETTINGS.get(code) || []) unavailableSettingKeys.add(key);
        }
        emitFleetEvent(FleetEvent.SNAPSHOT_PROGRESS, {
            stage: "general",
            current: index + 1,
            total: generalCommands.length,
        });
    }

    const readVtx = !partial || requestedDomains.has("vtx");
    for (let index = 1; readVtx && index <= Number(FC.VTX_CONFIG?.vtx_table_bands || 0); index += 1) {
        const result = await readCommand(MSPCodes.MSP_VTXTABLE_BAND, errors, `vtx-band-${index}`, [index]);
        if (result === "ok") vtxBands.push(JSON.parse(JSON.stringify(FC.VTXTABLE_BAND)));
        else {
            unavailableSettingKeys.add("vtxTableBands");
        }
    }
    for (let index = 1; readVtx && index <= Number(FC.VTX_CONFIG?.vtx_table_powerlevels || 0); index += 1) {
        const result = await readCommand(MSPCodes.MSP_VTXTABLE_POWERLEVEL, errors, `vtx-power-${index}`, [index]);
        if (result === "ok") vtxPowerLevels.push(JSON.parse(JSON.stringify(FC.VTXTABLE_POWERLEVEL)));
        else {
            unavailableSettingKeys.add("vtxTablePowerLevels");
        }
    }

    if (readFailures.length) {
        throw new Error(`MSP 配置读取不完整：${[...new Set(readFailures)].join("、")}；本次状态不会保存`);
    }

    const captured = createFleetSnapshot({
        pidProfiles,
        rateProfiles,
        vtxBands,
        vtxPowerLevels,
        errors,
        domains: partial ? [...requestedDomains] : [],
    });
    for (const key of unavailableSettingKeys) delete captured.settings[key];
    const snapshot = partial && lastFleetSnapshot
        ? mergeDomainSnapshot(lastFleetSnapshot, captured, requestedDomains)
        : captured;
    lastFleetSnapshot = snapshot;
    emitFleetEvent(FleetEvent.SNAPSHOT_COMPLETED, {
        capturedAt: snapshot.capturedAt,
        coverage: snapshot.coverage,
    });
    return snapshot;
}

export function captureFleetSnapshotFromMemory(domains: string[] = []) {
    const requestedDomains = new Set(domains.map(String).filter(Boolean));
    const previous = cachedSnapshotMatchesConnectedDevice() ? lastFleetSnapshot : null;
    if (!previous) {
        throw new Error("MSP 内存快照尚未建立；请先完成连接后的自动扫描");
    }
    const captured = createFleetSnapshot({
        pidProfiles: [currentPidProfileSnapshot()],
        rateProfiles: [currentRateProfileSnapshot()],
        vtxBands: previous?.settings?.vtxTableBands || [],
        vtxPowerLevels: previous?.settings?.vtxTablePowerLevels || [],
        errors: [],
        domains: [...requestedDomains],
    });
    captured.coverage.level = "msp-eeprom-ack";
    const snapshot = requestedDomains.size
        ? mergeDomainSnapshot(previous, captured, requestedDomains)
        : captured;
    lastFleetSnapshot = snapshot;
    return snapshot;
}
