import { TextDecoder } from "node:util";
import { createSerialCaptureClock } from "./shared/serialCaptureClock.js";
import { consumeSerialJsonStream } from "./shared/serialJsonStream.js";
import {
  buildPersistenceSerialSnapshot,
  shouldDeleteOutboxPacketForAck,
  shouldDiscardOrphanedOutboxPacket,
  outboxAckRetryDelay,
} from "./shared/livePersistence.js";
import { CollectorOutbox } from "./outbox.mjs";

const SAMPLE_INTERVAL_MS = 200;
const STALE_LIVE_MS = 3000;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_IN_FLIGHT = 64;
const MAX_ONLINE_IN_FLIGHT = 3;
const RETRY_INTERVAL_MS = 25;
const ACK_TIMEOUT_MS = 3000;
const BACKFILL_REBUILD_GRACE_MS = 12_000;

function compactItem(item) {
  const compact = {
    rx: Number(item?.rx),
    ch: Array.isArray(item?.ch) ? item.ch.slice(0, 8).map(Number) : [],
  };
  const lq = Number(item?.lq ?? item?.linkQuality);
  const rssi = Number(item?.rssi);
  const time = Number(item?.t);
  if (Number.isFinite(lq)) compact.lq = lq;
  if (Number.isFinite(rssi)) compact.rssi = rssi;
  if (Number.isFinite(time)) compact.t = time;
  return compact;
}

