import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiverCount = Math.max(1, Math.min(16, Number(process.argv[2]) || 9));
const durationMs = Math.max(3000, Number(process.argv[3]) || 12_000);
const rateHz = 30;
const intervalMs = 1000 / rateHz;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
    socket.on("error", reject);
  });
}

function channels(receiverId, sequence, dynamic) {
  if (!dynamic) return [992, 992, 172, 992, 172, 172, 172, 172];
  const phase = sequence / 7 + receiverId * 0.41;
  return [
    Math.round(992 + Math.sin(phase) * 500),
    Math.round(992 + Math.cos(phase * 0.83) * 480),
    Math.round(850 + Math.sin(phase * 1.71) * 500),
    Math.round(992 + Math.sin(phase * 0.57) * 420),
    1792,
    992,
    sequence % 60 >= 45 && sequence % 60 < 55 ? 1792 : 172,
    172,
  ].map((value) => Math.max(172, Math.min(1811, value)));
}

function packet(sequence, dynamic) {
  return {
    type: "rx_batch",
    v: 1,
    t: Date.now(),
    items: Array.from({ length: receiverCount }, (_, index) => ({
      rx: index + 1,
      ch: channels(index + 1, sequence, dynamic),
      lq: dynamic ? 92 + (sequence + index) % 8 : 0,
      rssi: dynamic ? -45 - index : -127,
    })),
  };
}

const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "fpv-live-benchmark-"));
const port = await freePort();
const server = spawn(process.execPath, [path.join(repoRoot, "server.js")], {
  cwd: runtimeDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), COACH_PASSWORD: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function json(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-coach-password": "test",
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early\n${serverOutput}`);
    try {
      await json("/api/events");
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`server did not start\n${serverOutput}`);
}

function connect(role, onMessage = () => {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live-ws`);
    socket.addEventListener("message", (event) => onMessage(JSON.parse(event.data)));
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: role, room: "default" }));
      resolve(socket);
    }, { once: true });
  });
}

async function runScenario(label, dynamic, eventId) {
  const sentAt = new Map();
  const ackLatencies = [];
  const httpLatencies = [];
  let sentLive = 0;
  let sentPersistence = 0;
  let acknowledged = 0;
  let audienceFrames = 0;
  let lastAudienceAt = 0;
  let maxAudienceGapMs = 0;
  const publisher = await connect("publish_live", (message) => {
    if (message.type !== "live_packet_ack" || !message.packetId) return;
    const startedAt = sentAt.get(message.packetId);
    if (startedAt) ackLatencies.push(performance.now() - startedAt);
    sentAt.delete(message.packetId);
    acknowledged += 1;
  });
  const subscriber = await connect("subscribe_live", (message) => {
    if (message.type !== "live_batch") return;
    const now = performance.now();
    if (lastAudienceAt) maxAudienceGapMs = Math.max(maxAudienceGapMs, now - lastAudienceAt);
    lastAudienceAt = now;
    audienceFrames += 1;
  });

  let polling = true;
  const poll = (async () => {
    while (polling) {
      const startedAt = performance.now();
      await json("/api/training-csv/status");
      httpLatencies.push(performance.now() - startedAt);
      await delay(200);
    }
  })();

  const scenarioStartedAt = performance.now();
  let nextAt = scenarioStartedAt;
  let lastPersistenceAt = 0;
  let savedConfig = false;
  while (performance.now() - scenarioStartedAt < durationMs) {
    const now = performance.now();
    if (now < nextAt) {
      await delay(Math.min(4, nextAt - now));
      continue;
    }
    sentLive += 1;
    const capturedAt = Date.now();
    const batch = packet(sentLive, dynamic);
    const outgoing = {
      type: "live_batch",
      room: "default",
      batch,
      clientTime: capturedAt,
      liveOnly: true,
    };
    if (!lastPersistenceAt || capturedAt - lastPersistenceAt >= 200) {
      lastPersistenceAt = capturedAt;
      sentPersistence += 1;
      const packetId = `${label}:persist:${sentPersistence}`;
      sentAt.set(packetId, performance.now());
      Object.assign(outgoing, {
        clientSequence: sentPersistence,
        packetId,
        eventId,
        durable: true,
      });
    }
    publisher.send(JSON.stringify(outgoing));
    nextAt += intervalMs;
    if (!savedConfig && performance.now() - scenarioStartedAt >= durationMs / 2) {
      savedConfig = true;
      const events = await json("/api/events");
      const event = events.find((item) => item.id === eventId);
      event.participants[0].trainingStartAt = Number(event.participants[0].trainingStartAt) + 1;
      if (event.participants.length > 1) {
        const firstReceiver = event.participants[0].receiverId;
        event.participants[0].receiverId = event.participants[1].receiverId;
        event.participants[1].receiverId = firstReceiver;
      }
      const saveStartedAt = performance.now();
      await json("/api/events", { method: "POST", body: JSON.stringify(events) });
      httpLatencies.push(performance.now() - saveStartedAt);
    }
  }

  const drainDeadline = Date.now() + 15_000;
  while (acknowledged < sentPersistence && Date.now() < drainDeadline) await delay(20);
  polling = false;
  await poll;
  publisher.close();
  subscriber.close();
  return {
    label,
    sentPackets: sentLive,
    sentLive,
    durableFrames: sentPersistence,
    sentPersistence,
    extraPersistencePackets: 0,
    acknowledged,
    audienceFrames,
    inputFps: Number((sentLive / (durationMs / 1000)).toFixed(1)),
    durableFps: Number((sentPersistence / (durationMs / 1000)).toFixed(1)),
    persistenceFps: Number((sentPersistence / (durationMs / 1000)).toFixed(1)),
    audienceFps: Number((audienceFrames / (durationMs / 1000)).toFixed(1)),
    maxAudienceGapMs: Math.round(maxAudienceGapMs),
    ackP50Ms: Math.round(percentile(ackLatencies, 0.5)),
    ackP95Ms: Math.round(percentile(ackLatencies, 0.95)),
    ackMaxMs: Math.round(Math.max(0, ...ackLatencies)),
    httpP95Ms: Math.round(percentile(httpLatencies, 0.95)),
    httpMaxMs: Math.round(Math.max(0, ...httpLatencies)),
  };
}

