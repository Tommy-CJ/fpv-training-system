import express from "express";
import { Buffer } from "node:buffer";
import fs from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";

const app = express();
const server = http.createServer(app);
const PORT = 3000;

const dataDir = path.resolve("data");
const bracketStateFile = path.join(dataDir, "bracket-state.json");
const pilotsJsonFile = path.join(dataDir, "pilots.json");
const eventsJsonFile = path.join(dataDir, "events.json");
const dbFile = path.join(dataDir, "training.db");
let bracketStateCache = null;
let bracketStateCacheLoaded = false;

app.use(express.json({ limit: "10mb" }));

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
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
  { id: "pilot-1", name: "选手1", rates: "BF: 600/600/500", note: "新手，注意控高", channelConfig: defaultChannelConfig },
  { id: "pilot-2", name: "选手2", rates: "BF: 550/550/450", note: "", channelConfig: defaultChannelConfig },
];

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return safeJsonParse(fs.readFileSync(filePath, "utf-8"), fallback);
}

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
const SAMPLE_WRITE_INTERVAL_MS = 200;
const STATS_REFRESH_INTERVAL_MS = 1000;
const RECEIVER_DB_WRITE_INTERVAL_MS = 1000;
const LIVE_BATCH_BROADCAST_INTERVAL_MS = 33;
const MAX_SAMPLE_GAP_MS = 1000;
const RECENT_SAMPLE_WINDOW_MS = 5000;
const LIVE_STATE_BROADCAST_INTERVAL_MS = 1000;
const RECEIVER_OFFLINE_AFTER_MS = 2500;
const LIVE_RELAY_MAX_BUFFER_BYTES = 512 * 1024;
const receiverDbWriteTimes = new Map();
const pendingLiveBatches = new Map();
const pendingSerialPackets = new Map();
let lastReceiverOfflineMarkAt = 0;

function crsfToPwm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(((number - 172) * 1000) / (1811 - 172) + 1000);
}

function isValueInRanges(value, ranges) {
  return ranges?.some((range) => value >= Number(range.min) && value <= Number(range.max));
}

function getRanges(config, type) {
  const entries = [];
  Object.entries(config || {}).forEach(([channelKey, ranges]) => {
    (ranges || []).forEach((range) => {
      if (range.type === type) entries.push({ ...range, channelKey });
    });
  });
  return entries;
}

function getPilotMode(pilot, sample) {
  const channels = sample?.channels || {};
  const modeRanges = getRanges(pilot?.channelConfig || {}, "mode");
  return modeRanges.find((range) => isValueInRanges(channels[range.channelKey], [range]))?.name || "Acro";
}

function getPilotState(pilot, sample, recentSamples) {
  const channels = sample?.channels || {};
  const config = pilot?.channelConfig || {};
  const armRanges = getRanges(config, "arm");
  const turtleRanges = getRanges(config, "turtle");
  const armed = armRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const turtleSwitch = turtleRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const throttleValues = recentSamples.map((item) => item.channels?.ch3).filter((value) => Number.isFinite(value));
  const throttleSpread = throttleValues.length ? Math.max(...throttleValues) - Math.min(...throttleValues) : 0;
  const turtle = armed && turtleSwitch;
  const flying = armed && throttleSpread > 80;
  return { armed, mode: getPilotMode(pilot, sample), turtleSwitch, turtle, flying, idle: !turtle && !flying, throttleSpread };
}

function parseSerialPacket(packet, receivedAt = Date.now()) {
  const frameTime = Number(packet?.t) || null;
  const items = packet?.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
  const samples = [];

  for (const item of items) {
    const receiverId = Number(item?.rx);
    const channels = Array.isArray(item?.ch) ? item.ch : [];
    if (!Number.isFinite(receiverId) || receiverId < 1 || channels.length < 8) continue;

    const pwmChannels = channels.slice(0, 8).map(crsfToPwm);
    if (pwmChannels.some((value) => value === null)) continue;

    const linkQuality = Number(item.lq ?? item.linkQuality ?? 0);
    const rssi = Number(item.rssi ?? -127);
    samples.push({
      time: receivedAt,
      sourceTime: Number(item.t) || frameTime,
      receiverId,
      rawChannels: channels.slice(0, 8).map(Number),
      lq: Number.isFinite(linkQuality) ? linkQuality : 0,
      rssi: Number.isFinite(rssi) ? rssi : -127,
      channels: {
        ch1: pwmChannels[0],
        ch2: pwmChannels[1],
        ch3: pwmChannels[2],
        ch4: pwmChannels[3],
        ch5: pwmChannels[4],
        ch6: pwmChannels[5],
        ch7: pwmChannels[6],
        ch8: pwmChannels[7],
      },
    });
  }

  return samples;
}

