import FC from "../js/fc";
import EscProtocols from "../js/utils/EscProtocols";
import { OSD } from "../js/tabs/osd";

const AXES = ["roll", "pitch", "yaw"];

function clone(value) {
    if (value === undefined || value === null) return value;
    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_key, current) => {
        if (typeof current === "function" || typeof current === "symbol") return undefined;
        if (current && typeof current === "object") {
            if (
                current === globalThis
                || Object.prototype.toString.call(current) === "[object Window]"
                || seen.has(current)
            ) return undefined;
            seen.add(current);
        }
        return current;
    });
    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function definedRecord(value) {
    return Object.fromEntries(
        Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
    );
}

function osdConfigurationSnapshot() {
    const source = OSD.data || {};
    const alarms = Object.fromEntries(
        Object.entries(source.alarms || {}).map(([key, value]) => [
            key,
            definedRecord({ value: value?.value }),
        ]),
    );
    return clone(definedRecord({
        videoSystem: source.video_system,
        unitMode: source.unit_mode,
        alarms,
        statistics: (source.statItems || []).map((item, index) => definedRecord({
            index: item.index ?? index,
            name: item.name,
            enabled: item.enabled,
        })),
        warnings: (source.warnings || []).map((item, index) => definedRecord({
            index: item.index ?? index,
            name: item.name,
            enabled: item.enabled,
        })),
        displayItems: (source.displayItems || []).map((item, index) => definedRecord({
            index: item.index ?? index,
            name: item.name,
            position: item.position,
            visible: item.isVisible,
            variant: item.variant,
        })),
        timers: (source.timers || []).map((item, index) => definedRecord({
            index: item.index ?? index,
            source: item.src,
            precision: item.precision,
            alarm: item.alarm,
        })),
        selectedProfile: source.osd_profiles?.selected,
        overlayRadioMode: source.parameters?.overlayRadioMode,
        cameraFrameWidth: source.parameters?.cameraFrameWidth,
        cameraFrameHeight: source.parameters?.cameraFrameHeight,
    }));
}

function modeNameForId(id) {
    const index = (FC.AUX_CONFIG_IDS || []).findIndex((value) => Number(value) === Number(id));
    const name = index >= 0 ? FC.AUX_CONFIG?.[index] : "";
    return String(name || `MODE_${Number(id)}`);
}

function modeRangesSnapshot() {
    const groups = {};
    for (let index = 0; index < (FC.MODE_RANGES || []).length; index += 1) {
        const range = FC.MODE_RANGES[index] || {};
        const extra = FC.MODE_RANGES_EXTRA?.[index] || {};
        const start = Number(range.range?.start);
        const end = Number(range.range?.end);
        const linkedTo = Number(extra.linkedTo) || 0;
        if (!(start < end) && linkedTo <= 0) continue;
        const modeName = modeNameForId(range.id);
        if (!groups[modeName]) groups[modeName] = [];
        groups[modeName].push(definedRecord({
            auxChannel: linkedTo > 0 ? undefined : `AUX ${Number(range.auxChannelIndex) + 1}`,
            start: linkedTo > 0 ? undefined : start,
            end: linkedTo > 0 ? undefined : end,
            logic: Number(extra.modeLogic) === 1 ? "AND" : "OR",
            linkedTo: linkedTo > 0 ? modeNameForId(linkedTo) : undefined,
        }));
    }
    return clone(groups);
}

function systemAdvancedSnapshot() {
    const source = FC.PID_ADVANCED_CONFIG || {};
    const protocolIndex = Number(source.fast_pwm_protocol);
    return {
        gyroLoopDivider: source.gyro_sync_denom ?? null,
        pidLoopDivider: source.pid_process_denom ?? null,
        unsyncedPwm: source.use_unsyncedPwm ?? null,
        motorProtocol: EscProtocols.GetProtocolName(FC.CONFIG.apiVersion, protocolIndex) ?? protocolIndex,
        motorPwmRate: source.motor_pwm_rate ?? null,
        dshotIdlePercent: source.motorIdle ?? source.digitalIdlePercent ?? null,
        gyro32kHz: source.gyroUse32kHz ?? null,
        motorPwmInversion: source.motorPwmInversion ?? null,
        gyroHighFsr: source.gyroHighFsr ?? null,
        gyroMovementCalibrationThreshold: source.gyroMovementCalibThreshold ?? null,
        gyroCalibrationDuration: source.gyroCalibDuration ?? null,
        gyroYawOffset: source.gyroOffsetYaw ?? null,
        gyroOverflowCheck: source.gyroCheckOverflow ?? null,
        debugMode: source.debugMode ?? null,
    };
}

function pidAxes(pids) {
    const values = Array.isArray(pids) ? pids : [];
    return Object.fromEntries(AXES.map((axis, index) => {
        const terms = Array.isArray(values[index]) ? values[index] : [];
        return [axis, {
            p: terms[0] ?? null,
            i: terms[1] ?? null,
            d: terms[2] ?? null,
            f: terms[3] ?? null,
            raw: clone(terms),
        }];
    }));
}

function rateAxes(rates = {}) {
    return {
        roll: {
            rcRate: rates.RC_RATE ?? null,
            expo: rates.RC_EXPO ?? null,
            superRate: rates.roll_rate ?? rates.roll_pitch_rate ?? null,
            limit: rates.roll_rate_limit ?? null,
        },
        pitch: {
            rcRate: rates.rcPitchRate ?? rates.RC_RATE ?? null,
            expo: rates.RC_PITCH_EXPO ?? rates.RC_EXPO ?? null,
            superRate: rates.pitch_rate ?? rates.roll_pitch_rate ?? null,
            limit: rates.pitch_rate_limit ?? null,
        },
        yaw: {
            rcRate: rates.rcYawRate ?? rates.RC_RATE ?? null,
            expo: rates.RC_YAW_EXPO ?? rates.RC_EXPO ?? null,
            superRate: rates.yaw_rate ?? null,
            limit: rates.yaw_rate_limit ?? null,
        },
    };
}