try {
  await waitForServer();
  const pilots = Array.from({ length: receiverCount }, (_, index) => ({
    id: `pilot-${index + 1}`,
    name: `飞手 ${index + 1}`,
    channelConfig: {
      ch5: [{ name: "Arm", type: "arm", min: 1500, max: 2000 }],
      ch6: [],
      ch7: [{ name: "Turtle", type: "turtle", min: 1500, max: 2000 }],
      ch8: [],
    },
  }));
  await json("/api/pilots", { method: "POST", body: JSON.stringify(pilots) });
  const startedAt = Date.now();
  const started = await json("/api/events/start", {
    method: "POST",
    body: JSON.stringify({
      id: "benchmark-event",
      name: "九路实时压力验证",
      startedAt,
      participants: pilots.map((pilot, index) => ({
        pilotId: pilot.id,
        receiverId: index + 1,
        trainingStartAt: startedAt,
      })),
    }),
  });
  const fixed = await runScenario("fixed", false, started.event.id);
  await delay(100);
  const dynamic = await runScenario("dynamic", true, started.event.id);
  await delay(1200);
  const overview = await json(`/api/training-events/${started.event.id}/stats?cached=1`);
  const segmentsByPilot = new Map();
  for (const segment of overview.segments || []) {
    const list = segmentsByPilot.get(segment.pilot_id) || [];
    list.push(segment);
    segmentsByPilot.set(segment.pilot_id, list);
  }
  let maxSegmentGapMs = 0;
  for (const segments of segmentsByPilot.values()) {
    segments.sort((left, right) => left.started_at - right.started_at);
    for (let index = 1; index < segments.length; index += 1) {
      maxSegmentGapMs = Math.max(maxSegmentGapMs, segments[index].started_at - segments[index - 1].ended_at);
    }
  }
  const status = await json("/api/training-csv/status");
  const missingFlight = (overview.stats || []).filter((stat) => Number(stat.total_flight_ms || 0) <= 0);
  const missingTurtle = (overview.stats || []).filter((stat) => Number(stat.total_turtle_ms || 0) <= 0);
  if (missingFlight.length || missingTurtle.length) {
    throw new Error(`5Hz history did not preserve flight/turtle state: ${JSON.stringify({ missingFlight, missingTurtle, stats: overview.stats })}`);
  }
  if (status.ingest?.lastPacketMappedSamples !== receiverCount || status.ingest?.lastPacketRawSamples !== receiverCount) {
    throw new Error(`ingest health hid missing mapped samples: ${JSON.stringify(status.ingest)}`);
  }
  console.log(JSON.stringify({
    receiverCount,
    durationMs,
    fixed,
    dynamic,
    maxSegmentGapMs,
    ingest: status.ingest,
    csv: {
      queuedRows: status.queuedRows,
      writtenRows: status.writtenRows,
      totalRows: Number(status.queuedRows || 0) + Number(status.writtenRows || 0),
      lastError: status.lastError,
    },
  }, null, 2));
} finally {
  server.kill();
  await delay(100);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
