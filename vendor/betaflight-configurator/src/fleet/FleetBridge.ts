import semver from "semver";
import CONFIGURATOR, { API_VERSION_1_45 } from "../js/data_storage";
import FC from "../js/fc";
import MSP from "../js/msp";
import MSPCodes from "../js/msp/MSPCodes";
import { mspHelper } from "../js/msp/MSPHelper";
import { getConnectionState } from "../js/connection_state";
import GUI from "../js/gui";
import { isMspCliSupported, readDumpAll } from "../composables/useMspCliSession";
import { fleetDeviceIdentity } from "./FleetCanonicalSnapshot";
import { onFleetEvent } from "./FleetEventBus";
import { setFleetCommitSnapshotProvider } from "./FleetMspTracker";
import { FleetCommand, FleetEvent, fleetEnvelope, isFleetCommand } from "./FleetContract";
import { captureFleetSnapshotFromMemory, readFleetSnapshot } from "./FleetSnapshotReader";

let initialized = false;
let lastPhase = "";
let lastIdentityKey = "";
let lastConnected = false;
let pollTimer: number | null = null;

function installFleetShell() {
    document.documentElement.dataset.fleetMode = "true";
    if (document.getElementById("fleet-shell-style")) return;
    const style = document.createElement("style");
    style.id = "fleet-shell-style";
    style.textContent = `
        /* Connection ownership belongs to the surrounding fleet Agent. */
        .sidebar-connect,
        a[target="_blank"],
        button[aria-label*="documentation" i] {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
}

function postEvent(event: string, payload: unknown = {}) {
    if (window.parent === window) return;
    window.parent.postMessage(fleetEnvelope("event", { event, payload }), window.location.origin);
}

function stateSnapshot() {
    const phase = getConnectionState().state;
    return {
        ready: true,
        phase,
        connected: CONFIGURATOR.connectionValid === true,
        flashing: GUI.flashingInProgress === true,
        device: fleetDeviceIdentity(),
    };
}

function monitorConnection() {
    const state = stateSnapshot();
    if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        postEvent(FleetEvent.CONNECTION_PHASE, {
            phase: state.phase,
            connected: state.connected,
        });
    }
    if (lastConnected && !state.connected) {
        lastIdentityKey = "";
        postEvent(FleetEvent.CONNECTION_CLOSED, { phase: state.phase });
    }
    lastConnected = state.connected;

    if (state.connected && (state.device.deviceUid || state.device.target || state.device.firmwareVersion)) {
        const identityKey = [
            state.device.deviceUid,
            state.device.target,
            state.device.firmwareVersion,
        ].join(":");
        if (identityKey !== lastIdentityKey) {
            lastIdentityKey = identityKey;
            postEvent(FleetEvent.DEVICE_IDENTIFIED, state.device);
        }
    }
}

async function setCraftName(payload: Record<string, unknown>) {
    const craftName = String(payload.craftName || "").trim();
    if (!craftName || craftName.length > 32) throw new Error("飞行器名称长度必须为 1～32");
    if (semver.gte(FC.CONFIG.apiVersion, API_VERSION_1_45)) {
        FC.CONFIG.craftName = craftName;
        await MSP.promise(
            MSPCodes.MSP2_SET_TEXT,
            mspHelper.crunch(MSPCodes.MSP2_SET_TEXT, MSPCodes.CRAFT_NAME),
        );
    } else {
        FC.CONFIG.name = craftName;
        await MSP.promise(MSPCodes.MSP_SET_NAME, mspHelper.crunch(MSPCodes.MSP_SET_NAME));
    }
    return { craftName };
}

async function setVtxChannel(payload: Record<string, unknown>) {
    const band = Number(payload.band);
    const channel = Number(payload.channel);
    const power = payload.power === undefined ? Number(FC.VTX_CONFIG.vtx_power) : Number(payload.power);
    if (!Number.isInteger(band) || band < 1 || band > 8) throw new Error("图传频段无效");
    if (!Number.isInteger(channel) || channel < 1 || channel > 8) throw new Error("图传频道无效");
    FC.VTX_CONFIG.vtx_band = band;
    FC.VTX_CONFIG.vtx_channel = channel;
    if (Number.isInteger(power) && power > 0) FC.VTX_CONFIG.vtx_power = power;
    await MSP.promise(MSPCodes.MSP_SET_VTX_CONFIG, mspHelper.crunch(MSPCodes.MSP_SET_VTX_CONFIG));
    return {
        band: FC.VTX_CONFIG.vtx_band,
        channel: FC.VTX_CONFIG.vtx_channel,
        power: FC.VTX_CONFIG.vtx_power,
    };
}

async function setThrottleLimit(payload: Record<string, unknown>) {
    const percentRaw = Number(payload.percent);
    const type = payload.type === undefined ? 1 : Number(payload.type);
    if (!Number.isInteger(percentRaw) || percentRaw < 25 || percentRaw > 100) {
        throw new Error("油门限制需为 25～100 的整数百分比");
    }
    if (!Number.isInteger(type) || type < 0 || type > 2) {
        throw new Error("油门限制类型无效");
    }
    // Firmware reports how many rate profiles actually exist; never assume a
    // fixed count, so we cannot address a rate profile the board rejects.
    const rateProfileCount = Math.max(1, Math.min(6, Number(FC.CONFIG.numberOfRateProfiles) || 1));
    const activeRateProfile = Number(FC.CONFIG.rateProfile) || 0;
    const updated: number[] = [];
    for (let index = 0; index < rateProfileCount; index += 1) {
        FC.CONFIG.rateProfile = index;
        await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [index | 128]);
        await MSP.promise(MSPCodes.MSP_RC_TUNING);
        FC.RC_TUNING.throttleLimitType = type;
        FC.RC_TUNING.throttleLimitPercent = percentRaw;
        await MSP.promise(MSPCodes.MSP_SET_RC_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_RC_TUNING));
        updated.push(index);
    }
    // Restore the rate profile that was active before the sweep.
    FC.CONFIG.rateProfile = activeRateProfile;
    await MSP.promise(MSPCodes.MSP_SELECT_SETTING, [activeRateProfile | 128]);
    await MSP.promise(MSPCodes.MSP_RC_TUNING);
    return { percent: percentRaw, type, rateProfiles: updated };
}

async function executeCommand(command: string, payload: Record<string, unknown> = {}) {
    switch (command) {
        case FleetCommand.STATE_GET:
            return stateSnapshot();
        case FleetCommand.SNAPSHOT_CAPTURE:
            if (!CONFIGURATOR.connectionValid) throw new Error("飞控尚未连接");
            return readFleetSnapshot({ domains: Array.isArray(payload.domains) ? payload.domains.map(String) : [] });
        case FleetCommand.CONNECTION_CONNECT: {
            if (!CONFIGURATOR.connectionValid) {
                const { connectDisconnect } = await import("../js/serial_backend");
                connectDisconnect();
            }
            return { ok: true };
        }
        case FleetCommand.CONNECTION_DISCONNECT: {
            if (CONFIGURATOR.connectionValid || getConnectionState().linkOpen) {
                const { connectDisconnect, disconnectForReboot } = await import("../js/serial_backend");
                if (payload.force === true) disconnectForReboot();
                else connectDisconnect();
            }
            return { ok: true };
        }
        case FleetCommand.SETTING_SET_CRAFT_NAME:
            return setCraftName(payload);
        case FleetCommand.SETTING_SET_VTX_CHANNEL:
            return setVtxChannel(payload);
        case FleetCommand.SETTING_SET_THROTTLE_LIMIT:
            return setThrottleLimit(payload);
        case FleetCommand.CONFIGURATION_COMMIT:
            await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
            return { ok: true };
        case FleetCommand.CLI_DIFF_ALL:
            if (!isMspCliSupported()) throw new Error("当前固件不支持后台 MSP CLI");
            return { content: (await readDumpAll()).join("\n"), format: "betaflight_cli" };
        default:
            throw new Error(`不支持的 Fleet 命令：${command}`);
    }
}

async function handleMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    if (!isFleetCommand(event.data)) return;
    const request = event.data;
    try {
        const result = await executeCommand(request.command, request.payload || {});
        window.parent.postMessage(fleetEnvelope("response", {
            requestId: request.requestId,
            ok: true,
            result,
        }), window.location.origin);
    } catch (error) {
        postEvent(FleetEvent.OPERATION_ERROR, {
            stage: request.command,
            message: String((error as Error)?.message || error),
        });
        window.parent.postMessage(fleetEnvelope("response", {
            requestId: request.requestId,
            ok: false,
            error: String((error as Error)?.message || error),
        }), window.location.origin);
    }
}

export function notifyFleetApiDetected(apiVersion: string, firmwareVersion = "") {
    const match = String(apiVersion || "").match(/^1\.(\d+)/);
    const minor = match ? Number(match[1]) : 0;
    const parsedFirmware = semver.coerce(String(firmwareVersion || ""));
    const legacyByFirmware = Boolean(parsedFirmware && semver.lt(parsedFirmware, "4.5.4"));
    const legacyByApi = minor > 0 && minor < 44;
    if (legacyByFirmware || legacyByApi) {
        postEvent(FleetEvent.KERNEL_SWITCH_REQUIRED, {
            apiVersion,
            firmwareVersion,
            currentKernel: "modern",
            requiredKernel: minor >= 41 ? "legacy" : null,
            reason: minor >= 41
                ? `固件 ${firmwareVersion || apiVersion} 将切换到 Legacy 10.10 内核`
                : "当前固件低于车队地面站支持的最低 API 1.41",
        });
    }
}

export function initializeFleetBridge() {
    if (initialized) return;
    initialized = true;
    installFleetShell();
    setFleetCommitSnapshotProvider((domains) => captureFleetSnapshotFromMemory(domains));
    window.addEventListener("message", handleMessage);
    onFleetEvent("*", (event) => {
        const value = event as { eventName: string; payload: unknown };
        postEvent(value.eventName, value.payload);
    });
    pollTimer = window.setInterval(monitorConnection, 200);
    postEvent(FleetEvent.BRIDGE_READY, {
        kernel: "modern",
        apiMin: "1.44.0",
        apiMax: "1.48.0",
    });
    monitorConnection();
}

export function shutdownFleetBridgeForTests() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
    window.removeEventListener("message", handleMessage);
    setFleetCommitSnapshotProvider(null);
    lastConnected = false;
    lastIdentityKey = "";
    lastPhase = "";
    initialized = false;
}
