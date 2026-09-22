import express from "express";
import { Buffer } from "node:buffer";
import fs from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { qweatherGet } from "./server/integrations/qweather.js";
import { loadLocalEnvFile } from "./server/config/loadEnv.js";
import { initializeDatabase } from "./server/database/initializeDatabase.js";
import { registerGroundStationRoutes } from "./server/features/groundStation/registerGroundStationRoutes.js";
import { registerTrackRoutes } from "./server/features/tracks/registerTrackRoutes.js";
import { registerCoachFeature } from "./server/features/coach/registerCoachFeature.js";
import { registerTeachingRoutes } from "./server/features/teaching/registerTeachingRoutes.js";
import { createTrainingRuntime } from "./server/features/training/createTrainingRuntime.js";
import { compactLiveBatch, getPilotState, parseSerialPacket } from "./server/live/sampleProcessing.js";
import { parseAiJsonContent, readJsonIfExists, safeJsonParse } from "./server/shared/json.js";
import { DEFAULT_TRANSPORT_RULES, calculateTransportPlans } from "./server/transport/planner.js";

loadLocalEnvFile(path.resolve(process.cwd(), ".env"));
loadLocalEnvFile(path.resolve(process.cwd(), ".env.local"));

const app = express();
const server = http.createServer(app);
const PORT = Math.max(1, Number(process.env.PORT) || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const dataDir = path.resolve("data");
const bracketStateFile = path.join(dataDir, "bracket-state.json");
const pilotsJsonFile = path.join(dataDir, "pilots.json");
const eventsJsonFile = path.join(dataDir, "events.json");
const dbFile = path.join(dataDir, "training.db");
const trainingCsvFile = path.join(dataDir, "training-joystick-samples.csv");
const uploadsDir = path.join(dataDir, "uploads");
const trackUploadsDir = path.join(uploadsDir, "tracks");
const betaflightModernDistDir = path.resolve(
  process.env.BETAFLIGHT_MODERN_DIST_DIR
  || process.env.BETAFLIGHT_DIST_DIR
  || "betaflight-dist",
);
const betaflightLegacyDistDir = path.resolve(
  process.env.BETAFLIGHT_LEGACY_DIST_DIR
  || "betaflight-legacy-dist",
);
const betaflightModernAvailable = fs.existsSync(path.join(betaflightModernDistDir, "index.html"));
const betaflightLegacyAvailable = fs.existsSync(path.join(betaflightLegacyDistDir, "index.html"));
const betaflightAvailable = betaflightModernAvailable || betaflightLegacyAvailable;
const betaflightKernels = [
  {
    id: "modern",
    label: "Betaflight 2026.6",
    url: "/betaflight/",
    available: betaflightModernAvailable,
    apiMin: "1.44.0",
    apiMax: "1.48.0",
  },
  {
    id: "legacy",
    label: "Betaflight Configurator 10.10",
    url: "/betaflight-legacy/",
    available: betaflightLegacyAvailable,
    apiMin: "1.41.0",
    apiMax: "1.46.0",
  },
];

app.use(express.json({ limit: "16mb" }));
app.use("/uploads", express.static(uploadsDir));
if (betaflightModernAvailable) {
  app.use("/betaflight", express.static(betaflightModernDistDir));
}
if (betaflightLegacyAvailable) {
  app.use("/betaflight-legacy", express.static(betaflightLegacyDistDir));
}

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}
if (!fs.existsSync(trackUploadsDir)) {
  fs.mkdirSync(trackUploadsDir, { recursive: true });
}

const defaultChannelConfig = {
  ch5: [{ name: "Arm", type: "arm", min: 1500, max: 1998 }],
  ch6: [
    { name: "Angle", type: "mode", min: 1500, max: 1800 },
    { name: "Air", type: "mode", min: 1800, max: 1998 },
  ],
  ch7: [{ name: "Turtle", type: "turtle", min: 1500, max: 1998 }],
  ch8: [],
};

const defaultPilots = [
  { id: "pilot-1", name: "\u9009\u624b1", rates: "BF: 600/600/500", note: "\u65b0\u624b\uff0c\u6ce8\u610f\u63a7\u9ad8", channelConfig: defaultChannelConfig },
  { id: "pilot-2", name: "\u9009\u624b2", rates: "BF: 550/550/450", note: "", channelConfig: defaultChannelConfig },
];

const liveRooms = new Map();
const serverLiveState = {
  latestSamplesByReceiver: {},
  receiverState: {
    connected: false,
    receiverCount: 0,
    maxReceiverId: 0,
    packetCount: 0,
    lastDataAt: null,
    lastReceiverId: null,
    error: "",
  },
};
const runtimeEvents = new Map();
// PROTECTED CORE DATA-PLANE CONTRACT (read docs/LIVE_DATA_PIPELINE.md before
// editing): current frames own the live display; SQLite owns complete history.
// Keep the single 30 Hz live stream, its ~5 Hz durable/ACK frames, and the
// isolated backfill lane. Backfill is never broadcast as current live data.
// Recovery may publish bounded history patches while draining, then rebuilds
// once for final authority. New features should consume this contract rather
// than reorganize it without explicit user approval and full regression proof.
const SAMPLE_WRITE_INTERVAL_MS = 200;
const STATS_REFRESH_INTERVAL_MS = 1000;
const RECEIVER_DB_WRITE_INTERVAL_MS = 1000;
const SERIAL_PERSISTENCE_INTERVAL_MS = SAMPLE_WRITE_INTERVAL_MS;
const SERIAL_PERSISTENCE_MAX_PACKETS_PER_TICK = 12;
const SERIAL_PERSISTENCE_TIME_BUDGET_MS = 35;
// The normal sampler wakes every 200 ms, but recovery must not wait for that
// clock between every browser upload window. A short yielding drain loop is
// enabled only while backfill is queued; current packets are still unshifted
// to the front and therefore retain strict priority.
const BACKFILL_DRAIN_INTERVAL_MS = 20;
const BACKFILL_PROGRESS_INTERVAL_MS = 500;
const IMPLICIT_BACKFILL_DELAY_MS = 400;
const IMPLICIT_BACKFILL_FINALIZE_QUIET_MS = 1500;
const BACKFILL_FINALIZE_QUIET_MS = Math.max(1000, Number(process.env.BACKFILL_FINALIZE_QUIET_MS) || 5 * 60_000);
const MAX_SAMPLE_GAP_MS = 1000;
const RECENT_SAMPLE_WINDOW_MS = 5000;
const LIVE_STATE_BROADCAST_INTERVAL_MS = 1000;
const RECEIVER_OFFLINE_AFTER_MS = 2500;
const AUDIENCE_RATE_WINDOW_MS = 5000;
const SERVER_DOWNLINK_MBPS = Math.max(0.1, Number(process.env.SERVER_DOWNLINK_MBPS) || 3);
const AUDIENCE_BANDWIDTH_SAFETY_RATIO = Math.min(0.95, Math.max(0.1, Number(process.env.AUDIENCE_BANDWIDTH_SAFETY_RATIO) || 0.7));
const MAX_AUDIENCE_LIVE_FPS = 30;
const receiverDbWriteTimes = new Map();
const pendingSerialPackets = [];
const backfillFinalizeTimers = new Map();
const backfillProgressTimers = new Map();
const backfillFinalizeStateByEvent = new Map();
const pendingTrainingCsvPackets = [];
const pendingTrainingCsvLines = [];
let rebuildTrainingTimelineFromSamples = () => false;
let buildBackfillTimelinePatch = () => null;
let requestBackfillPersistenceDrain = () => {};
const serialIngestStatus = {
  receivedPackets: 0,
  processedPackets: 0,
  receivedSamples: 0,
  mappedSamples: 0,
  persistedSamples: 0,
  throttledSamples: 0,
  staleSamples: 0,
  unmappedSamples: 0,
  outOfWindowSamples: 0,
  duplicatePackets: 0,
  supersededPackets: 0,
  compactedCurrentPackets: 0,
  compactedBackfillPackets: 0,
  backfillProcessedPackets: 0,
  backfillPersistedSamples: 0,
  backfillThrottledSamples: 0,
  backfillStaleSamples: 0,
  backfillUnmappedSamples: 0,
  backfillOutOfWindowSamples: 0,
  backfillMissingEventPackets: 0,
  backfillRequestedEventMissingPackets: 0,
  backfillResolvedByCaptureTimePackets: 0,
  backfillOrphanedPackets: 0,
  backfillDuplicatePackets: 0,
  backfillProgressPublishCount: 0,
  backfillFinalizedCount: 0,
  lastBackfillProgressAt: null,
  lastBackfillProgressMs: 0,
  maxBackfillProgressMs: 0,
  lastBackfillFinalizeMs: 0,
  maxBackfillFinalizeMs: 0,
  lastTimelineGapEventId: "",
  lastTimelineSampleCount: 0,
  lastTimelineGapCount: 0,
  lastTimelineMaxGapMs: 0,
  lastBackfillProcessedAt: null,
  lastBackfillFinalizedAt: null,
  lastBackfillEventId: "",
  lastBackfillRequestedEventId: "",
  lastBackfillActiveEventId: "",
  lastBackfillPacketId: "",
  lastBackfillCapturedAt: null,
  lastBackfillResolvedBy: "",
  lastBackfillCandidateCount: 0,
  lastBackfillAckStatus: "",
  lastBackfillRejectReason: "",
  failedPackets: 0,
  maxQueuedPackets: 0,
  lastProcessMs: 0,
  maxProcessMs: 0,
  lastProcessedAt: null,
  lastMappedSampleAt: null,
  lastEventId: "",
  lastPacketRawSamples: 0,
  lastPacketMappedSamples: 0,
  lastPacketPersistedSamples: 0,
  lastPacketThrottledSamples: 0,
  lastPacketStaleSamples: 0,
  lastPacketUnmappedSamples: 0,
  lastPacketOutOfWindowSamples: 0,
  lastPacketNoActiveEvent: false,
  lastPacketUnassignedReceiverIds: [],
  lastPacketMissingPilotIds: [],
  lastSampleTime: null,
  lastPersistedSampleAt: null,
  lastPersistedSampleTime: null,
  lastError: "",
};
const trainingCsvStatus = {
  queuedRows: 0,
  queuedBytes: 0,
  writtenRows: 0,
  bytesWritten: 0,
  fileSizeBytes: 0,
  lastFlushMs: 0,
  lastFlushAt: null,
  lastError: "",
  flushInFlight: false,
};
const csvRuntimeEvents = new Map();
const audienceEgressMetrics = {
  startedAt: Date.now(),
  buckets: [],
  totalBytes: 0,
  totalMessages: 0,
  skippedMessages: 0,
  resyncRequests: 0,
  targetLiveFps: MAX_AUDIENCE_LIVE_FPS,
  lastLiveFrameBytes: 0,
};

