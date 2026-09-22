export const FLEET_BRIDGE_CHANNEL = "fpv-fleet-betaflight";
export const FLEET_SCHEMA_VERSION = 1;
export const FLEET_KERNEL_ID = "modern";

export const FleetEvent = Object.freeze({
    BRIDGE_READY: "bridge.ready",
    CONNECTION_PHASE: "connection.phase",
    DEVICE_IDENTIFIED: "device.identified",
    KERNEL_SWITCH_REQUIRED: "kernel.switch-required",
    CONFIGURATION_WRITE: "configuration.write",
    CONFIGURATION_COMMIT: "configuration.commit",
    CONTROLLER_REBOOT: "controller.reboot",
    CONNECTION_CLOSED: "connection.closed",
    SNAPSHOT_PROGRESS: "snapshot.progress",
    SNAPSHOT_COMPLETED: "snapshot.completed",
    OPERATION_ERROR: "operation.error",
});

export const FleetCommand = Object.freeze({
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

export function fleetEnvelope(kind: "event" | "response", body: Record<string, unknown>) {
    return {
        channel: FLEET_BRIDGE_CHANNEL,
        schemaVersion: FLEET_SCHEMA_VERSION,
        kind,
        kernel: FLEET_KERNEL_ID,
        ...body,
    };
}

export function isFleetCommand(value: unknown): value is {
    channel: string;
    schemaVersion: number;
    kind: "command";
    requestId: string;
    command: string;
    payload?: Record<string, unknown>;
} {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        candidate.channel === FLEET_BRIDGE_CHANNEL
        && candidate.schemaVersion === FLEET_SCHEMA_VERSION
        && candidate.kind === "command"
        && typeof candidate.requestId === "string"
        && typeof candidate.command === "string"
    );
}
