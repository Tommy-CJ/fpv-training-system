import {
  FLEET_COMMANDS,
  FLEET_EVENTS,
  FLEET_MESSAGE_KINDS,
  createFleetEnvelope,
  isFleetEnvelope,
  normalizeDeviceIdentity,
} from "./contract.js";

const DEFAULT_TIMEOUT_MS = 20_000;

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class FleetBetaflightClient {
  constructor({ iframe = null, kernel = "modern", onEvent = () => {} } = {}) {
    this.iframe = iframe;
    this.kernel = kernel;
    this.onEvent = onEvent;
    this.ready = false;
    this.state = null;
    this.pending = new Map();
    this.listeners = new Map();
    this.handleMessage = this.handleMessage.bind(this);
    window.addEventListener("message", this.handleMessage);
  }

  bindFrame(iframe, kernel = this.kernel) {
    this.rejectPending(new Error("Betaflight 内核已切换"));
    this.iframe = iframe;
    this.kernel = kernel;
    this.ready = false;
    this.state = null;
  }

  destroy() {
    window.removeEventListener("message", this.handleMessage);
    this.rejectPending(new Error("Fleet Betaflight 客户端已关闭"));
    this.listeners.clear();
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  subscribe(eventName, listener) {
    const listeners = this.listeners.get(eventName) || new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(eventName);
    };
  }

  emit(eventName, payload) {
    this.onEvent(eventName, payload);
    for (const listener of this.listeners.get(eventName) || []) listener(payload);
    for (const listener of this.listeners.get("*") || []) listener(eventName, payload);
  }

  handleMessage(event) {
    if (!this.iframe?.contentWindow || event.source !== this.iframe.contentWindow) return;
    if (event.origin !== window.location.origin) return;
    if (!isFleetEnvelope(event.data)) return;

    const message = event.data;
    if (message.kind === FLEET_MESSAGE_KINDS.RESPONSE) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Betaflight 命令执行失败"));
      return;
    }

    if (message.kind !== FLEET_MESSAGE_KINDS.EVENT) return;
    if (message.event === FLEET_EVENTS.BRIDGE_READY) this.ready = true;
    if (message.event === FLEET_EVENTS.DEVICE_IDENTIFIED) {
      this.state = {
        ...(this.state || {}),
        connected: true,
        ...normalizeDeviceIdentity(message.payload, this.kernel),
      };
    } else if (message.event === FLEET_EVENTS.CONNECTION_PHASE) {
      this.state = {
        ...(this.state || {}),
        phase: message.payload?.phase || "IDLE",
        connected: message.payload?.connected === true,
      };
    } else if (message.event === FLEET_EVENTS.CONNECTION_CLOSED) {
      this.state = { ...(this.state || {}), connected: false, phase: "IDLE" };
    }
    this.emit(message.event, message.payload);
  }

  request(command, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const target = this.iframe?.contentWindow;
    if (!target) return Promise.reject(new Error("Betaflight 镜像尚未载入"));
    const id = requestId();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Betaflight 命令超时：${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      target.postMessage(createFleetEnvelope(FLEET_MESSAGE_KINDS.COMMAND, {
        requestId: id,
        command,
        payload,
      }), window.location.origin);
    });
  }

  getState() {
    return this.request(FLEET_COMMANDS.STATE_GET);
  }

  captureSnapshot(options = {}) {
    return this.request(FLEET_COMMANDS.SNAPSHOT_CAPTURE, options, 45_000);
  }

  connect() {
    return this.request(FLEET_COMMANDS.CONNECTION_CONNECT);
  }

  disconnect(options = {}) {
    return this.request(FLEET_COMMANDS.CONNECTION_DISCONNECT, options);
  }
}