function recordAudienceEgress(bytes) {
  const safeBytes = Math.max(0, Number(bytes) || 0);
  if (!safeBytes) return;
  const bucketAt = Math.floor(Date.now() / 1000) * 1000;
  let bucket = audienceEgressMetrics.buckets[audienceEgressMetrics.buckets.length - 1];
  if (!bucket || bucket.at !== bucketAt) {
    bucket = { at: bucketAt, bytes: 0, messages: 0 };
    audienceEgressMetrics.buckets.push(bucket);
  }
  bucket.bytes += safeBytes;
  bucket.messages += 1;
  audienceEgressMetrics.totalBytes += safeBytes;
  audienceEgressMetrics.totalMessages += 1;
}

function audienceDownloadStatus(now = Date.now()) {
  const cutoff = now - AUDIENCE_RATE_WINDOW_MS;
  audienceEgressMetrics.buckets = audienceEgressMetrics.buckets.filter((bucket) => bucket.at >= cutoff - 1000);
  const recentBuckets = audienceEgressMetrics.buckets.filter((bucket) => bucket.at >= cutoff);
  const recentBytes = recentBuckets.reduce((total, bucket) => total + bucket.bytes, 0);
  const elapsedMs = Math.max(1000, Math.min(AUDIENCE_RATE_WINDOW_MS, now - audienceEgressMetrics.startedAt));
  let bytesPerSecond = Math.round(recentBytes / (elapsedMs / 1000));
  const subscribers = [...liveRooms.values()].flatMap((room) => [...room.subscribers])
    .filter((client, index, clients) => !client.socket.destroyed && clients.indexOf(client) === index);
  if (!subscribers.length) {
    audienceEgressMetrics.startedAt = now;
    audienceEgressMetrics.buckets = [];
    audienceEgressMetrics.skippedMessages = 0;
    audienceEgressMetrics.resyncRequests = 0;
    audienceEgressMetrics.targetLiveFps = MAX_AUDIENCE_LIVE_FPS;
    bytesPerSecond = 0;
  }
  const capacityBytesPerSecond = SERVER_DOWNLINK_MBPS * 1_000_000 / 8;
  const utilizationPercent = capacityBytesPerSecond > 0
    ? Math.round((bytesPerSecond / capacityBytesPerSecond) * 1000) / 10
    : 0;
  const pressureLevel = utilizationPercent >= 100
    ? "critical"
    : utilizationPercent >= 80
      ? "high"
      : utilizationPercent >= 50
        ? "medium"
        : "low";
  return {
    audienceCount: subscribers.length,
    bytesPerSecond,
    bitsPerSecond: bytesPerSecond * 8,
    perAudienceBytesPerSecond: subscribers.length ? Math.round(bytesPerSecond / subscribers.length) : 0,
    capacityMbps: SERVER_DOWNLINK_MBPS,
    utilizationPercent,
    pressureLevel,
    targetLiveFps: audienceEgressMetrics.targetLiveFps,
    liveFrameBytes: audienceEgressMetrics.lastLiveFrameBytes,
    safetyRatio: AUDIENCE_BANDWIDTH_SAFETY_RATIO,
    bufferedBytes: subscribers.reduce((total, client) => total
      + Number(client.socket.writableLength || 0)
      + Number(client.pendingLiveFrame?.length || 0)
      + Number(client.pendingStateFrame?.length || 0), 0),
    maxBufferedBytes: subscribers.reduce((maximum, client) => Math.max(
      maximum,
      Number(client.socket.writableLength || 0)
        + Number(client.pendingLiveFrame?.length || 0)
        + Number(client.pendingStateFrame?.length || 0),
    ), 0),
    skippedMessages: audienceEgressMetrics.skippedMessages,
    resyncRequests: audienceEgressMetrics.resyncRequests,
    totalBytes: audienceEgressMetrics.totalBytes,
    totalMessages: audienceEgressMetrics.totalMessages,
  };
}

function getLiveRoom(roomId = "default") {
  const safeRoomId = String(roomId || "default").slice(0, 64);
  if (!liveRooms.has(safeRoomId)) {
    liveRooms.set(safeRoomId, {
      publishers: new Set(),
      subscribers: new Set(),
      lastBatch: null,
      updatedAt: null,
      lastSampleTime: null,
      sequence: 0,
      streamId: crypto.randomUUID(),
      currentState: null,
      stateUpdatedAt: null,
    });
  }
  return liveRooms.get(safeRoomId);
}

function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let header;
  if (payloadBuffer.length < 126) {
    header = Buffer.from([0x80 | opcode, payloadBuffer.length]);
  } else if (payloadBuffer.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function writeWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return 0;
  const frame = encodeWebSocketFrame(opcode, payload);
  socket.write(frame);
  return frame.length;
}

function encodeLiveSocketJson(message) {
  return encodeWebSocketFrame(0x1, Buffer.from(JSON.stringify(message), "utf-8"));
}

function attachSubscriberDrain(client) {
  if (client.liveDrainAttached || client.socket.destroyed) return;
  client.liveDrainAttached = true;
  client.socket.once("drain", () => flushSubscriberFrames(client));
}

function writeSubscriberFrame(client, frame) {
  if (client.socket.destroyed) return false;
  const accepted = client.socket.write(frame);
  recordAudienceEgress(frame.length);
  if (!accepted) {
    client.liveBackpressured = true;
    attachSubscriberDrain(client);
  }
  return accepted;
}

function flushSubscriberFrames(client) {
  client.liveDrainAttached = false;
  if (client.socket.destroyed || client.role !== "subscriber") return;
  client.liveBackpressured = false;

  const hasBothFrames = Boolean(client.pendingStateFrame && client.pendingLiveFrame);
  const keys = client.flushStateFirst
    ? ["pendingStateFrame", "pendingLiveFrame"]
    : ["pendingLiveFrame", "pendingStateFrame"];
  if (hasBothFrames) client.flushStateFirst = !client.flushStateFirst;
  for (const key of keys) {
    const frame = client[key];
    if (!frame) continue;
    client[key] = null;
    if (!writeSubscriberFrame(client, frame)) return;
  }
}

function queueSubscriberFrame(client, frame, kind = "live") {
  if (client.socket.destroyed) return false;
  if (!client.liveBackpressured) return writeSubscriberFrame(client, frame);

  const key = kind === "state" ? "pendingStateFrame" : "pendingLiveFrame";
  if (kind === "live" && client[key]) audienceEgressMetrics.skippedMessages += 1;
  client[key] = frame;
  attachSubscriberDrain(client);
  return false;
}

function sendLiveSocketJson(client, message) {
  if (client.socket.destroyed) return 0;
  const frame = encodeLiveSocketJson(message);
  if (client.role === "subscriber") {
    writeSubscriberFrame(client, frame);
  } else {
    client.socket.write(frame);
  }
  return frame.length;
}

function readWebSocketFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  const frames = [];

  while (client.buffer.length >= 2) {
    let offset = 2;
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;

    if (length === 126) {
      if (client.buffer.length < offset + 2) break;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) break;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) break;

    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);

    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({ opcode, payload });
  }

  return frames;
}

function removeLiveClient(client) {
  if (client.role === "publisher") {
    serverLiveState.inputInterruptedAt = Date.now();
    for (const runtime of runtimeEvents.values()) {
      runtime.inputInterruptedAt = serverLiveState.inputInterruptedAt;
    }
  }
  for (const room of liveRooms.values()) {
    room.publishers.delete(client);
    room.subscribers.delete(client);
  }
}

function sendLatestLiveBatch(client, room, afterSequence = 0) {
  const safeAfter = Math.max(0, Number(afterSequence) || 0);
  if (room.lastBatch && room.lastBatch.sequence > safeAfter) {
    queueSubscriberFrame(client, encodeLiveSocketJson({ ...room.lastBatch, snapshot: true }), "live");
  }
  sendLiveSocketJson(client, { type: "live_resume_complete", latestSequence: room.sequence, streamId: room.streamId, serverTime: Date.now() });
}

function joinLiveRoom(client, roomId, role, afterSequence = 0) {
  removeLiveClient(client);
  const room = getLiveRoom(roomId);
  client.roomId = String(roomId || "default").slice(0, 64);
  client.role = role;
  if (role === "publisher") room.publishers.add(client);
  if (role === "subscriber") room.subscribers.add(client);
  sendLiveSocketJson(client, { type: "live_ack", role, room: client.roomId, streamId: room.streamId, serverTime: Date.now() });
  // A fresh/reloaded page must receive one complete authoritative timeline.
  // Normal broadcasts remain incremental, so this does not restore the old
  // behaviour of repeatedly downloading the whole training history.
  let initialState = room.currentState;
  try {
    const eventRow = activeEventQuery.get();
    const event = eventRow ? eventFromRow(eventRow) : null;
    initialState = buildServerLiveState(event, Date.now(), {
      includeTimeline: true,
      includeEvents: role === "subscriber",
    });
  } catch {
    // During startup, fall back to the room snapshot if the training runtime is
    // not ready yet. Subsequent heartbeat broadcasts will still recover state.
  }
  if (initialState) {
    const initialStateMessage = {
      type: "live_state",
      room: client.roomId,
      state: initialState,
      serverTime: Date.now(),
      latestSequence: room.sequence,
      streamId: room.streamId,
    };
    if (role === "subscriber") queueSubscriberFrame(client, encodeLiveSocketJson(initialStateMessage), "state");
    else sendLiveSocketJson(client, initialStateMessage);
  }
  if (role === "subscriber") {
    sendLatestLiveBatch(client, room, afterSequence);
  }
}

