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
const codeNames = new Map<number, string>();
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

const dirtyDomains = new Set<string>();
let commitSnapshotProvider: ((domains: string[]) => unknown) | null = null;

function domainForName(name: string) {
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

export function setFleetCommitSnapshotProvider(provider: ((domains: string[]) => unknown) | null) {
    commitSnapshotProvider = provider;
}

function payloadPreview(data: unknown) {
    if (!data) return { byteLength: 0, bytes: [] };
    const bytes = Array.from(data as ArrayLike<number>);
    return {
        byteLength: bytes.length,
        bytes: bytes.slice(0, 512),
        truncated: bytes.length > 512,
    };
}

export function wrapFleetMspCallback(
    code: number,
    data: unknown,
    callback?: (response?: unknown, error?: unknown) => void,
) {
    const name = codeNames.get(code);
    if (!name) return callback;
    const startedAt = Date.now();
    const operation = {
        code,
        name,
        startedAt,
        payload: payloadPreview(data),
    };
    const rebootType = Number(operation.payload.bytes[0] || 0);
    if (name === "MSP_SET_REBOOT" && rebootType === 0) {
        // A successful reboot normally drops USB before the FC can acknowledge
        // MSP_SET_REBOOT. Report intent when the command is dispatched so the
        // surrounding Agent can own the expected disconnect/reconnect lifecycle.
        // Non-zero reboot modes hand control to a bootloader or mass-storage
        // transport. Those flows own their handoff and must not start the
        // Agent's ordinary MSP reconnect loop in parallel.
        emitFleetEvent(FleetEvent.CONTROLLER_REBOOT, {
            ...operation,
            dispatchedAt: startedAt,
        });
    } else if (name !== "MSP_EEPROM_WRITE") {
        // Track the write as soon as it enters the MSP queue. Some pages (notably
        // OSD) batch many writes and older firmware may not return a useful ACK.
        const domain = domainForName(name);
        dirtyDomains.add(domain);
        emitFleetEvent(FleetEvent.CONFIGURATION_WRITE, {
            ...operation,
            dispatchedAt: startedAt,
            domain,
        });
    }

    return (response?: unknown, error?: unknown) => {
        if (error) {
            emitFleetEvent(FleetEvent.OPERATION_ERROR, {
                stage: "msp-write",
                operation,
                message: String((error as Error)?.message || error),
            });
        } else if (name === "MSP_EEPROM_WRITE") {
            const domains = [...dirtyDomains];
            let snapshot: unknown = null;
            let verificationError = "";
            const requiresReadback = domains.includes("osd");
            if (domains.length && commitSnapshotProvider && !requiresReadback) {
                try {
                    snapshot = commitSnapshotProvider(domains);
                } catch (verifyError) {
                    verificationError = String((verifyError as Error)?.message || verifyError);
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