function compactPacket(packet) {
  if (packet?.type === "rx_batch" && Array.isArray(packet.items)) {
    const compact = {
      type: "rx_batch",
      v: Number(packet.v) || 1,
      items: packet.items.map(compactItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    const time = Number(packet.t);
    if (Number.isFinite(time)) compact.t = time;
    return compact;
  }
  return compactItem(packet);
}

function rawSamples(packet, capturedAt) {
  const frameTime = Number(packet?.t) || null;
  const items = packet?.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
  return items.map((item) => {
    const receiverId = Number(item?.rx);
    const rawChannels = Array.isArray(item?.ch) ? item.ch.slice(0, 8).map(Number) : [];
    if (!Number.isFinite(receiverId) || receiverId < 1 || rawChannels.length < 8
      || rawChannels.some((value) => !Number.isFinite(value) || value < 172 || value > 1811)) return null;
    return {
      receiverId,
      rawChannels,
      sourceTime: Number(item.t) || frameTime,
      time: capturedAt,
      lq: Number(item.lq ?? item.linkQuality ?? 0),
      rssi: Number(item.rssi ?? -127),
    };
  }).filter(Boolean);
}

export class NativeTrainingCollector {
  constructor({ dbPath, remoteOrigin, onStatus = () => {}, socketFactory = (url) => new WebSocket(url), fetchImpl = fetch }) {
    this.outbox = new CollectorOutbox(dbPath);
    this.remoteOrigin = new URL(remoteOrigin).origin;
    this.socketFactory = socketFactory;
    this.fetchImpl = fetchImpl;
    this.onStatus = onStatus;
    this.eventId = this.outbox.getMeta("activeEventId");
    this.activeEvent = null;
    this.pilotsById = new Map();
    this.lastPilotRefreshAt = 0;
    this.eventVersion = 0;
    this.decoder = new TextDecoder();
    this.captureClock = createSerialCaptureClock();
    this.jsonBuffer = "";
    this.latestByReceiver = {};
    this.samplesByReceiver = {};
    this.lastPersistenceAt = 0;
    this.lastPersistenceEventId = "";
    this.inFlight = new Map();
    this.onlineInFlight = new Map();
    this.retryAfter = new Map();
    this.recoveryCutoff = 0;
    this.recoveryEvents = new Map();
    this.rebuildGraceUntil = 0;
    this.socket = null;
    this.running = false;
    this.serialConnected = false;
    this.lastSerialAt = 0;
    this.lastLiveSentAt = 0;
    this.lastAckAt = 0;
    this.lastError = "";
    this.framesRead = 0;
    this.liveSent = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.flushTimer = null;
    this.eventTimer = null;
    this.lastStatusAt = 0;
  }

  getStatus() {
    return {
      serialConnected: this.serialConnected,
      serverConnected: this.socket?.readyState === WebSocket.OPEN,
      eventId: this.eventId,
      cachedPackets: this.outbox.pendingCount(),
      rejectedPackets: this.outbox.rejectedCount(),
      framesRead: this.framesRead,
      liveSent: this.liveSent,
      lastSerialAt: this.lastSerialAt,
      lastLiveSentAt: this.lastLiveSentAt,
      lastAckAt: this.lastAckAt,
      lastError: this.lastError,
    };
  }

  getMonitorSnapshot(now = Date.now()) {
    const assignedByReceiver = new Map((this.activeEvent?.participants || [])
      .map((participant) => [Number(participant.receiverId), participant])
      .filter(([receiverId]) => Number.isInteger(receiverId) && receiverId > 0));
    const receiverIds = new Set([
      ...assignedByReceiver.keys(),
      ...Object.values(this.latestByReceiver)
        .filter((sample) => now - sample.time < 10_000)
        .map((sample) => sample.receiverId),
    ]);
    return {
      ...this.getStatus(),
      now,
      eventName: this.activeEvent?.name || "",
      receivers: [...receiverIds].sort((left, right) => left - right).map((receiverId) => {
        const sample = this.latestByReceiver[receiverId];
        const participant = assignedByReceiver.get(receiverId);
        return {
          receiverId,
          pilotName: this.pilotsById.get(participant?.pilotId) || "",
          rawChannels: sample?.rawChannels || null,
          lq: sample?.lq ?? null,
          rssi: sample?.rssi ?? null,
          capturedAt: sample?.time || 0,
        };
      }),
    };
  }

  emitStatus(force = false) {
    if (!force && Date.now() - this.lastStatusAt < 1000) return;
    this.lastStatusAt = Date.now();
    this.onStatus(this.getStatus());
  }

  setEventId(eventId) {
    const next = String(eventId || "");
    if (next === this.eventId) return;
    this.eventId = next;
    this.eventVersion += 1;
    this.outbox.putMeta("activeEventId", next);
    this.lastPersistenceAt = 0;
    this.lastPersistenceEventId = "";
    this.emitStatus(true);
  }

  async refreshEventId() {
    const eventVersion = this.eventVersion;
    try {
      const response = await this.fetchImpl(new URL("/api/events", this.remoteOrigin), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`事件查询 HTTP ${response.status}`);
      const events = await response.json();
      if (Array.isArray(events) && this.eventVersion === eventVersion) {
        this.activeEvent = events.find((event) => event.active) || null;
        this.setEventId(this.activeEvent?.id || "");
        this.emitStatus(true);
      }
    } catch (error) {
      this.lastError = `事件查询失败：${error.message}`;
      this.emitStatus(true);
    }
    await this.refreshPilotNames(true);
  }

  async refreshPilotNames(force = false) {
    if (!force && Date.now() - this.lastPilotRefreshAt < 5000) return;
    this.lastPilotRefreshAt = Date.now();
    try {
      const response = await this.fetchImpl(new URL("/api/pilots", this.remoteOrigin), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const pilots = await response.json();
      if (Array.isArray(pilots)) {
        this.pilotsById = new Map(pilots.map((pilot) => [pilot.id, pilot.name || pilot.id]));
        this.emitStatus(true);
      }
    } catch {
      // Names are display-only; collection must continue when this request fails.
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    void this.refreshEventId();
    this.flushTimer = setInterval(() => this.flushOutbox(), RETRY_INTERVAL_MS);
    this.eventTimer = setInterval(() => void this.refreshEventId(), 30_000);
    this.emitStatus(true);
  }

  connect() {
    if (!this.running || (this.socket && this.socket.readyState <= 1)) return;
    const url = new URL("/live-ws", this.remoteOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = this.socketFactory(url.toString());
    } catch (error) {
      this.lastError = `实时连接失败：${error.message}`;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        this.lastError = "云端连接超时，正在重试";
        socket.close();
      }
    }, 15_000);
    socket.addEventListener("open", () => {
      if (!this.running || this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      try {
        socket.send(JSON.stringify({ type: "publish_live", room: "default" }));
      } catch (error) {
        this.lastError = `实时连接初始化失败：${error.message}`;
        socket.close();
        return;
      }
      this.recoveryCutoff = this.outbox.sequence;
      this.recoveryEvents = new Map(this.outbox.recoveryEvents(this.recoveryCutoff)
        .map((row) => [row.event_id, Number(row.cutoff_at) || 0]));
      this.inFlight.clear();
      this.onlineInFlight.clear();
      this.retryAfter.clear();
      this.rebuildGraceUntil = 0;
      this.backpressureSince = 0;
      this.lastError = "";
      this.flushOutbox();
      this.emitStatus(true);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      this.handleServerMessage(message);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.socket = null;
      this.inFlight.clear();
      this.onlineInFlight.clear();
      this.scheduleReconnect();
      this.emitStatus(true);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.lastError = "云端 WebSocket 异常，正在重连";
    });
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  handleServerMessage(message) {
    if (message.type === "live_state" && message.state) {
      this.activeEvent = message.state.event?.active ? message.state.event : null;
      this.setEventId(this.activeEvent?.id || "");
      if (this.activeEvent?.participants?.some((participant) => !this.pilotsById.has(participant.pilotId))) {
        void this.refreshPilotNames();
      }
      this.emitStatus(true);
      return;
    }
    if (message.type !== "live_packet_ack" || !message.packetId) return;
    this.inFlight.delete(message.packetId);
    this.onlineInFlight.delete(message.packetId);
    if (shouldDeleteOutboxPacketForAck(message)) {
      // The server has processed the packet. Delete the sole local durable
      // copy only after its SQLite transaction has completed successfully.
      this.outbox.delete(message.packetId);
      this.retryAfter.delete(message.packetId);
      this.lastAckAt = Date.now();
      this.flushOutbox();
    } else if (shouldDiscardOrphanedOutboxPacket(message)) {
      this.outbox.markRejected(message.packetId, message.status, message.reason);
      this.retryAfter.delete(message.packetId);
      this.lastError = `可靠帧 ${message.packetId} 被拒收，已保留本机记录：${message.reason || message.status || "orphaned"}`;
      this.flushOutbox();
    } else {
      this.retryAfter.set(message.packetId, Date.now() + outboxAckRetryDelay(message));
      this.lastError = `可靠帧 ${message.packetId} 未确认：${message.reason || message.status || "待重试"}`;
    }
    this.emitStatus(true);
  }

  attachSerial(port) {
    if (this.serialPort) this.detachSerial();
    this.serialPort = port;
    this.serialConnected = true;
    this.captureClock.reset();
    this.jsonBuffer = "";
    this.decoder = new TextDecoder();
    this.onData = (chunk) => this.acceptSerialChunk(chunk);
    this.onSerialClose = () => {
      this.serialConnected = false;
      this.serialPort = null;
      this.emitStatus(true);
    };
    this.onSerialError = (error) => {
      this.lastError = `串口异常：${error.message}`;
      this.emitStatus(true);
    };
    port.on("data", this.onData);
    port.on("close", this.onSerialClose);
    port.on("error", this.onSerialError);
    this.emitStatus(true);
  }

  detachSerial() {
    const port = this.serialPort;
    if (!port) return;
    port.off("data", this.onData);
    port.off("close", this.onSerialClose);
    port.off("error", this.onSerialError);
    this.serialPort = null;
    this.serialConnected = false;
    if (port.isOpen) port.close();
    this.emitStatus(true);
  }

  acceptSerialChunk(chunk, observedAt = Date.now()) {
    const consumed = consumeSerialJsonStream(this.jsonBuffer, this.decoder.decode(chunk, { stream: true }));
    this.jsonBuffer = consumed.buffer;
    if (consumed.failures.length) {
      this.lastError = `串口 JSON 解析失败（${consumed.failures.length} 帧）`;
      this.emitStatus(true);
    }
    for (const { packet } of consumed.frames) {
      const capturedAt = this.captureClock.capture(packet, observedAt);
      this.acceptFrame(packet, capturedAt);
    }
  }

  acceptFrame(packet, capturedAt) {
    const now = Date.now();
    this.framesRead += 1;
    this.lastSerialAt = now;
    const samples = rawSamples(packet, capturedAt);
    for (const sample of samples) {
      this.latestByReceiver[sample.receiverId] = sample;
      const queue = this.samplesByReceiver[sample.receiverId] || [];
      queue.push(sample);
      while (queue.length && (queue[0].time < capturedAt - 10_000 || queue.length > 600)) queue.shift();
      this.samplesByReceiver[sample.receiverId] = queue;
    }
    const socket = this.socket;
    const current = now - capturedAt < STALE_LIVE_MS;
    if (current && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      try {
        socket.send(JSON.stringify({
          type: "live_batch", room: "default", batch: compactPacket(packet),
          clientTime: capturedAt, liveOnly: true, source: "native_collector",
        }));
        this.liveSent += 1;
        this.lastLiveSentAt = now;
      } catch (error) {
        this.lastError = `实时发送失败：${error.message}`;
        this.emitStatus(true);
      }
    }
    const eventId = this.eventId;
    if (eventId && samples.length && (eventId !== this.lastPersistenceEventId
      || capturedAt - this.lastPersistenceAt >= SAMPLE_INTERVAL_MS)) {
      const previousAt = eventId === this.lastPersistenceEventId
        ? this.lastPersistenceAt : Math.max(0, capturedAt - SAMPLE_INTERVAL_MS);
      const snapshot = buildPersistenceSerialSnapshot(
        this.latestByReceiver, capturedAt, undefined, this.samplesByReceiver, previousAt,
      );
      if (snapshot) {
        try {
          const record = this.outbox.cache(eventId, capturedAt, snapshot);
          this.lastPersistenceAt = capturedAt;
          this.lastPersistenceEventId = eventId;
          if (current) this.sendDurable(record, false);
        } catch (error) {
          this.lastError = `本地可靠缓存写入失败：${error.message}`;
          this.emitStatus(true);
        }
      }
    }
    this.emitStatus();
  }

  sendDurable(record, backfill) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN
      || socket.bufferedAmount > MAX_BUFFERED_BYTES || this.inFlight.size >= MAX_IN_FLIGHT
      || (!backfill && this.onlineInFlight.size >= MAX_ONLINE_IN_FLIGHT)) return false;
    try {
      socket.send(JSON.stringify({
        type: "live_batch",
        room: "default",
        batch: record.batch,
        clientTime: record.capturedAt,
        clientSequence: record.clientSequence,
        packetId: record.packetId,
        eventId: record.eventId,
        ...(backfill ? { backfill: true } : { liveOnly: true, durable: true }),
        persistOnly: true,
      }));
    } catch (error) {
      this.lastError = `可靠帧发送失败：${error.message}`;
      this.emitStatus(true);
      return false;
    }
    const sentAt = Date.now();
    this.inFlight.set(record.packetId, sentAt);
    if (!backfill) this.onlineInFlight.set(record.packetId, sentAt);
    return true;
  }

  flushOutbox() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now >= this.rebuildGraceUntil
      && [...this.onlineInFlight.values()].some((sentAt) => now - sentAt >= ACK_TIMEOUT_MS)) {
      this.lastError = "在线可靠帧确认超时，正在重连并按原采集时间补传";
      this.socket = null;
      this.inFlight.clear();
      this.onlineInFlight.clear();
      socket.close();
      this.scheduleReconnect();
      this.emitStatus(true);
      return;
    }
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!this.backpressureSince) this.backpressureSince = now;
      if (now - this.backpressureSince >= 5000) {
        this.lastError = "云端连接持续积压，正在重连";
        socket.close();
      }
      return;
    }
    this.backpressureSince = 0;
    let recoverySent = 0;
    for (const record of this.outbox.pending(Number.MAX_SAFE_INTEGER, 240)) {
      if (this.inFlight.size >= MAX_IN_FLIGHT || socket.bufferedAmount > MAX_BUFFERED_BYTES) break;
      if (Number(this.retryAfter.get(record.packetId) || 0) > now) continue;
      const sentAt = this.inFlight.get(record.packetId);
      if (sentAt && now < this.rebuildGraceUntil) continue;
      if (sentAt && now - sentAt < ACK_TIMEOUT_MS) continue;
      if (sentAt) this.inFlight.delete(record.packetId);
      const backfill = record.clientSequence <= this.recoveryCutoff || now - record.capturedAt >= STALE_LIVE_MS;
      if (!backfill) {
        this.sendDurable(record, false);
      } else if (this.sendDurable(record, true)) {
        recoverySent += 1;
        if (recoverySent >= 8) break;
      }
    }
    if (this.recoveryEvents.size && this.outbox.recoveryCount(this.recoveryCutoff) === 0) {
      for (const [eventId, cutoffCapturedAt] of this.recoveryEvents) {
        try {
          socket.send(JSON.stringify({
            type: "live_backfill_complete", room: "default", eventId,
            cutoffSequence: this.recoveryCutoff, cutoffCapturedAt,
          }));
          this.rebuildGraceUntil = Date.now() + BACKFILL_REBUILD_GRACE_MS;
        } catch (error) {
          this.lastError = `回补完成通知失败：${error.message}`;
          return;
        }
      }
      this.recoveryEvents.clear();
    }
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    this.reconnectTimer = this.connectTimer = this.flushTimer = this.eventTimer = null;
    this.detachSerial();
    this.socket?.close();
    this.socket = null;
    this.outbox.close();
  }
}