function broadcastLiveState(roomId, state) {
  const room = getLiveRoom(roomId);
  room.currentState = state || null;
  room.stateUpdatedAt = Date.now();
  if (!room.currentState) return;

  const outgoing = {
    type: "live_state",
    room: String(roomId || "default").slice(0, 64),
    state: room.currentState,
    serverTime: room.stateUpdatedAt,
    latestSequence: room.sequence,
    streamId: room.streamId,
  };

  for (const client of room.publishers) {
    if (client.socket.destroyed) continue;
    sendLiveSocketJson(client, outgoing);
  }
  const frame = encodeLiveSocketJson(outgoing);
  for (const client of room.subscribers) queueSubscriberFrame(client, frame, "state");
}

function broadcastLiveBatch(roomId, batch, serverTime, sampleTime = serverTime, source = "") {
  const room = getLiveRoom(roomId);
  room.sequence += 1;
  room.updatedAt = serverTime;
  room.lastSampleTime = sampleTime;
  const outgoing = {
    type: "live_batch",
    batch,
    sampleTime,
    sequence: room.sequence,
  };
  room.lastBatch = outgoing;

  const frame = encodeLiveSocketJson(outgoing);
  const subscribers = [...room.subscribers].filter((subscriber) => !subscriber.socket.destroyed);
  audienceEgressMetrics.targetLiveFps = MAX_AUDIENCE_LIVE_FPS;
  audienceEgressMetrics.lastLiveFrameBytes = frame.length;
  for (const subscriber of subscribers) {
    queueSubscriberFrame(subscriber, frame, "live");
  }
  if (source === "virtual_receiver") {
    const publisherOutgoing = { ...outgoing, source: "virtual_receiver" };
    for (const publisher of room.publishers) {
      if (publisher.socket.destroyed) continue;
      sendLiveSocketJson(publisher, publisherOutgoing);
    }
  }
}

function queueSerialPacketForPersistence(roomId, packet, receivedAt, metadata = {}) {
  const queued = {
    roomId: String(roomId || "default").slice(0, 64),
    packet,
    receivedAt,
    enqueuedAt: Date.now(),
    ...metadata,
  };
  serialIngestStatus.receivedPackets += 1;

  if (!queued.backfill) {
    const existingIndex = pendingSerialPackets.findIndex((candidate) => (
      !candidate.backfill
      && candidate.roomId === queued.roomId
    ));
    if (existingIndex >= 0) {
      const existing = pendingSerialPackets[existingIndex];
      // The server-owned live fallback is intentionally lower priority than a
      // durable client outbox packet. Keep the explicit packet when both land
      // in the same 200 ms sampling window so it is acknowledged only after
      // processing, while still allowing live frames to persist when the
      // browser's secondary persistence path is unavailable.
      if (queued.fallbackPersistence && existing.packetId) {
        serialIngestStatus.supersededPackets += 1;
        serialIngestStatus.compactedCurrentPackets += 1;
        return;
      }
      const superseded = pendingSerialPackets.splice(existingIndex, 1)[0];
      serialIngestStatus.supersededPackets += 1;
      serialIngestStatus.compactedCurrentPackets += 1;
      if (superseded.client && superseded.packetId) {
        sendLiveSocketJson(superseded.client, {
          type: "live_packet_ack",
          packetId: superseded.packetId,
          clientSequence: superseded.clientSequence,
          accepted: true,
          sampled: false,
          serverTime: Date.now(),
        });
      }
    }
    // Current live persistence always wins over historical recovery work.
    pendingSerialPackets.unshift(queued);
  } else {
    pendingSerialPackets.push(queued);
    requestBackfillPersistenceDrain();
  }
  serialIngestStatus.maxQueuedPackets = Math.max(serialIngestStatus.maxQueuedPackets, pendingSerialPackets.length);
}

function getSerialIngestStatus(now = Date.now()) {
  const oldestEnqueuedAt = pendingSerialPackets.reduce(
    (oldest, queued) => Math.min(oldest, Number(queued.enqueuedAt || now)),
    now,
  );
  return {
    ...serialIngestStatus,
    queuedPackets: pendingSerialPackets.length,
    currentQueuedPackets: pendingSerialPackets.filter((queued) => !queued.backfill).length,
    backfillQueuedPackets: pendingSerialPackets.filter((queued) => queued.backfill).length,
    oldestQueuedMs: pendingSerialPackets.length
      ? Math.max(0, now - oldestEnqueuedAt)
      : 0,
  };
}

function broadcastTimelineResync(roomId, eventId) {
  const room = getLiveRoom(roomId);
  const outgoing = {
    type: "live_timeline_resync",
    eventId,
    serverTime: Date.now(),
    streamId: room.streamId,
  };
  // Both viewers and the publishing coach must replace their locally
  // reconstructed timeline with the same post-backfill SQLite result.
  for (const publisher of room.publishers) sendLiveSocketJson(publisher, outgoing);
  for (const subscriber of room.subscribers) sendLiveSocketJson(subscriber, outgoing);
}

function broadcastTimelinePatch(roomId, patch) {
  if (!patch?.eventId || !(Number(patch.replaceTo) > Number(patch.replaceFrom))) return false;
  const room = getLiveRoom(roomId);
  const outgoing = {
    type: "live_timeline_patch",
    ...patch,
    serverTime: Date.now(),
    streamId: room.streamId,
  };
  // Progressive history is an audience concern. Sending every patch back to
  // the publishing coach repeatedly re-rendered the page that owns Web Serial,
  // which could delay serial reads and create the very sample gaps recovery is
  // supposed to repair. The coach keeps its uninterrupted local live timeline
  // and receives the one final authoritative baseline after completion.
  const frame = encodeLiveSocketJson(outgoing);
  for (const subscriber of room.subscribers) queueSubscriberFrame(subscriber, frame, "state");
  return true;
}

function publishBackfillTimelineProgress(roomId, eventId) {
  const safeEventId = String(eventId || "").slice(0, 160);
  const timer = backfillProgressTimers.get(safeEventId);
  if (timer) clearTimeout(timer);
  backfillProgressTimers.delete(safeEventId);
  const state = backfillFinalizeStateByEvent.get(safeEventId);
  if (!state || !(Number(state.dirtyTo) > Number(state.dirtyFrom))) return false;

  const replaceFrom = Math.max(1, Number(state.dirtyFrom) - MAX_SAMPLE_GAP_MS);
  const replaceTo = Number(state.dirtyTo) + MAX_SAMPLE_GAP_MS;
  const startedAt = Date.now();
  try {
    const patch = buildBackfillTimelinePatch(safeEventId, replaceFrom, replaceTo);
    if (!patch || !broadcastTimelinePatch(roomId || state.roomId || "default", patch)) return false;
    const elapsed = Date.now() - startedAt;
    state.dirtyFrom = null;
    state.dirtyTo = null;
    state.lastProgressAt = Date.now();
    state.progressPublishCount = Number(state.progressPublishCount || 0) + 1;
    serialIngestStatus.backfillProgressPublishCount += 1;
    serialIngestStatus.lastBackfillProgressAt = state.lastProgressAt;
    serialIngestStatus.lastBackfillProgressMs = elapsed;
    serialIngestStatus.maxBackfillProgressMs = Math.max(serialIngestStatus.maxBackfillProgressMs, elapsed);
    return true;
  } catch (error) {
    serialIngestStatus.lastError = error.message || "historical timeline progress failed";
    serialIngestStatus.failedPackets += 1;
    return false;
  }
}

function scheduleBackfillTimelineProgress(roomId, eventId) {
  const safeEventId = String(eventId || "").slice(0, 160);
  if (!safeEventId || backfillProgressTimers.has(safeEventId)) return;
  const state = backfillFinalizeStateByEvent.get(safeEventId);
  const earliestAt = Number(state?.lastProgressAt || 0) + BACKFILL_PROGRESS_INTERVAL_MS;
  const delay = Math.max(0, earliestAt - Date.now());
  const timer = setTimeout(() => {
    publishBackfillTimelineProgress(roomId, safeEventId);
  }, delay);
  timer.unref?.();
  backfillProgressTimers.set(safeEventId, timer);
}

function finalizeBackfillTimeline(roomId, eventId) {
  const safeEventId = String(eventId || "").slice(0, 160);
  if (!safeEventId) return false;
  const timer = backfillFinalizeTimers.get(safeEventId);
  if (timer) clearTimeout(timer);
  backfillFinalizeTimers.delete(safeEventId);
  const progressTimer = backfillProgressTimers.get(safeEventId);
  if (progressTimer) clearTimeout(progressTimer);
  backfillProgressTimers.delete(safeEventId);

  // The quiet timer can fire just before the 200 ms persistence worker. Do
  // not rebuild until every packet for this event has actually left the queue.
  if (pendingSerialPackets.some((queued) => queued.backfill && String(queued.eventId || "") === safeEventId)) {
    scheduleBackfillTimelineFinalize(roomId, safeEventId, 200);
    return false;
  }

  const finalizeState = backfillFinalizeStateByEvent.get(safeEventId);
  if (!finalizeState || finalizeState.completedPackets < 1) return false;

  const startedAt = Date.now();
  try {
    // Force is intentional: even an in-order recovery generation must publish
    // one complete, coherent SQLite timeline before clients replace their
    // temporary live rendering.
    const rebuilt = rebuildTrainingTimelineFromSamples(safeEventId, Date.now(), { force: true });
    if (!rebuilt) {
      serialIngestStatus.lastError = `historical timeline rebuild skipped: event ${safeEventId} not found`;
      serialIngestStatus.failedPackets += 1;
      return false;
    }
    serialIngestStatus.lastBackfillFinalizedAt = Date.now();
    serialIngestStatus.lastBackfillEventId = safeEventId;
    serialIngestStatus.backfillFinalizedCount += 1;
    serialIngestStatus.lastBackfillFinalizeMs = Date.now() - startedAt;
    serialIngestStatus.maxBackfillFinalizeMs = Math.max(
      serialIngestStatus.maxBackfillFinalizeMs,
      serialIngestStatus.lastBackfillFinalizeMs,
    );
  } catch (error) {
    serialIngestStatus.lastError = error.message || "historical timeline rebuild failed";
    serialIngestStatus.failedPackets += 1;
    return false;
  }
  try {
    const eventRow = eventByIdQuery.get(safeEventId);
    if (eventRow) {
      // A reconnect snapshot may have been created before recovery finished.
      // Send a new complete baseline now; otherwise a later 1 Hz incremental
      // heartbeat can look newer than the REST rebuild and put the old gap
      // back onto the page.
      broadcastLiveState(roomId, buildServerLiveState(eventFromRow(eventRow), Date.now(), {
        includeTimeline: true,
        includeEvents: true,
      }));
    }
  } catch (error) {
    serialIngestStatus.lastError = error.message || "rebuilt timeline broadcast failed";
    serialIngestStatus.failedPackets += 1;
  }
  broadcastTimelineResync(roomId, safeEventId);
  backfillFinalizeStateByEvent.delete(safeEventId);
  return true;
}