function compactLiveItem(item) {
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

function compactLiveBatch(packet) {
  if (!packet || typeof packet !== "object") return packet;
  if (packet.type === "rx_batch" && Array.isArray(packet.items)) {
    const compact = {
      type: "rx_batch",
      v: Number(packet.v) || 1,
      items: packet.items.map(compactLiveItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    const time = Number(packet.t);
    if (Number.isFinite(time)) compact.t = time;
    return compact;
  }
  return compactLiveItem(packet);
}

function getLiveRoom(roomId = "default") {
  const safeRoomId = String(roomId || "default").slice(0, 64);
  if (!liveRooms.has(safeRoomId)) {
    liveRooms.set(safeRoomId, {
      publishers: new Set(),
      subscribers: new Set(),
      lastBatch: null,
      updatedAt: null,
      currentState: null,
      stateUpdatedAt: null,
    });
  }
  return liveRooms.get(safeRoomId);
}

function writeWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed) return;
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
  socket.write(Buffer.concat([header, payloadBuffer]));
}

function sendLiveSocketJson(client, message) {
  writeWebSocketFrame(client.socket, 0x1, Buffer.from(JSON.stringify(message), "utf-8"));
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

function joinLiveRoom(client, roomId, role) {
  removeLiveClient(client);
  const room = getLiveRoom(roomId);
  client.roomId = String(roomId || "default").slice(0, 64);
  client.role = role;
  if (role === "publisher") room.publishers.add(client);
  if (role === "subscriber") {
    room.subscribers.add(client);
    if (room.currentState) {
      sendLiveSocketJson(client, {
        type: "live_state",
        room: client.roomId,
        state: room.currentState,
        serverTime: room.stateUpdatedAt || Date.now(),
      });
    }
    if (room.lastBatch) {
      sendLiveSocketJson(client, {
        type: "live_batch",
        room: client.roomId,
        batch: room.lastBatch,
        serverTime: room.updatedAt,
      });
    }
  }
  sendLiveSocketJson(client, { type: "live_ack", role, room: client.roomId, serverTime: Date.now() });
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
  };

  for (const subscriber of room.subscribers) {
    if (subscriber.socket.destroyed || subscriber.socket.writableLength > 512 * 1024) continue;
    sendLiveSocketJson(subscriber, outgoing);
  }
}

function broadcastLiveBatch(roomId, batch, serverTime) {
  const room = getLiveRoom(roomId);
  room.lastBatch = batch;
  room.updatedAt = serverTime;
  const outgoing = {
    type: "live_batch",
    room: String(roomId || "default").slice(0, 64),
    batch,
    serverTime,
  };

  for (const subscriber of room.subscribers) {
    if (subscriber.socket.destroyed || subscriber.socket.writableLength > LIVE_RELAY_MAX_BUFFER_BYTES) continue;
    sendLiveSocketJson(subscriber, outgoing);
  }
}

function queueLiveBatchForBroadcast(roomId, batch, serverTime) {
  pendingLiveBatches.set(String(roomId || "default").slice(0, 64), {
    batch: compactLiveBatch(batch),
    serverTime,
  });
}

function processQueuedLiveBatches() {
  const entries = [...pendingLiveBatches.entries()];
  pendingLiveBatches.clear();
  for (const [roomId, queued] of entries) {
    broadcastLiveBatch(roomId, queued.batch, queued.serverTime);
  }
}

function queueSerialPacketForPersistence(roomId, packet, receivedAt) {
  pendingSerialPackets.set(String(roomId || "default").slice(0, 64), { packet, receivedAt });
}

function handleLiveSocketMessage(client, message) {
  if (message.type === "publish_live") {
    joinLiveRoom(client, message.room || "default", "publisher");
    return;
  }
  if (message.type === "subscribe_live") {
    joinLiveRoom(client, message.room || "default", "subscriber");
    return;
  }
  if (message.type === "live_state" && client.role === "publisher") {
    broadcastLiveState(client.roomId || message.room || "default", message.state || null);
    return;
  }
  if (!["live_batch", "serial_packet"].includes(message.type) || client.role !== "publisher") return;

  const roomId = client.roomId || message.room || "default";
  const batch = message.batch || message.packet || null;
  if (!batch) return;

  const receivedAt = Date.now();
  queueLiveBatchForBroadcast(roomId, batch, receivedAt);
  queueSerialPacketForPersistence(roomId, batch, receivedAt);
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

db.exec(`
  CREATE TABLE IF NOT EXISTS pilots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rates TEXT NOT NULL DEFAULT '',
    rate_profile_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    channel_config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    participants_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    receiver_id INTEGER NOT NULL,
    time INTEGER NOT NULL,
    ch1 INTEGER, ch2 INTEGER, ch3 INTEGER, ch4 INTEGER,
    ch5 INTEGER, ch6 INTEGER, ch7 INTEGER, ch8 INTEGER,
    armed INTEGER NOT NULL DEFAULT 0,
    flying INTEGER NOT NULL DEFAULT 0,
    turtle INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_training_samples_event_pilot_time
    ON training_samples(event_id, pilot_id, time);
  CREATE TABLE IF NOT EXISTS training_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_training_segments_event_pilot
    ON training_segments(event_id, pilot_id);
  CREATE TABLE IF NOT EXISTS training_event_stats (
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    total_flight_ms INTEGER NOT NULL DEFAULT 0,
    utilization REAL NOT NULL DEFAULT 0,
    idle_ms INTEGER,
    total_turtle_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, pilot_id)
  );
  CREATE TABLE IF NOT EXISTS training_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receivers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    binding INTEGER NOT NULL DEFAULT 0,
    bind_requested_at INTEGER,
    last_seen_at INTEGER NOT NULL
  );
`);

const pilotColumns = db.prepare("PRAGMA table_info(pilots)").all().map((column) => column.name);
if (!pilotColumns.includes("rate_profile_json")) {
  db.exec("ALTER TABLE pilots ADD COLUMN rate_profile_json TEXT");
}

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

function computeTimelineStats(samples, eventStart, eventEnd) {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const firstTime = sorted[0]?.time || Date.now();
  const safeStart = Number(eventStart) || firstTime;
  const safeEnd = Math.max(safeStart, Number(eventEnd) || Date.now());
  let totalFlightMs = 0;
  let totalTurtleMs = 0;
  let lastFlightEnd = null;
  const segments = [];
  let current = null;

  function closeSegment(endTime) {
    if (!current) return;
    const endedAt = Math.max(current.startedAt, endTime);
    segments.push({
      type: current.type,
      startedAt: current.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - current.startedAt),
    });
    current = null;
  }

  for (let index = 0; index < sorted.length; index += 1) {
    const sample = sorted[index];
    if (sample.time > safeEnd) break;
    if (sample.time < safeStart - MAX_SAMPLE_GAP_MS) continue;

    const intervalStart = Math.max(safeStart, sample.time);
    const nextTime = sorted[index + 1]?.time;
    if (!nextTime || nextTime - sample.time > MAX_SAMPLE_GAP_MS) continue;
    const intervalEnd = Math.min(safeEnd, nextTime, sample.time + MAX_SAMPLE_GAP_MS);
    if (intervalEnd <= intervalStart) continue;

    const type = sample.turtle ? "turtle" : sample.flying ? "flight" : "idle";
    const durationMs = intervalEnd - intervalStart;
    if (type === "flight") {
      totalFlightMs += durationMs;
      lastFlightEnd = intervalEnd;
    }
    if (type === "turtle") totalTurtleMs += durationMs;

    if (current && current.type !== type) closeSegment(intervalStart);
    if (!current && type) current = { type, startedAt: intervalStart, endedAt: intervalEnd };
    if (current && current.type === type) current.endedAt = intervalEnd;
  }

  if (current) closeSegment(current.endedAt);

  const duration = Math.max(1, safeEnd - safeStart);
  return {
    totalFlightMs,
    utilization: totalFlightMs / duration,
    idleMs: lastFlightEnd === null ? null : Math.max(0, safeEnd - lastFlightEnd),
    totalTurtleMs,
    segments,
  };
}

function computeEventOverview(event, eventId) {
  const rows = db.prepare(`
    SELECT pilot_id, time, armed, flying, turtle
    FROM training_samples
    WHERE event_id = ?
    ORDER BY pilot_id ASC, time ASC
  `).all(eventId);
  const samplesByPilot = new Map();
  for (const row of rows) {
    const list = samplesByPilot.get(row.pilot_id) || [];
    list.push({
      time: row.time,
      armed: Boolean(row.armed),
      flying: Boolean(row.flying),
      turtle: Boolean(row.turtle),
    });
    samplesByPilot.set(row.pilot_id, list);
  }

  const now = Date.now();
  const eventEnd = event.endedAt || now;
  const pilotIds = new Set([
    ...event.participants.map((participant) => participant.pilotId),
    ...samplesByPilot.keys(),
  ]);
  const stats = [];
  const segments = [];
  const sampleCounts = {};

  for (const pilotId of pilotIds) {
    const samples = samplesByPilot.get(pilotId) || [];
    sampleCounts[pilotId] = samples.length;
    const computed = computeTimelineStats(samples, event.startedAt || event.createdAt, eventEnd);
    stats.push({
      event_id: eventId,
      pilot_id: pilotId,
      total_flight_ms: computed.totalFlightMs,
      utilization: computed.utilization,
      idle_ms: computed.idleMs,
      total_turtle_ms: computed.totalTurtleMs,
      updated_at: now,
    });
    for (const segment of computed.segments) {
      segments.push({
        event_id: eventId,
        pilot_id: pilotId,
        type: segment.type,
        started_at: segment.startedAt,
        ended_at: segment.endedAt,
        duration_ms: segment.durationMs,
      });
    }
  }

  return { stats, segments, sampleCounts };
}

function persistEventOverview(eventId, overview) {
  runTransaction(() => {
    for (const stat of overview.stats) {
      upsertStat.run(
        eventId,
        stat.pilot_id,
        Math.round(stat.total_flight_ms || 0),
        Number(stat.utilization || 0),
        stat.idle_ms ?? null,
        Math.round(stat.total_turtle_ms || 0),
        stat.updated_at,
      );
    }
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(eventId);
    const insertSegment = db.prepare(`
      INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const segment of overview.segments) {
      insertSegment.run(
        eventId,
        segment.pilot_id,
        segment.type,
        segment.started_at,
        segment.ended_at,
        segment.duration_ms,
      );
    }
  });
}

function readCachedEventOverview(eventId) {
  const stats = db.prepare(`
    SELECT event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, updated_at
    FROM training_event_stats
    WHERE event_id = ?
    ORDER BY pilot_id
  `).all(eventId);
  const segments = db.prepare(`
    SELECT event_id, pilot_id, type, started_at, ended_at, duration_ms
    FROM training_segments
    WHERE event_id = ?
    ORDER BY started_at ASC
  `).all(eventId);
  return { stats, segments };
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

app.get("/api/state", (req, res) => {
  if (!bracketStateCacheLoaded) {
    bracketStateCache = fs.existsSync(bracketStateFile) ? readJsonIfExists(bracketStateFile, null) : null;
    bracketStateCacheLoaded = true;
  }
  res.json(bracketStateCache);
});

app.post("/api/state", (req, res) => {
  bracketStateCache = req.body;
  bracketStateCacheLoaded = true;
  fs.writeFileSync(bracketStateFile, JSON.stringify(bracketStateCache, null, 2), "utf-8");
  res.json({ ok: true });
});

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
    participants: event.participants.map((participant) => {
      const pilot = pilots.get(participant.pilotId);
      const stat = statsByPilot.get(participant.pilotId);
      const segments = segmentsByPilot.get(participant.pilotId) || [];
      return {
        ...participant,
        pilotName: pilot?.name || participant.pilotId,
        rates: pilot?.rates || "",
        totalFlightMs: stat?.total_flight_ms || 0,
        utilization: stat?.utilization || 0,
        idleMs: stat?.idle_ms ?? null,
        totalTurtleMs: stat?.total_turtle_ms || 0,
        sampleCount: overview.sampleCounts[participant.pilotId] || 0,
        samples: [],
        segments,
      };
    }),
  });
});

app.delete("/api/events/:id", (req, res) => {
  runTransaction(() => {
    db.prepare("DELETE FROM training_event_stats WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(req.params.id);
    db.prepare("DELETE FROM training_samples WHERE event_id = ?").run(req.params.id);
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
  for (const event of events) {
    const name = String(event.name || "").trim();
    if (!name) return res.status(400).json({ error: "training event name is required" });
    const existingId = names.get(name);
    if (existingId && existingId !== event.id) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, event.id);
    if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
    names.set(name, event.id);
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
    }
  });
  res.json({ ok: true });
});

app.post("/api/events/start", (req, res) => {
  const now = Date.now();
  const id = req.body?.id || `event-${now}`;
  const name = String(req.body?.name || "训练").trim();
  const startedAt = req.body?.startedAt || now;
  const duplicate = db.prepare("SELECT id FROM training_events WHERE name = ? AND id <> ?").get(name, id);
  if (duplicate) return res.status(409).json({ error: `duplicate training event name: ${name}` });
  db.prepare("UPDATE training_events SET active = 0, updated_at = ? WHERE active = 1").run(now);
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
  res.json({ ok: true, event: eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(id)) });
});

app.post("/api/events/:id/end", (req, res) => {
  const now = Date.now();
  db.prepare("UPDATE training_events SET active = 0, ended_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);
  res.json({ ok: true, event: eventFromRow(db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id)) });
});

app.get("/api/training-live", (req, res) => {
  res.json({
    receiverCount: getReceiverCount(),
    receivers: getReceivers(),
    samples: [],
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
    (event_id, pilot_id, receiver_id, time, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, armed, flying, turtle)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

const upsertStat = db.prepare(`
  INSERT INTO training_event_stats
    (event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id, pilot_id) DO UPDATE SET
    total_flight_ms = excluded.total_flight_ms,
    utilization = excluded.utilization,
    idle_ms = excluded.idle_ms,
    total_turtle_ms = excluded.total_turtle_ms,
    updated_at = excluded.updated_at
`);

const activeEventQuery = db.prepare(`
  SELECT *
  FROM training_events
  WHERE active = 1
  ORDER BY COALESCE(started_at, created_at) DESC
  LIMIT 1
`);
const allEventsQuery = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC");
const allPilotsQuery = db.prepare("SELECT * FROM pilots");
const upsertReceiverSeen = db.prepare(`
  INSERT INTO receivers (id, name, online, binding, bind_requested_at, last_seen_at)
  VALUES (?, ?, 1, 0, NULL, ?)
  ON CONFLICT(id) DO UPDATE SET
    online = 1,
    binding = 0,
    last_seen_at = excluded.last_seen_at
`);
const markOfflineReceivers = db.prepare("UPDATE receivers SET online = 0 WHERE last_seen_at < ?");
const lastSegmentQuery = db.prepare(`
  SELECT id, type, started_at, ended_at, duration_ms
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ?
  ORDER BY ended_at DESC, id DESC
  LIMIT 1
`);
const insertTrainingSegment = db.prepare(`
  INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const updateTrainingSegment = db.prepare(`
  UPDATE training_segments
  SET ended_at = ?, duration_ms = ?
  WHERE id = ?
`);
const segmentTotalsQuery = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN type = 'flight' THEN duration_ms ELSE 0 END), 0) AS total_flight_ms,
    COALESCE(SUM(CASE WHEN type = 'turtle' THEN duration_ms ELSE 0 END), 0) AS total_turtle_ms,
    MAX(CASE WHEN type = 'flight' THEN ended_at ELSE NULL END) AS last_flight_end
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ?
`);

function stateTypeFromSample(sample) {
  return sample?.turtle ? "turtle" : sample?.flying ? "flight" : "idle";
}

function refreshReceiverState(now = Date.now(), writeDb = false) {
  if (writeDb && now - lastReceiverOfflineMarkAt >= RECEIVER_DB_WRITE_INTERVAL_MS) {
    markOfflineReceivers.run(now - RECEIVER_OFFLINE_AFTER_MS);
    lastReceiverOfflineMarkAt = now;
  }
  const activeReceiverIds = Object.entries(serverLiveState.latestSamplesByReceiver)
    .filter(([, sample]) => now - Number(sample?.time || 0) <= RECEIVER_OFFLINE_AFTER_MS)
    .map(([receiverId]) => Number(receiverId))
    .filter((receiverId) => Number.isFinite(receiverId));
  serverLiveState.receiverState.connected = activeReceiverIds.length > 0;
  serverLiveState.receiverState.receiverCount = activeReceiverIds.length;
  serverLiveState.receiverState.maxReceiverId = Math.max(0, ...activeReceiverIds);
  if (!activeReceiverIds.length && serverLiveState.receiverState.lastDataAt && now - serverLiveState.receiverState.lastDataAt > RECEIVER_OFFLINE_AFTER_MS) {
    serverLiveState.receiverState.lastReceiverId = null;
  }
}

function updateReceiversFromSamples(samples, receivedAt) {
  const receiverIds = new Set();
  for (const sample of samples) {
    receiverIds.add(sample.receiverId);
    serverLiveState.latestSamplesByReceiver[sample.receiverId] = sample;
    const lastWriteAt = receiverDbWriteTimes.get(sample.receiverId) || 0;
    if (receivedAt - lastWriteAt >= RECEIVER_DB_WRITE_INTERVAL_MS) {
      upsertReceiverSeen.run(sample.receiverId, `RX ${sample.receiverId}`, receivedAt);
      receiverDbWriteTimes.set(sample.receiverId, receivedAt);
    }
  }
  refreshReceiverState(receivedAt);
  serverLiveState.receiverState.connected = true;
  serverLiveState.receiverState.packetCount += 1;
  serverLiveState.receiverState.lastDataAt = receivedAt;
  serverLiveState.receiverState.lastReceiverId = [...receiverIds].pop() || null;
  serverLiveState.receiverState.error = "";
}

function getRuntimeForEvent(event, now = Date.now()) {
  let runtime = runtimeEvents.get(event.id);
  if (!runtime) {
    runtime = {
      event,
      participantByReceiver: new Map(),
      pilotsById: new Map(),
      recentByPilot: new Map(),
      lastPersistedByPilot: new Map(),
      lastStatsRefreshByPilot: new Map(),
      contextLoadedAt: 0,
    };
    runtimeEvents.set(event.id, runtime);
  }

  if (now - runtime.contextLoadedAt > 1000) {
    runtime.event = event;
    runtime.participantByReceiver = new Map(
      event.participants
        .map((participant) => [Number(participant.receiverId), participant])
        .filter(([receiverId]) => Number.isFinite(receiverId)),
    );
    runtime.pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    runtime.contextLoadedAt = now;
  }

  return runtime;
}

function appendTrainingInterval(eventId, pilotId, type, startedAt, endedAt) {
  if (!type || endedAt <= startedAt) return;
  const lastSegment = lastSegmentQuery.get(eventId, pilotId);
  if (lastSegment && lastSegment.type === type && startedAt <= lastSegment.ended_at + MAX_SAMPLE_GAP_MS) {
    const nextEndedAt = Math.max(lastSegment.ended_at, endedAt);
    updateTrainingSegment.run(nextEndedAt, Math.max(0, nextEndedAt - lastSegment.started_at), lastSegment.id);
    return;
  }
  insertTrainingSegment.run(eventId, pilotId, type, startedAt, endedAt, Math.max(0, endedAt - startedAt));
}

function refreshPilotStatsFromSegments(event, pilotId, now = Date.now()) {
  const totals = segmentTotalsQuery.get(event.id, pilotId);
  const eventStart = event.startedAt || event.createdAt || now;
  const eventEnd = event.endedAt || now;
  const totalFlightMs = Math.round(totals?.total_flight_ms || 0);
  const totalTurtleMs = Math.round(totals?.total_turtle_ms || 0);
  const idleMs = totals?.last_flight_end === null || totals?.last_flight_end === undefined
    ? null
    : Math.max(0, eventEnd - totals.last_flight_end);
  upsertStat.run(
    event.id,
    pilotId,
    totalFlightMs,
    totalFlightMs / Math.max(1, eventEnd - eventStart),
    idleMs,
    totalTurtleMs,
    now,
  );
}

function getLastPersistedSample(runtime, eventId, pilotId) {
  if (!runtime.lastPersistedByPilot.has(pilotId)) {
    const row = lastSampleDetail.get(eventId, pilotId);
    runtime.lastPersistedByPilot.set(pilotId, row || null);
  }
  return runtime.lastPersistedByPilot.get(pilotId);
}

function refreshPilotStatsThrottled(runtime, event, pilotId, now = Date.now(), force = false) {
  const lastRefreshAt = runtime.lastStatsRefreshByPilot.get(pilotId) || 0;
  if (!force && now - lastRefreshAt < STATS_REFRESH_INTERVAL_MS) return;
  refreshPilotStatsFromSegments(event, pilotId, now);
  runtime.lastStatsRefreshByPilot.set(pilotId, now);
}

function persistProcessedSample(event, pilot, participant, rawSample, runtime, receivedAt) {
  const pilotId = participant.pilotId;
  const receiverId = Number(participant.receiverId) || rawSample.receiverId;
  const sampleTime = Number(rawSample.time) || receivedAt;
  const recentBefore = (runtime.recentByPilot.get(pilotId) || [])
    .filter((sample) => sample.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
  const baseSample = { ...rawSample, pilotId, receiverId, time: sampleTime };
  const state = getPilotState(pilot, baseSample, [...recentBefore, baseSample]);
  const sample = {
    ...baseSample,
    mode: state.mode,
    armed: state.armed,
    flying: state.flying,
    turtle: state.turtle,
    idle: state.idle,
    throttleSpread: state.throttleSpread,
  };

  recentBefore.push(sample);
  runtime.recentByPilot.set(pilotId, recentBefore.slice(-120));
  serverLiveState.latestSamplesByReceiver[receiverId] = sample;

  const previous = getLastPersistedSample(runtime, event.id, pilotId);
  if (previous && sampleTime <= previous.time) return sample;
  if (previous && sampleTime - previous.time < SAMPLE_WRITE_INTERVAL_MS) return sample;

  insertSample.run(
    event.id,
    pilotId,
    receiverId,
    sampleTime,
    sampleChannelValue(sample, "ch1"),
    sampleChannelValue(sample, "ch2"),
    sampleChannelValue(sample, "ch3"),
    sampleChannelValue(sample, "ch4"),
    sampleChannelValue(sample, "ch5"),
    sampleChannelValue(sample, "ch6"),
    sampleChannelValue(sample, "ch7"),
    sampleChannelValue(sample, "ch8"),
    sample.armed ? 1 : 0,
    sample.flying ? 1 : 0,
    sample.turtle ? 1 : 0,
  );

  const persistedSample = {
    time: sampleTime,
    armed: sample.armed ? 1 : 0,
    flying: sample.flying ? 1 : 0,
    turtle: sample.turtle ? 1 : 0,
  };
  runtime.lastPersistedByPilot.set(pilotId, persistedSample);

  const crossedInputBreak = previous &&
    runtime.inputInterruptedAt &&
    runtime.inputInterruptedAt >= previous.time &&
    runtime.inputInterruptedAt <= sampleTime;
  if (previous && !crossedInputBreak && sampleTime - previous.time <= MAX_SAMPLE_GAP_MS) {
    appendTrainingInterval(event.id, pilotId, stateTypeFromSample(previous), previous.time, sampleTime);
  }
  refreshPilotStatsThrottled(runtime, event, pilotId, receivedAt);
  return sample;
}

function buildServerLiveState(event, now = Date.now()) {
  const overview = event ? readCachedEventOverview(event.id) : { stats: [] };
  const summaries = {};
  for (const stat of overview.stats || []) {
    summaries[stat.pilot_id] = {
      pilotId: stat.pilot_id,
      totalFlightMs: stat.total_flight_ms || 0,
      utilization: stat.utilization || 0,
      idleMs: stat.idle_ms ?? null,
      totalTurtleMs: stat.total_turtle_ms || 0,
      updatedAt: stat.updated_at || now,
    };
  }

  return {
    version: 3,
    serverManaged: true,
    updatedAt: now,
    event,
    events: allEventsQuery.all().map(eventFromRow),
    participants: event?.participants || [],
    summaries,
    latestSamplesByReceiver: serverLiveState.latestSamplesByReceiver,
    receiverState: serverLiveState.receiverState,
  };
}

function maybeBuildServerLiveState(event, now = Date.now(), force = false) {
  if (!force && now - (serverLiveState.lastStateBroadcastAt || 0) < LIVE_STATE_BROADCAST_INTERVAL_MS) return null;
  serverLiveState.lastStateBroadcastAt = now;
  return buildServerLiveState(event, now);
}

function processServerSerialPacket(packet, { receivedAt = Date.now() } = {}) {
  try {
    const rawSamples = parseSerialPacket(packet, receivedAt);
    if (!rawSamples.length) return null;

    updateReceiversFromSamples(rawSamples, receivedAt);
    const eventRow = activeEventQuery.get();
    if (!eventRow) return maybeBuildServerLiveState(null, receivedAt);

    const event = eventFromRow(eventRow);
    const runtime = getRuntimeForEvent(event, receivedAt);
    for (const rawSample of rawSamples) {
      const participant = runtime.participantByReceiver.get(Number(rawSample.receiverId));
      if (!participant) continue;
      const pilot = runtime.pilotsById.get(participant.pilotId);
      if (!pilot) continue;
      persistProcessedSample(event, pilot, participant, rawSample, runtime, receivedAt);
    }

    return maybeBuildServerLiveState(event, receivedAt);
  } catch (error) {
    serverLiveState.receiverState.error = error.message || "serial packet processing failed";
    return maybeBuildServerLiveState(null, Date.now(), true);
  }
}

function processQueuedSerialPackets() {
  const entries = [...pendingSerialPackets.entries()];
  pendingSerialPackets.clear();
  for (const [roomId, queued] of entries) {
    const serverState = processServerSerialPacket(queued.packet, {
      roomId,
      receivedAt: queued.receivedAt,
    });
    if (serverState) broadcastLiveState(roomId, serverState);
  }
}

app.post("/api/training-events/:id/stats", (req, res) => {
  const stats = Array.isArray(req.body?.stats) ? req.body.stats : [];
  const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
  const now = Date.now();
  runTransaction(() => {
    for (const stat of stats) {
      upsertStat.run(
        req.params.id,
        stat.pilotId,
        Math.round(stat.totalFlightMs || 0),
        Number(stat.utilization || 0),
        stat.idleMs ?? null,
        Math.round(stat.totalTurtleMs || 0),
        now,
      );
    }
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(req.params.id);
    const insertSegment = db.prepare(`
      INSERT INTO training_segments (event_id, pilot_id, type, started_at, ended_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const segment of segments) {
      insertSegment.run(req.params.id, segment.pilotId, segment.type, segment.startedAt, segment.endedAt, segment.durationMs);
    }
  });
  res.json({ ok: true });
});

