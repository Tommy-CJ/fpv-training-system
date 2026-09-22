import MSPCodes from "../js/msp/MSPCodes";
import { emitFleetEvent } from "./FleetEventBus";
import { FleetEvent } from "./FleetContract";

const NON_CONFIGURATION_WRITES = new Set([
    "MSP_SET_RTC",
    "MSP_SET_REBOOT",
    "MSP_ARMING_DISABLE",
    "MSP_SET_RAW_RC",
    "MSP_ACC_CALIBRATION",
    "MSP_MAG_CALIBRATION",
    "MSP_SET_HEADING",
    "MSP_SET_MOTOR",
    "MSP_SET_4WAY_IF",
    "MSP2_BETAFLIGHT_BIND",
    "MSP2_SEND_DSHOT_COMMAND",
]);
const codeNames = new Map();
for (const [name, code] of Object.entries(MSPCodes)) {
    if (
        typeof code === "number"
        && (
            name === "MSP_SET_REBOOT"
            || (
                !NON_CONFIGURATION_WRITES.has(name)
                && (name.startsWith("MSP_SET_") || name.startsWith("MSP2_SET_") || name === "MSP_EEPROM_WRITE")
            )
        )
    ) {
        codeNames.set(code, name);
    }
}

const dirtyDomains = new Set();
let commitSnapshotProvider = null;

function domainForName(name) {
    const normalized = name.toUpperCase();
    const rules = [
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
    return rules.find(([fragment]) => normalized.includes(fragment))?.[1] || "other";
}

export function setFleetCommitSnapshotProvider(provider) {
    commitSnapshotProvider = provider;
}

function payloadPreview(data) {
    const bytes = data ? Array.from(data) : [];
    return {
        byteLength: bytes.length,
        bytes: bytes.slice(0, 512),
        truncated: bytes.length > 512,
    };
}

export function wrapFleetMspCallback(code, data, callback) {
    const name = codeNames.get(code);
    if (!name) return callback;
    const operation = {
        code,
        name,
        startedAt: Date.now(),
        payload: payloadPreview(data),
    };
    const rebootType = Number(operation.payload.bytes[0] || 0);
    if (name === "MSP_SET_REBOOT" && rebootType === 0) {
        // A successful reboot usually closes USB before an ACK is received.
        // Non-zero reboot modes belong to bootloader / mass-storage transports
        // and must not race the fleet Agent's ordinary MSP reconnect loop.
        emitFleetEvent(FleetEvent.CONTROLLER_REBOOT, {
            ...operation,
            dispatchedAt: operation.startedAt,
        });
    } else if (name !== "MSP_EEPROM_WRITE") {
        // Record queued writes immediately so batched OSD writes are never lost.
        const domain = domainForName(name);
        dirtyDomains.add(domain);
        emitFleetEvent(FleetEvent.CONFIGURATION_WRITE, {
            ...operation,
            dispatchedAt: operation.startedAt,
            domain,
        });
    }
    return (response, error) => {
        if (error) {
            emitFleetEvent(FleetEvent.OPERATION_ERROR, {
                stage: "msp-write",
                operation,
                message: String(error?.message || error),
            });
        } else if (name === "MSP_EEPROM_WRITE") {
            const domains = [...dirtyDomains];
            let snapshot = null;
            let verificationError = "";
            const requiresReadback = domains.includes("osd");
            if (domains.length && commitSnapshotProvider && !requiresReadback) {
                try {
                    snapshot = commitSnapshotProvider(domains);
                } catch (verifyError) {
                    verificationError = String(verifyError?.message || verifyError);
                }
            }
            emitFleetEvent(FleetEvent.CONFIGURATION_COMMIT, {
                ...operation,
                completedAt: Date.now(),
                domains,
                snapshot,
                verificationError,
                verification: requiresReadback ? "readback-required" : "eeprom-ack",
            });
            dirtyDomains.clear();
        }
        callback?.(response, error);
    };
}