function scheduleBackfillTimelineFinalize(roomId, eventId, delayMs = BACKFILL_FINALIZE_QUIET_MS) {
  const safeEventId = String(eventId || "").slice(0, 160);
  if (!safeEventId) return;
  const existing = backfillFinalizeTimers.get(safeEventId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    finalizeBackfillTimeline(roomId, safeEventId);
  }, Math.max(0, delayMs));
  timer.unref?.();
  backfillFinalizeTimers.set(safeEventId, timer);
}

function handleProcessedBackfill({ queued, result }) {
  const ackStatus = result?.ackStatus || (result?.duplicate ? "duplicate" : result?.accepted ? "processed" : "retryable");
  const resolvedEventId = String(result?.resolvedEventId || result?.event?.id || "").slice(0, 160);
  if (!resolvedEventId) return;
  let current = backfillFinalizeStateByEvent.get(resolvedEventId);
  // A duplicate-only replay changes nothing in SQLite and must not trigger a
  // full timeline rebuild. Rebuilding for every delayed duplicate gets more
  // expensive as an event grows, blocks live persistence, causes ACK timeouts,
  // and creates a self-amplifying duplicate/rebuild loop. Once a generation
  // has actually persisted history, later duplicates still extend its quiet
  // window so that generation is finalized exactly once after it drains.
  if (!current && ackStatus !== "persisted") return;
  if (!current) {
    current = {
      completedPackets: 0,
      persistedSamples: 0,
      duplicatePackets: 0,
      dirtyFrom: null,
      dirtyTo: null,
      lastProgressAt: 0,
      progressPublishCount: 0,
    };
  }
  current.completedPackets += 1;
  current.persistedSamples += Number(result?.persistedSampleCount || 0);
  if (ackStatus === "duplicate") current.duplicatePackets += 1;
  if (ackStatus === "persisted") {
    const capturedAt = Number(queued.receivedAt) || Number(result?.latestSampleTime) || Date.now();
    const latestSampleTime = Number(result?.latestSampleTime) || capturedAt;
    current.dirtyFrom = current.dirtyFrom === null ? capturedAt : Math.min(current.dirtyFrom, capturedAt);
    current.dirtyTo = current.dirtyTo === null ? latestSampleTime : Math.max(current.dirtyTo, latestSampleTime);
  }
  current.lastProcessedAt = Date.now();
  current.roomId = queued.roomId || "default";
  backfillFinalizeStateByEvent.set(resolvedEventId, current);
  if (ackStatus === "persisted") scheduleBackfillTimelineProgress(current.roomId, resolvedEventId);
  // The explicit live_backfill_complete message normally finalizes immediately.
  // This long quiet timer is only a safety net for a browser that disappears
  // after uploading data but before sending the completion control message.
  scheduleBackfillTimelineFinalize(
    current.roomId,
    resolvedEventId,
    queued.implicitBackfill ? IMPLICIT_BACKFILL_FINALIZE_QUIET_MS : BACKFILL_FINALIZE_QUIET_MS,
  );
}

function handleLiveSocketMessage(client, message) {
  if (message.type === "publish_live") {
    joinLiveRoom(client, message.room || "default", "publisher", message.afterSequence);
    return;
  }
  if (message.type === "subscribe_live") {
    joinLiveRoom(client, message.room || "default", "subscriber", message.afterSequence);
    return;
  }
  if (message.type === "resume_live" && client.role === "subscriber") {
    audienceEgressMetrics.resyncRequests += 1;
    sendLatestLiveBatch(client, getLiveRoom(client.roomId || message.room || "default"), message.afterSequence);
    return;
  }
  if (message.type === "live_backfill_complete" && client.role === "publisher") {
    const roomId = client.roomId || message.room || "default";
    const completedEventId = String(message.eventId || "").slice(0, 160);
    // Normally this finalizes immediately. If the last batch is still waiting
    // for the persistence tick, the helper defers until the queue is drained.
    finalizeBackfillTimeline(roomId, completedEventId);
    return;
  }
  if (message.type === "live_state" && client.role === "publisher") {
    try {
      const eventRow = activeEventQuery.get();
      const event = eventRow ? eventFromRow(eventRow) : null;
      // Publisher state messages are sent after event/pilot configuration
      // changes. The event id can stay the same while receiver ownership and
      // participant membership change, so an incremental suffix cannot be
      // safely joined onto the pre-change baseline. Send one complete SQLite
      // timeline to both coach and audience at this boundary.
      broadcastLiveState(client.roomId || message.room || "default", buildServerLiveState(event, Date.now(), {
        includeTimeline: true,
        includeEvents: true,
      }));
    } catch {
      broadcastLiveState(client.roomId || message.room || "default", message.state || null);
    }
    return;
  }
  if (!["live_batch", "serial_packet"].includes(message.type) || client.role !== "publisher") return;

  const roomId = client.roomId || message.room || "default";
  const batch = message.batch || message.packet || null;
  if (!batch) return;

  const receivedAt = Date.now();
  const publisherTime = Number(message.clientTime);
  const packetId = String(message.packetId || "").slice(0, 160);
  const durable = Boolean(message.liveOnly && message.durable && packetId);
  const explicitBackfill = Boolean(message.backfill);
  let transportDelayMs = 0;
  if (Number.isFinite(publisherTime) && publisherTime > 0) {
    const observedClockOffsetMs = receivedAt - publisherTime;
    const previousClockOffsetMs = Number(client.publisherClockOffsetMs);
    if (Number.isFinite(previousClockOffsetMs)) {
      transportDelayMs = Math.max(0, observedClockOffsetMs - previousClockOffsetMs);
      // The minimum observed offset on this connection approximates its clock
      // offset plus best-case network latency. A brief outage raises only the
      // current observation, so buffered durable frames can be distinguished
      // without assuming that browser and server wall clocks are identical.
      client.publisherClockOffsetMs = Math.min(previousClockOffsetMs, observedClockOffsetMs);
    } else {
      client.publisherClockOffsetMs = observedClockOffsetMs;
    }
  }
  const implicitBackfill = durable && transportDelayMs >= IMPLICIT_BACKFILL_DELAY_MS;
  const backfill = explicitBackfill || implicitBackfill;
  // Stable live semantics use server receipt time as the canonical clock.
  // Only explicit recovery packets retain their original capture time.
  const sampleTime = backfill
    && Number.isFinite(publisherTime)
    && publisherTime > 0
    && publisherTime <= receivedAt + 60 * 1000
    // A client clock may be ahead. A future recovery timestamp can poison the
    // per-pilot 5 Hz cursor and make every following live sample look stale.
    ? Math.min(publisherTime, receivedAt)
    : receivedAt;
  const source = String(message.source || "").slice(0, 64);
  const eventId = String(message.eventId || "").slice(0, 160);
  // IndexedDB must commit a durable frame before it is sent, so a following
  // ordinary frame can occasionally reach the server first. Never let that
  // delayed durable frame roll the audience display backwards; it still goes
  // through persistence and receives its normal ACK below.
  const liveOrderTime = Number.isFinite(publisherTime) && publisherTime > 0 ? publisherTime : receivedAt;
  const staleForLiveBroadcast = Number(client.lastLiveClientTime || 0) > liveOrderTime;
  if (!backfill && !message.persistOnly && !staleForLiveBroadcast) {
    client.lastLiveClientTime = Math.max(Number(client.lastLiveClientTime || 0), liveOrderTime);
    broadcastLiveBatch(roomId, compactLiveBatch(batch), receivedAt, sampleTime, source);
  }
  if (message.liveOnly) {
    // One of the normal 30 Hz live frames is upgraded about every 200 ms with
    // durable metadata. It is broadcast exactly like every other live frame,
    // then processed as the acknowledged SQLite sample -- no second online
    // persistOnly message is needed. Plain liveOnly frames still feed the
    // server-owned sampler as a compatibility/failure fallback, so a broken
    // browser outbox can never make authoritative history disappear again.
    queueSerialPacketForPersistence(roomId, batch, sampleTime, durable ? {
      serverReceivedAt: receivedAt,
      packetId,
      eventId,
      clientSequence: Number(message.clientSequence) || null,
      client,
      backfill,
      implicitBackfill,
    } : {
      serverReceivedAt: receivedAt,
      fallbackPersistence: true,
    });
    return;
  }
  queueSerialPacketForPersistence(roomId, batch, sampleTime, {
    serverReceivedAt: receivedAt,
    packetId,
    eventId,
    clientSequence: Number(message.clientSequence) || null,
    client,
    backfill,
  });
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/live-ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  const client = {
    socket,
    buffer: Buffer.alloc(0),
    roomId: null,
    role: null,
    liveBackpressured: false,
    liveDrainAttached: false,
    pendingLiveFrame: null,
    pendingStateFrame: null,
    lastLiveSentAt: 0,
    publisherClockOffsetMs: null,
    flushStateFirst: false,
  };

  socket.on("data", (chunk) => {
    for (const frame of readWebSocketFrames(client, chunk)) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        writeWebSocketFrame(socket, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      try {
        handleLiveSocketMessage(client, JSON.parse(frame.payload.toString("utf-8")));
      } catch {
        sendLiveSocketJson(client, { type: "live_error", error: "invalid json" });
      }
    }
  });
  socket.on("close", () => removeLiveClient(client));
  socket.on("error", () => removeLiveClient(client));
});