app.get("/api/training-events/:id/stats", (req, res) => {
  const eventRow = db.prepare("SELECT * FROM training_events WHERE id = ?").get(req.params.id);
  if (!eventRow) return res.status(404).json({ error: "event not found" });
  const cachedOverview = readCachedEventOverview(req.params.id);
  if (req.query.recompute !== "1") {
    return res.json(cachedOverview);
  }
  const event = eventFromRow(eventRow);
  const overview = computeEventOverview(event, req.params.id);
  persistEventOverview(req.params.id, overview);
  res.json({ stats: overview.stats, segments: overview.segments });
});

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

const liveHeartbeat = setInterval(publishServerHeartbeat, LIVE_STATE_BROADCAST_INTERVAL_MS);
liveHeartbeat.unref?.();

const liveBatchBroadcastTimer = setInterval(processQueuedLiveBatches, LIVE_BATCH_BROADCAST_INTERVAL_MS);
liveBatchBroadcastTimer.unref?.();

const serialPersistenceTimer = setInterval(processQueuedSerialPackets, SAMPLE_WRITE_INTERVAL_MS);
serialPersistenceTimer.unref?.();

app.use(express.static("dist"));

app.get(/.*/, (req, res) => {
  res.sendFile(path.resolve("dist/index.html"));
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`SQLite DB: ${dbFile}`);
});