export function fleetDeviceIdentity() {
    const config = FC.CONFIG;
    const target = String(config.boardName || config.targetName || config.boardIdentifier || "");
    return {
        deviceUid: String(config.deviceIdentifier || ""),
        target,
        boardIdentifier: String(config.boardIdentifier || target),
        targetName: String(config.targetName || ""),
        boardName: String(config.boardName || ""),
        hardwareName: String(config.hardwareName || ""),
        manufacturerId: String(config.manufacturerId || ""),
        firmwareVariant: String(config.flightControllerIdentifier || ""),
        firmwareVersion: String(config.flightControllerVersion || ""),
        apiVersion: String(config.apiVersion || ""),
        buildKey: String(config.buildKey || ""),
        buildTime: String(config.buildInfo || ""),
        craftName: String(config.craftName || config.name || ""),
        pilotName: String(config.pilotName || ""),
        kernel: "legacy",
    };
}

export function currentPidProfileSnapshot(index = Number(FC.CONFIG.profile) || 0) {
    return {
        index,
        name: String(FC.CONFIG.pidProfileNames?.[index] || ""),
        axes: pidAxes(FC.PIDS),
        pidsRaw: clone(FC.PIDS),
        tuning: clone(FC.ADVANCED_TUNING),
        filters: clone(FC.FILTER_CONFIG),
    };
}

export function currentRateProfileSnapshot(index = Number(FC.CONFIG.rateProfile) || 0) {
    const rates = FC.RC_TUNING || {};
    return {
        index,
        name: String(FC.CONFIG.rateProfileNames?.[index] || ""),
        axes: rateAxes(rates),
        throttle: {
            midpoint: rates.throttle_MID ?? null,
            expo: rates.throttle_EXPO ?? null,
            limitType: rates.throttleLimitType ?? null,
            limitPercent: rates.throttleLimitPercent ?? null,
        },
        ratesType: rates.rates_type ?? null,
        raw: clone(rates),
    };
}

export function createFleetSnapshot({
    pidProfiles,
    rateProfiles,
    vtxBands = [],
    vtxPowerLevels = [],
    errors = [],
    domains = [],
}) {
    const coveredDomains = domains.length ? domains : [
        "identity",
        "legacy",
        "pid",
        "rates",
        "filters",
        "motor",
        "receiver",
        "failsafe",
        "features",
        "vtx",
        "battery",
        "ports",
        "modes",
        "osd",
        "gps",
        "led",
        "sensors",
        "blackbox",
        "servos",
        "transponder",
    ];
    return {
        schemaVersion: 2,
        source: "msp",
        capturedAt: Date.now(),
        device: fleetDeviceIdentity(),
        profiles: {
            pid: clone(pidProfiles),
            rates: clone(rateProfiles),
        },
        settings: {
            mixer: clone(FC.MIXER_CONFIG),
            legacyCore: clone(FC.BF_CONFIG),
            legacyMisc: clone(FC.MISC),
            arming: clone(FC.ARMING_CONFIG),
            systemAdvanced: systemAdvancedSnapshot(),
            motor: clone(FC.MOTOR_CONFIG),
            motor3d: clone(FC.MOTOR_3D_CONFIG),
            receiver: clone(FC.RX_CONFIG),
            receiverMap: clone(FC.RC_MAP),
            receiverDeadband: clone(FC.RC_DEADBAND_CONFIG),
            receiverFailsafe: clone(FC.RXFAIL_CONFIG),
            failsafe: clone(FC.FAILSAFE_CONFIG),
            features: clone(FC.FEATURE_CONFIG),
            beeper: clone(FC.BEEPER_CONFIG),
            vtx: clone(FC.VTX_CONFIG),
            vtxTableBands: clone(vtxBands),
            vtxTablePowerLevels: clone(vtxPowerLevels),
            battery: clone(FC.BATTERY_CONFIG),
            voltageMeters: clone(FC.VOLTAGE_METER_CONFIGS),
            currentMeters: clone(FC.CURRENT_METER_CONFIGS),
            ports: clone(FC.SERIAL_CONFIG),
            modes: modeRangesSnapshot(),
            adjustments: clone(FC.ADJUSTMENT_RANGES),
            osd: osdConfigurationSnapshot(),
            gps: clone(FC.GPS_CONFIG),
            gpsRescue: clone(FC.GPS_RESCUE),
            compass: clone(FC.COMPASS_CONFIG),
            rssi: clone(FC.RSSI_CONFIG),
            ledColors: clone(FC.LED_COLORS),
            ledStrip: clone(FC.LED_STRIP),
            ledModeColors: clone(FC.LED_MODE_COLORS),
            boardAlignment: clone(FC.BOARD_ALIGNMENT_CONFIG),
            accelerometerTrims: clone(FC.CONFIG.accelerometerTrims),
            sensorAlignment: clone(FC.SENSOR_ALIGNMENT),
            sensors: clone(FC.SENSOR_CONFIG),
            blackbox: clone(FC.BLACKBOX),
            servos: clone(FC.SERVO_CONFIG),
            servoRules: clone(FC.SERVO_RULES),
            motorOutputOrder: clone(FC.MOTOR_OUTPUT_ORDER),
            transponder: clone(FC.TRANSPONDER),
        },
        coverage: {
            level: "msp-ui",
            cliComplete: false,
            domains: coveredDomains,
            errors: clone(errors),
        },
    };
}