const db = new DatabaseSync(dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");

function runTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

initializeDatabase(db);
registerGroundStationRoutes({
  app,
  db,
  betaflightAvailable,
  betaflightMountPath: "/betaflight/",
  betaflightKernels,
});

const upsertTransportRule = db.prepare(`
  INSERT INTO transport_rules
    (equipment_type, people_required, max_per_trip, trip_time_minutes, cart_required, difficulty, enabled, note)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(equipment_type) DO UPDATE SET
    people_required = excluded.people_required,
    max_per_trip = excluded.max_per_trip,
    trip_time_minutes = excluded.trip_time_minutes,
    cart_required = excluded.cart_required,
    difficulty = excluded.difficulty,
    enabled = excluded.enabled,
    note = excluded.note
`);

function ensureDefaultTransportRules() {
  const existingRows = db.prepare("SELECT equipment_type FROM transport_rules").all();
  const existing = new Set(existingRows.map((row) => row.equipment_type));
  for (const [key, rule] of Object.entries(DEFAULT_TRANSPORT_RULES)) {
    if (existing.has(key)) continue;
    upsertTransportRule.run(
      key,
      Math.max(1, Math.floor(Number(rule.people) || 1)),
      Math.max(1, Math.floor(Number(rule.qty) || 1)),
      Number(rule.minutes) || 1,
      Math.max(0, Math.floor(Number(rule.cart) || 0)),
      Number(rule.difficulty) || 1,
      rule.enabled === false ? 0 : 1,
      rule.note || "",
    );
  }
}

ensureDefaultTransportRules();

const getPilotCount = db.prepare("SELECT COUNT(*) AS count FROM pilots");
const upsertPilot = db.prepare(`
  INSERT INTO pilots (id, name, rates, rate_profile_json, note, channel_config_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    rates = excluded.rates,
    rate_profile_json = excluded.rate_profile_json,
    note = excluded.note,
    channel_config_json = excluded.channel_config_json,
    updated_at = excluded.updated_at
`);

function migrateJsonToSqlite() {
  if (getPilotCount.get().count === 0) {
    const pilots = readJsonIfExists(pilotsJsonFile, defaultPilots);
    const now = Date.now();
    for (const pilot of Array.isArray(pilots) ? pilots : defaultPilots) {
      upsertPilot.run(
        pilot.id,
        pilot.name || pilot.id,
        pilot.rates || "",
        pilot.rateProfile ? JSON.stringify(pilot.rateProfile) : null,
        pilot.note || "",
        JSON.stringify(pilot.channelConfig || defaultChannelConfig),
        now,
      );
    }
  }

  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM training_events").get().count;
  if (eventCount === 0) {
    const events = readJsonIfExists(eventsJsonFile, []);
    const upsertEvent = db.prepare(`
      INSERT INTO training_events (id, name, started_at, ended_at, active, participants_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        active = excluded.active,
        participants_json = excluded.participants_json,
        updated_at = excluded.updated_at
    `);
    for (const event of Array.isArray(events) ? events : []) {
      const now = Date.now();
      upsertEvent.run(
        event.id,
        event.name || event.id,
        event.startedAt || null,
        event.endedAt || null,
        event.active ? 1 : 0,
        JSON.stringify(event.participants || []),
        event.createdAt || event.startedAt || now,
        now,
      );
    }
  }

  const receiverSetting = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get("receiverCount");
  if (!receiverSetting) {
    db.prepare("INSERT INTO training_settings (key, value_json) VALUES (?, ?)").run("receiverCount", JSON.stringify(8));
  }
}

migrateJsonToSqlite();

function pilotFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    rates: row.rates,
    rateProfile: safeJsonParse(row.rate_profile_json, null),
    note: row.note,
    channelConfig: safeJsonParse(row.channel_config_json, defaultChannelConfig),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    active: Boolean(row.active),
    participants: safeJsonParse(row.participants_json, []),
    createdAt: row.created_at,
  };
}

function sampleChannelValue(sample, channelKey) {
  const value = Number(sample?.channels?.[channelKey]);
  return Number.isFinite(value) ? value : null;
}

function optionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getParticipantForPilot(event, pilotId) {
  return (event?.participants || []).find((participant) => participant.pilotId === pilotId) || null;
}

function getParticipantTrainingWindow(event, participantOrPilotId, now = Date.now()) {
  const participant = typeof participantOrPilotId === "object"
    ? participantOrPilotId
    : getParticipantForPilot(event, participantOrPilotId);
  const eventStart = optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || now;
  const eventEnd = optionalTimestamp(event?.endedAt) || now;
  const requestedStart = optionalTimestamp(participant?.trainingStartAt);
  const requestedEnd = optionalTimestamp(participant?.trainingEndAt);
  const start = Math.max(eventStart, requestedStart || eventStart);
  const end = Math.max(start, Math.min(eventEnd, requestedEnd || eventEnd));
  return { start, end };
}

function computeEventOverview(event, eventId, { includeSampleCounts = true } = {}) {
  const participantByPilot = new Map((event.participants || [])
    .filter((participant) => participant?.pilotId)
    .map((participant) => [participant.pilotId, participant]));
  const storedSegments = db.prepare(`
    SELECT event_id, pilot_id, type, started_at, ended_at, duration_ms
    FROM training_segments
    WHERE event_id = ?
    ORDER BY pilot_id ASC, started_at ASC
  `).all(eventId);
  const segmentsByPilot = new Map();
  for (const segment of storedSegments) {
    if (!participantByPilot.has(segment.pilot_id)) continue;
    const list = segmentsByPilot.get(segment.pilot_id) || [];
    list.push(segment);
    segmentsByPilot.set(segment.pilot_id, list);
  }
  const countRows = includeSampleCounts
    ? db.prepare(`
      SELECT pilot_id, COUNT(*) AS sample_count
      FROM training_samples
      WHERE event_id = ?
      GROUP BY pilot_id
    `).all(eventId)
    : [];
  const countByPilot = new Map(countRows.map((row) => [row.pilot_id, Number(row.sample_count) || 0]));

  const now = Date.now();
  const pilotIds = participantByPilot.keys();
  const stats = [];
  const segments = [];
  const sampleCounts = {};

  for (const pilotId of pilotIds) {
    const pilotSegments = segmentsByPilot.get(pilotId) || [];
    sampleCounts[pilotId] = countByPilot.get(pilotId) || 0;
    const trainingWindow = getParticipantTrainingWindow(event, participantByPilot.get(pilotId) || pilotId, now);
    let totalFlightMs = 0;
    let utilizationFlightMs = 0;
    let totalTurtleMs = 0;
    let lastFlightEndAt = null;
    for (const segment of pilotSegments) {
      if (segment.type === "flight") lastFlightEndAt = Math.max(lastFlightEndAt || 0, Number(segment.ended_at) || 0) || lastFlightEndAt;
      const overlapStart = Math.max(trainingWindow.start, Number(segment.started_at) || 0);
      const overlapEnd = Math.min(trainingWindow.end, Number(segment.ended_at) || 0);
      const overlapMs = Math.max(0, overlapEnd - overlapStart);
      const actualMs = Math.max(0, Number(segment.ended_at) - Number(segment.started_at));
      if (segment.type === "flight") {
        totalFlightMs += actualMs;
        utilizationFlightMs += overlapMs;
      }
      if (segment.type === "turtle") totalTurtleMs += actualMs;
    }
    const utilization = utilizationFlightMs / Math.max(1, trainingWindow.end - trainingWindow.start);
    stats.push({
      event_id: eventId,
      pilot_id: pilotId,
      total_flight_ms: totalFlightMs,
      utilization,
      idle_ms: lastFlightEndAt === null ? null : Math.max(0, now - lastFlightEndAt),
      total_turtle_ms: totalTurtleMs,
      last_flight_end_at: lastFlightEndAt,
      updated_at: now,
    });
    segments.push(...pilotSegments);
  }

  return { stats, segments, sampleCounts };
}

function persistEventOverview(eventId, overview) {
  runTransaction(() => {
    db.prepare("DELETE FROM training_event_stats WHERE event_id = ?").run(eventId);
    for (const stat of overview.stats) {
      upsertStat.run(
        eventId,
        stat.pilot_id,
        Math.round(stat.total_flight_ms || 0),
        Number(stat.utilization || 0),
        stat.idle_ms ?? null,
        Math.round(stat.total_turtle_ms || 0),
        stat.last_flight_end_at ?? null,
        stat.updated_at,
      );
    }
  });
}

function receiverAssignmentSignature(event) {
  return JSON.stringify((event?.participants || []).map((participant) => ({
    pilotId: String(participant?.pilotId || ""),
    receiverId: Number(participant?.receiverId) || 0,
  })));
}

function receiverAssignmentsForEvent(eventId) {
  return db.prepare(`
    SELECT id, event_id, pilot_id, receiver_id, started_at, ended_at, created_at
    FROM training_receiver_assignments
    WHERE event_id = ?
    ORDER BY started_at ASC, id ASC
  `).all(eventId);
}

function syncReceiverAssignments(previousEvent, nextEvent, changedAt = Date.now()) {
  if (!nextEvent?.id || !optionalTimestamp(nextEvent.startedAt)) return;
  const eventStart = optionalTimestamp(nextEvent.startedAt) || optionalTimestamp(nextEvent.createdAt) || changedAt;
  const eventEnd = optionalTimestamp(nextEvent.endedAt);
  const boundary = Math.max(eventStart, Math.min(eventEnd || changedAt, changedAt));
  const currentRows = receiverAssignmentsForEvent(nextEvent.id);
  const openByPilot = new Map(currentRows.filter((row) => !row.ended_at).map((row) => [row.pilot_id, row]));
  const nextByPilot = new Map((nextEvent.participants || [])
    .filter((participant) => participant?.pilotId && Number(participant?.receiverId) > 0)
    .map((participant) => [participant.pilotId, participant]));
  const previousStarted = Boolean(optionalTimestamp(previousEvent?.startedAt));

  for (const [pilotId, openRow] of openByPilot) {
    const participant = nextByPilot.get(pilotId);
    if (!participant || Number(participant.receiverId) !== Number(openRow.receiver_id) || eventEnd) {
      db.prepare("UPDATE training_receiver_assignments SET ended_at = ? WHERE id = ?")
        .run(Math.max(openRow.started_at, eventEnd || boundary), openRow.id);
    }
  }

  if (eventEnd) return;
  for (const participant of nextByPilot.values()) {
    const openRow = openByPilot.get(participant.pilotId);
    if (openRow && Number(openRow.receiver_id) === Number(participant.receiverId)) continue;
    const startedAt = previousStarted || previousEvent?.active ? boundary : eventStart;
    db.prepare(`
      INSERT INTO training_receiver_assignments
        (event_id, pilot_id, receiver_id, started_at, ended_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(nextEvent.id, participant.pilotId, Number(participant.receiverId), startedAt, changedAt);
  }
}

function recomputeAndPersistEventOverview(eventId, options = {}) {
  const row = db.prepare("SELECT * FROM training_events WHERE id = ?").get(eventId);
  if (!row) return null;
  const event = eventFromRow(row);
  const overview = computeEventOverview(event, eventId, options);
  persistEventOverview(eventId, overview);
  return { event, overview };
}

function readCachedEventOverview(eventId, { includeSegments = true } = {}) {
  const stats = db.prepare(`
    SELECT event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, last_flight_end_at, updated_at
    FROM training_event_stats
    WHERE event_id = ?
    ORDER BY pilot_id
  `).all(eventId);
  const segments = includeSegments
    ? db.prepare(`
      SELECT event_id, pilot_id, type, started_at, ended_at, duration_ms
      FROM training_segments
      WHERE event_id = ?
      ORDER BY started_at ASC
    `).all(eventId)
    : [];
  return { stats, segments };
}

function eventOverviewSignature(event) {
  return JSON.stringify({
    startedAt: optionalTimestamp(event?.startedAt),
    endedAt: optionalTimestamp(event?.endedAt),
    active: Boolean(event?.active),
    participants: (event?.participants || []).map((participant) => ({
      pilotId: participant?.pilotId || "",
      trainingStartAt: optionalTimestamp(participant?.trainingStartAt),
      trainingEndAt: optionalTimestamp(participant?.trainingEndAt),
    })),
  });
}

function bandStateFromSegmentType(type) {
  if (type === "flight") return "flying";
  if (type === "turtle") return "turtle";
  return "idle";
}

function bandsByPilotFromSegments(segments = []) {
  const bandsByPilot = {};
  for (const segment of segments) {
    const pilotId = segment.pilot_id;
    if (!bandsByPilot[pilotId]) bandsByPilot[pilotId] = [];
    bandsByPilot[pilotId].push({
      state: bandStateFromSegmentType(segment.type),
      start: segment.started_at,
      end: segment.ended_at,
    });
  }
  for (const bands of Object.values(bandsByPilot)) {
    bands.sort((left, right) => left.start - right.start);
  }
  return bandsByPilot;
}

function getReceiverCount() {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get("receiverCount");
  const count = Number(safeJsonParse(row?.value_json, 8));
  return Math.max(1, Math.min(16, count || 8));
}

function setReceiverCount(count) {
  const safeCount = Math.max(1, Math.min(16, Number(count) || 8));
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES ('receiverCount', ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(JSON.stringify(safeCount));
  return safeCount;
}

function getReceivers() {
  const count = getReceiverCount();
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM receivers ORDER BY id").all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    name: byId.get(index + 1)?.name || `接收机 ${index + 1}`,
    online: byId.has(index + 1) ? Boolean(byId.get(index + 1).online) : index < Math.min(4, count),
    binding: Boolean(byId.get(index + 1)?.binding),
    bindRequestedAt: byId.get(index + 1)?.bind_requested_at || null,
    lastSeenAt: byId.get(index + 1)?.last_seen_at || now,
  }));
}

const trackFeature = registerTrackRoutes({
  app,
  bracketStateFile,
  calculateTransportPlans,
  db,
  defaultTransportRules: DEFAULT_TRANSPORT_RULES,
  readJsonIfExists,
  runTransaction,
  trackUploadsDir,
  upsertTransportRule,
});
const { getLessonTrackRow, settingJson, setSettingJson, trackFromRow } = trackFeature;

app.get("/api/pilots", (req, res) => {
  const rows = db.prepare("SELECT * FROM pilots ORDER BY updated_at, id").all();
  res.json(rows.map(pilotFromRow));
});

app.post("/api/pilots", (req, res) => {
  const pilots = Array.isArray(req.body) ? req.body : [];
  const now = Date.now();
  runTransaction(() => {
    db.prepare("DELETE FROM pilots").run();
    for (const pilot of pilots) {
      upsertPilot.run(
        pilot.id,
        pilot.name || pilot.id,
        pilot.rates || "",
        pilot.rateProfile ? JSON.stringify(pilot.rateProfile) : null,
        pilot.note || "",
        JSON.stringify(pilot.channelConfig || defaultChannelConfig),
        now,
      );
    }
  });
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  const rows = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC").all();
  res.json(rows.map(eventFromRow));
});

app.get("/api/events/:id/detail", (req, res) => {
  const row = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "event not found" });

  const event = eventFromRow(row);
  const pilotRows = db.prepare("SELECT * FROM pilots").all();
  const pilots = new Map(pilotRows.map((pilot) => [pilot.id, pilotFromRow(pilot)]));
  const cachedOverview = readCachedEventOverview(req.params.id);
  const overview = req.query.recompute === "1"
    ? computeEventOverview(event, req.params.id)
    : { ...cachedOverview, sampleCounts: {} };
  if (req.query.recompute === "1") persistEventOverview(req.params.id, overview);
  const sampleCountRows = db.prepare(`
    SELECT pilot_id, COUNT(*) AS count
    FROM training_samples
    WHERE event_id = ?
    GROUP BY pilot_id
  `).all(req.params.id);
  for (const countRow of sampleCountRows) {
    overview.sampleCounts[countRow.pilot_id] = countRow.count;
  }
  const statsByPilot = new Map(overview.stats.map((stat) => [stat.pilot_id, stat]));
  const receiverHistoryByPilot = new Map();
  for (const assignment of receiverAssignmentsForEvent(req.params.id)) {
    const list = receiverHistoryByPilot.get(assignment.pilot_id) || [];
    list.push({
      receiverId: assignment.receiver_id,
      startedAt: assignment.started_at,
      endedAt: assignment.ended_at,
    });
    receiverHistoryByPilot.set(assignment.pilot_id, list);
  }
  const lastStoredSampleAt = db.prepare("SELECT MAX(time) AS value FROM training_samples WHERE event_id = ?").get(req.params.id)?.value || 0;
  const lastSegmentAt = db.prepare("SELECT MAX(ended_at) AS value FROM training_segments WHERE event_id = ?").get(req.params.id)?.value || 0;
  const lastSampleAt = Math.max(lastStoredSampleAt, lastSegmentAt) || null;
  const segmentsByPilot = new Map();
  for (const segment of overview.segments) {
    const list = segmentsByPilot.get(segment.pilot_id) || [];
    list.push({
      type: segment.type,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      durationMs: segment.duration_ms,
    });
    segmentsByPilot.set(segment.pilot_id, list);
  }

  res.json({
    event,
    generatedAt: Date.now(),
    lastSampleAt,
    coachTasks: buildCoachTasks(req.params.id)?.tasks || [],
    reviews: lessonReviewsForEvent(req.params.id),
    aiSummary: settingJson(`event_ai_summary_${req.params.id}`, null),
    aiSummaryConfig: settingJson(`event_ai_summary_config_${req.params.id}`, settingJson("historyAiSummaryConfig", { includeTasks: true, includeReviews: true, systemPrompt: getCoachLlmConfig().systemPrompt || "" })),
    participants: event.participants.map((participant) => {
      const pilot = pilots.get(participant.pilotId);
      const stat = statsByPilot.get(participant.pilotId);
      const segments = segmentsByPilot.get(participant.pilotId) || [];
      const currentStat = {
        eventId: req.params.id,
        eventName: event.name,
        startedAt: event.startedAt || event.createdAt,
        totalFlightMs: stat?.total_flight_ms || 0,
        utilization: stat?.utilization || 0,
        totalTurtleMs: stat?.total_turtle_ms || 0,
        sampleCount: overview.sampleCounts[participant.pilotId] || 0,
      };
      const review = lessonReviewsForEvent(req.params.id).find((item) => item.pilot_id === participant.pilotId);
      return {
        ...participant,
        pilotName: pilot?.name || participant.pilotId,
        rates: pilot?.rates || "",
        totalFlightMs: stat?.total_flight_ms || 0,
        utilization: stat?.utilization || 0,
        idleMs: stat?.idle_ms ?? null,
        totalTurtleMs: stat?.total_turtle_ms || 0,
        sampleCount: overview.sampleCounts[participant.pilotId] || 0,
        receiverHistory: receiverHistoryByPilot.get(participant.pilotId) || [],
        samples: [],
        segments,
        comparison: comparePilotProgress(event, participant.pilotId, currentStat, review),
      };
    }),
  });
});

// Recalculate a finished event after correcting its time window or participants.
app.post("/api/events/:id/recompute", (req, res) => {
  const recomputed = recomputeAndPersistEventOverview(req.params.id);
  if (!recomputed) return res.status(404).json({ error: "event not found" });
  res.json({ ok: true, event: recomputed.event });
});

app.post("/api/events/:id/trim", (req, res) => {
  const row = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "event not found" });
  const event = eventFromRow(row);
  const eventStart = optionalTimestamp(event.startedAt) || optionalTimestamp(event.createdAt);
  const endedAt = optionalTimestamp(req.body?.endedAt);
  if (!eventStart || !endedAt || endedAt < eventStart || endedAt > Date.now() + 60_000) {
    return res.status(400).json({ error: "裁剪结束时间必须晚于训练开始时间且不能晚于当前时间" });
  }
  let deletedSamples = 0;
  runTransaction(() => {
    deletedSamples = Number(db.prepare("DELETE FROM training_samples WHERE event_id = ? AND time > ?").run(req.params.id, endedAt).changes || 0);
    db.prepare("DELETE FROM training_segments WHERE event_id = ? AND started_at >= ?").run(req.params.id, endedAt);
    db.prepare(`
      UPDATE training_segments
      SET ended_at = ?, duration_ms = MAX(0, ? - started_at)
      WHERE event_id = ? AND started_at < ? AND ended_at > ?
    `).run(endedAt, endedAt, req.params.id, endedAt, endedAt);
    db.prepare("DELETE FROM training_ingested_packets WHERE event_id = ? AND captured_at > ?").run(req.params.id, endedAt);
    db.prepare("DELETE FROM training_receiver_assignments WHERE event_id = ? AND started_at >= ?").run(req.params.id, endedAt);
    db.prepare(`
      UPDATE training_receiver_assignments
      SET ended_at = ?
      WHERE event_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
    `).run(endedAt, req.params.id, endedAt, endedAt);
    db.prepare("UPDATE training_events SET active = 0, ended_at = ?, updated_at = ? WHERE id = ?")
      .run(endedAt, Date.now(), req.params.id);
  });
  runtimeEvents.delete(req.params.id);
  csvRuntimeEvents.delete(req.params.id);
  const recomputed = recomputeAndPersistEventOverview(req.params.id);
  res.json({ ok: true, event: recomputed?.event || { ...event, active: false, endedAt }, deletedSamples });
});

app.delete("/api/events/:id", (req, res) => {
  teachingBridge.removeTrainingMediaForEvent?.(req.params.id);
  runTransaction(() => {
    db.prepare("DELETE FROM training_event_stats WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_samples WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_receiver_assignments WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_ingested_packets WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_timeline_rebuild_queue WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_events WHERE id = ?").run(req.params.id);
  });
  res.json({ ok: true });
});

const upsertEvent = db.prepare(`
  INSERT INTO training_events (id, name, started_at, ended_at, active, participants_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    active = excluded.active,
    participants_json = excluded.participants_json,
    updated_at = excluded.updated_at
`);

app.post("/api/events", (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [];
  const names = new Map();
  const previousEvents = new Map();
  for (const event of events) {
    const name = String(event.name || "").trim();
    if (!name) return res.status(400).json({ error: "training event name is required" });
    const existingId = names.get(name);
    if (existingId && existingId !== event.id) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, event.id);
    if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    names.set(name, event.id);
    const previousRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(event.id);
    if (previousRow) previousEvents.set(event.id, eventFromRow(previousRow));
  }
  const now = Date.now();
  runTransaction(() => {
    for (const event of events) {
      upsertEvent.run(
        event.id,
        event.name || event.id,
        event.startedAt || null,
        event.endedAt || null,
        event.active ? 1 : 0,
        JSON.stringify(event.participants || []),
        event.createdAt || event.startedAt || now,
        now,
      );
      syncReceiverAssignments(previousEvents.get(event.id) || null, event, now);
    }
  });
  const recomputedEventIds = [];
  for (const event of events) {
    const previousEvent = previousEvents.get(event?.id);
    const overviewChanged = previousEvent && eventOverviewSignature(previousEvent) !== eventOverviewSignature(event);
    const receiverChanged = !previousEvent || receiverAssignmentSignature(previousEvent) !== receiverAssignmentSignature(event);
    if (overviewChanged && recomputeAndPersistEventOverview(event.id, { includeSampleCounts: false })) recomputedEventIds.push(event.id);
    if (overviewChanged || receiverChanged) {
      if (previousEvent?.active && event.active) {
        const runtime = runtimeEvents.get(event.id);
        const csvRuntime = csvRuntimeEvents.get(event.id);
        if (runtime) runtime.contextLoadedAt = 0;
        if (csvRuntime) csvRuntime.contextLoadedAt = 0;
      } else {
        runtimeEvents.delete(event.id);
        csvRuntimeEvents.delete(event.id);
      }
    }
  }
  res.json({ ok: true, recomputedEventIds });
});

app.post("/api/events/start", (req, res) => {
  const now = Date.now();
  flushPendingTrainingIntervals?.(now, true);
  const id = req.body?.id || `event-${now}`;
  const name = String(req.body?.name || "训练").trim();
  const startedAt = req.body?.startedAt || now;
  const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, id);
  if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
  db.prepare("UPDATE training_events SET active = 0, updated_at = ? WHERE active = 1").run(now);
  const previousRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(id);
  upsertEvent.run(
    id,
    name,
    startedAt,
    null,
    1,
    JSON.stringify(req.body?.participants || []),
    req.body?.createdAt || now,
    now,
  );
  const startedEvent = eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(id));
  syncReceiverAssignments(previousRow ? eventFromRow(previousRow) : null, startedEvent, startedAt);
  runtimeEvents.delete(id);
  csvRuntimeEvents.delete(id);
  const recomputed = recomputeAndPersistEventOverview(id);
  res.json({ ok: true, event: recomputed?.event || eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(id)) });
});

app.post("/api/events/:id/end", (req, res) => {
  const now = Date.now();
  flushPendingTrainingIntervals?.(now, true);
  db.prepare("UPDATE training_events SET active = 0, ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);
  const endedRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (endedRow) syncReceiverAssignments(null, eventFromRow(endedRow), now);
  runtimeEvents.delete(req.params.id);
  csvRuntimeEvents.delete(req.params.id);
  const recomputed = recomputeAndPersistEventOverview(req.params.id);
  res.json({ ok: true, event: recomputed?.event || eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id)) });
});

app.get("/api/training-live", (req, res) => {
  res.json({
    receiverCount: getReceiverCount(),
    receivers: getReceivers(),
    samples: [],
  });
});

app.get("/api/training-csv/status", (req, res) => {
  res.json({
    ...getTrainingCsvStatus(),
    ingest: getSerialIngestStatus(),
    audienceDownload: audienceDownloadStatus(),
  });
});

app.post("/api/training-live", (req, res) => {
  if (req.body?.receiverCount) setReceiverCount(req.body.receiverCount);
  res.json({ ok: true, receiverCount: getReceiverCount(), receivers: getReceivers(), samples: [] });
});

app.post("/api/receivers/count", (req, res) => {
  res.json({ ok: true, receiverCount: setReceiverCount(req.body?.receiverCount) });
});

app.post("/api/receivers/:id/bind", (req, res) => {
  const receiverId = Math.max(1, Math.min(16, Number(req.params.id) || 1));
  const now = Date.now();
  db.prepare(`
    INSERT INTO receivers (id, name, online, binding, bind_requested_at, last_seen_at)
    VALUES (?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      online = 1,
      binding = 1,
      bind_requested_at = excluded.bind_requested_at,
      last_seen_at = excluded.last_seen_at
  `).run(receiverId, `接收机 ${receiverId}`, now, now);
  res.json({ ok: true, receiverId, bindRequestedAt: now, receivers: getReceivers() });
});

const insertSample = db.prepare(`
  INSERT INTO training_samples
    (event_id, pilot_id, receiver_id, time, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, throttle_min, throttle_max, armed, flying, turtle)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const lastSample = db.prepare("SELECT time FROM training_samples WHERE event_id = ? AND pilot_id = ? ORDER BY time DESC LIMIT 1");
const lastSampleDetail = db.prepare(`
  SELECT time, armed, flying, turtle
  FROM training_samples
  WHERE event_id = ? AND pilot_id = ?
  ORDER BY time DESC
  LIMIT 1
`);

app.post("/api/training-events/:id/samples", (req, res) => {
  const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
  let inserted = 0;
  runTransaction(() => {
    for (const sample of samples) {
      const previous = lastSample.get(req.params.id, sample.pilotId);
      if (previous && sample.time - previous.time < 200) continue;
      insertSample.run(
        req.params.id,
        sample.pilotId,
        Number(sample.receiverId) || 0,
        Number(sample.time) || Date.now(),
        sampleChannelValue(sample, "ch1"),
        sampleChannelValue(sample, "ch2"),
        sampleChannelValue(sample, "ch3"),
        sampleChannelValue(sample, "ch4"),
        sampleChannelValue(sample, "ch5"),
        sampleChannelValue(sample, "ch6"),
        sampleChannelValue(sample, "ch7"),
        sampleChannelValue(sample, "ch8"),
        Number.isFinite(Number(sample.throttleMin)) ? Number(sample.throttleMin) : sampleChannelValue(sample, "ch3"),
        Number.isFinite(Number(sample.throttleMax)) ? Number(sample.throttleMax) : sampleChannelValue(sample, "ch3"),
        sample.armed ? 1 : 0,
        sample.flying ? 1 : 0,
        sample.turtle ? 1 : 0,
      );
      inserted += 1;
    }
  });
  res.json({ ok: true, inserted });
});

app.get("/api/training-events/:id/samples", (req, res) => {
  const since = Number(req.query.since || 0);
  const rows = db.prepare(`
    SELECT * FROM training_samples
    WHERE event_id = ? AND time >= ?
    ORDER BY time ASC
    LIMIT 20000
  `).all(req.params.id, since);
  res.json(rows.map((row) => ({
    time: row.time,
    pilotId: row.pilot_id,
    receiverId: row.receiver_id,
    armed: Boolean(row.armed),
    flying: Boolean(row.flying),
    turtle: Boolean(row.turtle),
    channels: {
      ch1: row.ch1,
      ch2: row.ch2,
      ch3: row.ch3,
      ch4: row.ch4,
      ch5: row.ch5,
      ch6: row.ch6,
      ch7: row.ch7,
      ch8: row.ch8,
    },
  })));
});

const trainingRuntime = createTrainingRuntime({
  bandsByPilotFromSegments, broadcastLiveState, csvRuntimeEvents, db, eventFromRow, getParticipantTrainingWindow,
  getPilotState, insertSample, lastSampleDetail, liveStateBroadcastIntervalMs: LIVE_STATE_BROADCAST_INTERVAL_MS,
  maxSampleGapMs: MAX_SAMPLE_GAP_MS, parseSerialPacket, pendingSerialPackets,
  pendingTrainingCsvLines, pendingTrainingCsvPackets, pilotFromRow, readCachedEventOverview,
  receiverDbWriteIntervalMs: RECEIVER_DB_WRITE_INTERVAL_MS, receiverDbWriteTimes,
  receiverOfflineAfterMs: RECEIVER_OFFLINE_AFTER_MS, recentSampleWindowMs: RECENT_SAMPLE_WINDOW_MS,
  runtimeEvents, sampleChannelValue, sampleWriteIntervalMs: SAMPLE_WRITE_INTERVAL_MS,
  serialIngestStatus, serialPersistenceMaxPacketsPerTick: SERIAL_PERSISTENCE_MAX_PACKETS_PER_TICK,
  serialPersistenceTimeBudgetMs: SERIAL_PERSISTENCE_TIME_BUDGET_MS,
  sendLiveSocketJson, serverLiveState, statsRefreshIntervalMs: STATS_REFRESH_INTERVAL_MS,
  onBackfillResult: handleProcessedBackfill, trainingCsvFile, trainingCsvStatus,
});
const {
  COACH_LLM_CONFIG_KEY, COACH_SNAPSHOT_INTERVAL_MS, COACH_STALE_AFTER_MS, COACH_WINDOW_MS,
  DEFAULT_COACH_LLM_CONFIG, DEFAULT_LESSON_BUDGET_CONFIG, LESSON_BUDGET_CONFIG_KEY, LESSON_EXTRA_MATERIAL_KEY,
  LESSON_SYSTEM_PROMPT_KEY, LESSON_TEACHING_MANUAL_KEY, PERSONAL_LESSON_OPTIMIZE_LIMIT,
  activeEventQuery, allPilotsQuery, buildEventTimelinePatch, buildServerLiveState, coachLlmRuntime, eventByIdQuery,
  coachSnapshotStore, ensureTrainingCsvFile, flushTrainingCsvQueue, getTrainingCsvStatus,
  ensureEventTimelineCurrent, flushPendingTrainingIntervals, getEventTimelineStatus,
  maybeBuildServerLiveState, processQueuedSerialPackets,
  rebuildEventTimelineFromSamples, refreshReceiverState, refreshTrainingCsvFileSize, upsertStat,
} = trainingRuntime;
rebuildTrainingTimelineFromSamples = rebuildEventTimelineFromSamples;
buildBackfillTimelinePatch = buildEventTimelinePatch;
let backfillDrainTimer = null;
function scheduleBackfillPersistenceDrain(delayMs = 0) {
  if (backfillDrainTimer || !pendingSerialPackets.some((queued) => queued.backfill)) return;
  backfillDrainTimer = setTimeout(() => {
    backfillDrainTimer = null;
    processQueuedSerialPackets();
    if (pendingSerialPackets.some((queued) => queued.backfill)) {
      scheduleBackfillPersistenceDrain(BACKFILL_DRAIN_INTERVAL_MS);
    }
  }, Math.max(0, delayMs));
  backfillDrainTimer.unref?.();
}
requestBackfillPersistenceDrain = () => scheduleBackfillPersistenceDrain(0);
const teachingBridge = {};
const coachFeature = registerCoachFeature({
  activeEventQuery, allPilotsQuery, app, coachLlmConfigKey: COACH_LLM_CONFIG_KEY, coachLlmRuntime,
  coachSnapshotIntervalMs: COACH_SNAPSHOT_INTERVAL_MS, coachSnapshotStore,
  coachStaleAfterMs: COACH_STALE_AFTER_MS, coachWindowMs: COACH_WINDOW_MS, db,
  defaultCoachLlmConfig: DEFAULT_COACH_LLM_CONFIG, eventFromRow, getParticipantTrainingWindow,
  optionalTimestamp, pilotFromRow, readCachedEventOverview, safeJsonParse, teaching: teachingBridge,
});
const {
  applyThinkingMode, buildCoachPilotSnapshot, coachLlmSignature,
  getCoachLlmConfig, getCoachSnapshot,
  historyEventSnapshots, refreshCoachSnapshot,
  requestCoachEventSummary, requestCoachLlmSuggestion, requestHistoryClassSummary,
  requestHistoryStudentSummary, requireCoachPassword, saveCoachLlmConfig,
} = coachFeature;
const teachingFeature = registerTeachingRoutes({
  activeEventQuery, allPilotsQuery, app, applyThinkingMode,
  buildCoachPilotSnapshot, coachLlmRuntime, coachLlmSignature, computeEventOverview, db,
  defaultLessonBudgetConfig: DEFAULT_LESSON_BUDGET_CONFIG, ensureEventTimelineCurrent,
  eventFromRow, getCoachLlmConfig, getEventTimelineStatus,
  getCoachSnapshot, getLessonTrackRow, historyEventSnapshots,
  lessonBudgetConfigKey: LESSON_BUDGET_CONFIG_KEY, lessonExtraMaterialKey: LESSON_EXTRA_MATERIAL_KEY,
  lessonSystemPromptKey: LESSON_SYSTEM_PROMPT_KEY, lessonTeachingManualKey: LESSON_TEACHING_MANUAL_KEY,
  getParticipantTrainingWindow, optionalTimestamp, parseAiJsonContent, persistEventOverview,
  personalLessonOptimizeLimit: PERSONAL_LESSON_OPTIMIZE_LIMIT, pilotFromRow, qweatherGet,
  readCachedEventOverview, requestCoachEventSummary,
  requestCoachLlmSuggestion, requestHistoryClassSummary, requestHistoryStudentSummary,
  requireCoachPassword, runTransaction, safeJsonParse, saveCoachLlmConfig, settingJson,
  setSettingJson, trackFromRow, upsertStat,
  uploadsDir,
});
Object.assign(teachingBridge, teachingFeature);
const { buildCoachTasks, comparePilotProgress, lessonReviewsForEvent } = teachingFeature;
function publishServerHeartbeat() {
  try {
    const now = Date.now();
    refreshReceiverState(now, true);
    const eventRow = activeEventQuery.get();
    const event = eventRow ? eventFromRow(eventRow) : null;
    const state = maybeBuildServerLiveState(event, now);
    if (state) broadcastLiveState("default", state);
  } catch (error) {
    serverLiveState.receiverState.error = error.message || "server heartbeat failed";
  }
}

ensureTrainingCsvFile();
refreshTrainingCsvFileSize();
refreshCoachSnapshot();

const liveHeartbeat = setInterval(publishServerHeartbeat, LIVE_STATE_BROADCAST_INTERVAL_MS);
liveHeartbeat.unref?.();

const serialPersistenceTimer = setInterval(processQueuedSerialPackets, SERIAL_PERSISTENCE_INTERVAL_MS);
serialPersistenceTimer.unref?.();

const trainingCsvFlushTimer = setInterval(flushTrainingCsvQueue, 1000);
trainingCsvFlushTimer.unref?.();

const coachSnapshotTimer = setInterval(refreshCoachSnapshot, COACH_SNAPSHOT_INTERVAL_MS);
coachSnapshotTimer.unref?.();

server.on("close", () => {
  clearInterval(coachSnapshotTimer);
  clearInterval(serialPersistenceTimer);
  clearInterval(trainingCsvFlushTimer);
  if (backfillDrainTimer) clearTimeout(backfillDrainTimer);
  backfillDrainTimer = null;
  for (const timer of backfillFinalizeTimers.values()) clearTimeout(timer);
  backfillFinalizeTimers.clear();
  for (const timer of backfillProgressTimers.values()) clearTimeout(timer);
  backfillProgressTimers.clear();
  backfillFinalizeStateByEvent.clear();
  while (pendingSerialPackets.length) processQueuedSerialPackets({ force: true });
  flushPendingTrainingIntervals(Date.now(), true);
  flushTrainingCsvQueue();
});

app.use(express.static("dist"));

// Requests that look like static assets (they carry a file extension) must
// never fall back to index.html. Otherwise a missing asset such as
// /betaflight/resources/motor_order/quad_x.svg would return the SPA HTML, and
// an <img> pointed at it would recursively render the whole configurator
// (the "dialog shows itself" bug on the motor-direction popup).
const looksLikeAsset = (requestPath) => /\.[a-z0-9]{1,8}$/i.test(requestPath.split("?")[0]);

if (betaflightModernAvailable) {
  app.get(/^\/betaflight(?:\/.*)?$/, (req, res) => {
    if (looksLikeAsset(req.path)) return res.status(404).end();
    res.sendFile(path.join(betaflightModernDistDir, "index.html"));
  });
}

if (betaflightLegacyAvailable) {
  app.get(/^\/betaflight-legacy(?:\/.*)?$/, (req, res) => {
    if (looksLikeAsset(req.path)) return res.status(404).end();
    res.sendFile(path.join(betaflightLegacyDistDir, "index.html"));
  });
}

app.get(/.*/, (req, res) => {
  res.sendFile(path.resolve("dist/index.html"));
});

server.listen(PORT, HOST, () => {
  console.log(`Server running: http://${HOST}:${PORT}`);
  console.log(`SQLite DB: ${dbFile}`);
});
