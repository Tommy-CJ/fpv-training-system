import { Buffer } from "node:buffer";
import fs from "node:fs";

export function createTrainingRuntime({
  bandsByPilotFromSegments, broadcastLiveState, csvRuntimeEvents, db, eventFromRow, getParticipantTrainingWindow,
  getPilotState, insertSample, lastSampleDetail, liveStateBroadcastIntervalMs, maxSampleGapMs,
  parseSerialPacket, pendingSerialPackets, pendingTrainingCsvLines, pendingTrainingCsvPackets,
  pilotFromRow, readCachedEventOverview, receiverDbWriteIntervalMs, receiverDbWriteTimes,
  receiverOfflineAfterMs, recentSampleWindowMs, runtimeEvents, sampleChannelValue,
  sampleWriteIntervalMs, serialIngestStatus, serialPersistenceMaxPacketsPerTick,
  serialPersistenceTimeBudgetMs, sendLiveSocketJson, serverLiveState, statsRefreshIntervalMs,
  onBackfillResult = () => {},
  trainingCsvFile, trainingCsvStatus,
}) {
let lastReceiverOfflineMarkAt = 0;
const MAX_SAMPLE_GAP_MS = maxSampleGapMs;
const RECEIVER_DB_WRITE_INTERVAL_MS = receiverDbWriteIntervalMs;
const RECEIVER_OFFLINE_AFTER_MS = receiverOfflineAfterMs;
const RECENT_SAMPLE_WINDOW_MS = recentSampleWindowMs;
const SAMPLE_WRITE_INTERVAL_MS = sampleWriteIntervalMs;
const SERIAL_PERSISTENCE_MAX_PACKETS_PER_TICK = Math.max(1, Number(serialPersistenceMaxPacketsPerTick) || 4);
const SERIAL_PERSISTENCE_TIME_BUDGET_MS = Math.max(1, Number(serialPersistenceTimeBudgetMs) || 12);
const STATS_REFRESH_INTERVAL_MS = statsRefreshIntervalMs;
const LIVE_STATE_BROADCAST_INTERVAL_MS = liveStateBroadcastIntervalMs;
const upsertStat = db.prepare(`
  INSERT INTO training_event_stats
    (event_id, pilot_id, total_flight_ms, utilization, idle_ms, total_turtle_ms, last_flight_end_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id, pilot_id) DO UPDATE SET
    total_flight_ms = excluded.total_flight_ms,
    utilization = excluded.utilization,
    idle_ms = excluded.idle_ms,
    total_turtle_ms = excluded.total_turtle_ms,
    last_flight_end_at = excluded.last_flight_end_at,
    updated_at = excluded.updated_at
`);

const activeEventQuery = db.prepare(`
  SELECT *
  FROM training_events
  WHERE active = 1
  ORDER BY COALESCE(started_at, created_at) DESC
  LIMIT 1
`);
const eventByIdQuery = db.prepare("SELECT * FROM training_events WHERE id = ?");
const eventsCoveringTimeQuery = db.prepare(`
  SELECT *
  FROM training_events
  WHERE started_at IS NOT NULL
    AND started_at <= ?
    AND (
      (ended_at IS NOT NULL AND ended_at >= ?)
      OR (active = 1 AND ended_at IS NULL)
    )
  ORDER BY started_at DESC, created_at DESC
`);
const receiverAssignmentsQuery = db.prepare(`
  SELECT pilot_id, receiver_id, started_at, ended_at
  FROM training_receiver_assignments
  WHERE event_id = ?
  ORDER BY started_at ASC, id ASC
`);
const insertReceiverAssignment = db.prepare(`
  INSERT INTO training_receiver_assignments
    (event_id, pilot_id, receiver_id, started_at, ended_at, created_at)
  VALUES (?, ?, ?, ?, NULL, ?)
`);
const claimIngestedPacket = db.prepare(`
  INSERT OR IGNORE INTO training_ingested_packets (event_id, packet_id, captured_at, processed_at)
  VALUES (?, ?, ?, ?)
`);
const allEventsQuery = db.prepare("SELECT * FROM training_events ORDER BY COALESCE(started_at, created_at) DESC");
const allPilotsQuery = db.prepare("SELECT * FROM pilots");
const COACH_SNAPSHOT_INTERVAL_MS = 5000;
const COACH_WINDOW_MS = 15 * 60 * 1000;
const COACH_STALE_AFTER_MS = 15000;
const coachSnapshotStore = {
  activeEventId: null,
  generatedAt: null,
  stale: true,
  event: null,
  pilots: [],
  error: "",
};
const COACH_LLM_CONFIG_KEY = "coachLlmConfig";
const LESSON_TEACHING_MANUAL_KEY = "lessonTeachingManual";
const LESSON_SYSTEM_PROMPT_KEY = "lessonSystemPrompt";
const LESSON_EXTRA_MATERIAL_KEY = "lessonExtraMaterial";
const LESSON_BUDGET_CONFIG_KEY = "lessonBudgetConfig";
// 用户可调参数：课程总时长，以及本节课教练可分配的总关注次数。
const DEFAULT_LESSON_BUDGET_CONFIG = {
  totalMinutes: 40,
  totalCoachBudget: 40,
};
const DEFAULT_COACH_LLM_CONFIG = {
  enabled: false,
  provider: "deepseek",
  baseURL: "https://api.deepseek.com",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  apiKey: "",
  systemPrompt: [
    "\u4f60\u662f FPV \u8bad\u7ec3\u73b0\u573a\u52a9\u6559\uff0c\u53ea\u6839\u636e\u8f93\u5165\u7684 coachSnapshot \u5224\u65ad\u3002",
    "\u8f93\u51fa\u5fc5\u987b\u7b80\u77ed\u3001\u53ef\u64ad\u62a5\uff0c\u4e0d\u8981\u89e3\u91ca\u63a8\u7406\u8fc7\u7a0b\u3002",
    "message \u4e0d\u8d85\u8fc7 36 \u4e2a\u4e2d\u6587\u5b57\uff0creason \u4e0d\u8d85\u8fc7 24 \u4e2a\u4e2d\u6587\u5b57\u3002",
    "\u53ea\u8f93\u51fa\u7b26\u5408 JSON Schema \u7684\u5bf9\u8c61\u3002",
  ].join("\n"),
  temperature: 0.2,
  maxTokens: 5000,
  topP: 1,
  stream: false,
  thinkingEnabled: true,
  timeoutMs: 12000,
  autoIntervalMinutes: 5,
};
const coachLlmRuntime = {
  signatures: new Map(),
  suggestions: new Map(),
  autoRequestedAt: new Map(),
  autoCursor: 0,
  eventSummary: null,
  inFlight: new Set(),
  lastError: "",
  lessonSessions: new Map(),
};
const PERSONAL_LESSON_OPTIMIZE_LIMIT = 3;
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
const recentSegmentUpdatesQuery = db.prepare(`
  SELECT event_id, pilot_id, type, started_at, ended_at, duration_ms
  FROM training_segments
  WHERE event_id = ? AND ended_at >= ?
  ORDER BY started_at ASC
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
    COALESCE(SUM(CASE WHEN type = 'flight' THEN MAX(0, ended_at - started_at) ELSE 0 END), 0) AS total_flight_ms,
    COALESCE(SUM(CASE WHEN type = 'flight' THEN MAX(0, MIN(ended_at, ?) - MAX(started_at, ?)) ELSE 0 END), 0) AS utilization_flight_ms,
    COALESCE(SUM(CASE WHEN type = 'turtle' THEN MAX(0, ended_at - started_at) ELSE 0 END), 0) AS total_turtle_ms
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ?
`);
const lastActualFlightEndQuery = db.prepare(`
  SELECT MAX(ended_at) AS last_flight_end
  FROM training_segments
  WHERE event_id = ? AND pilot_id = ? AND type = 'flight'
`);
const markTimelineForRebuild = db.prepare(`
  INSERT INTO training_timeline_rebuild_queue (event_id, marked_at, reason)
  VALUES (?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET
    marked_at = excluded.marked_at,
    reason = excluded.reason
`);
const timelineRebuildPendingQuery = db.prepare(
  "SELECT marked_at, reason FROM training_timeline_rebuild_queue WHERE event_id = ?",
);
const clearTimelineRebuildPending = db.prepare(
  "DELETE FROM training_timeline_rebuild_queue WHERE event_id = ?",
);
const latestTwoSamplesQuery = db.prepare(`
  SELECT time, flying, turtle
  FROM training_samples
  WHERE event_id = ? AND pilot_id = ?
  ORDER BY time DESC, id DESC
  LIMIT 2
`);
const timelinePatchSamplesQuery = db.prepare(`
  SELECT pilot_id, time, flying, turtle
  FROM training_samples
  WHERE event_id = ? AND time >= ? AND time <= ?
  ORDER BY pilot_id ASC, time ASC, id ASC
`);
const historicalStateContextQuery = db.prepare(`
  SELECT time, ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, throttle_min, throttle_max
  FROM training_samples
  WHERE event_id = ?
    AND pilot_id = ?
    AND time >= ?
    AND time < ?
  ORDER BY time ASC, id ASC
`);
const coveringSegmentQuery = db.prepare(`
  SELECT 1
  FROM training_segments
  WHERE event_id = ?
    AND pilot_id = ?
    AND type = ?
    AND started_at <= ?
    AND ended_at >= ?
  LIMIT 1
`);
const timelineStatusQuery = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM training_samples WHERE event_id = ?) AS sample_count,
    (SELECT MAX(time) FROM training_samples WHERE event_id = ?) AS last_sample_time,
    (SELECT COUNT(*) FROM training_segments WHERE event_id = ?) AS segment_count,
    (SELECT MAX(ended_at) FROM training_segments WHERE event_id = ?) AS last_segment_end_time,
    (SELECT MAX(updated_at) FROM training_event_stats WHERE event_id = ?) AS stats_updated_at
`);

const trainingCsvHeader = [
  "time_iso",
  "time_ms",
  "source_time",
  "event_id",
  "event_name",
  "pilot_id",
  "pilot_name",
  "receiver_id",
  "state",
  "mode",
  "armed",
  "flying",
  "turtle",
  "idle",
  "throttle_spread",
  "lq",
  "rssi",
  "raw_ch1",
  "raw_ch2",
  "raw_ch3",
  "raw_ch4",
  "raw_ch5",
  "raw_ch6",
  "raw_ch7",
  "raw_ch8",
  "ch1",
  "ch2",
  "ch3",
  "ch4",
  "ch5",
  "ch6",
  "ch7",
  "ch8",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function ensureTrainingCsvFile() {
  if (fs.existsSync(trainingCsvFile)) return;
  fs.writeFileSync(trainingCsvFile, `${trainingCsvHeader.join(",")}\n`, "utf-8");
}

function refreshTrainingCsvFileSize() {
  try {
    trainingCsvStatus.fileSizeBytes = fs.existsSync(trainingCsvFile) ? fs.statSync(trainingCsvFile).size : 0;
  } catch (error) {
    trainingCsvStatus.lastError = error.message;
  }
}

function getTrainingCsvStatus() {
  refreshTrainingCsvFileSize();
  return { ...trainingCsvStatus };
}

function flushTrainingCsvQueue() {
  if (trainingCsvStatus.flushInFlight || pendingTrainingCsvLines.length === 0) return;
  ensureTrainingCsvFile();
  const lines = pendingTrainingCsvLines.splice(0, pendingTrainingCsvLines.length);
  const data = lines.join("");
  const bytes = Buffer.byteLength(data);
  const startedAt = Date.now();
  trainingCsvStatus.flushInFlight = true;
  trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
  trainingCsvStatus.queuedBytes = pendingTrainingCsvLines.reduce((total, line) => total + Buffer.byteLength(line), 0);

  fs.promises.appendFile(trainingCsvFile, data, "utf-8")
    .then(() => fs.promises.stat(trainingCsvFile))
    .then((stat) => {
      trainingCsvStatus.writtenRows += lines.length;
      trainingCsvStatus.bytesWritten += bytes;
      trainingCsvStatus.fileSizeBytes = stat.size;
      trainingCsvStatus.lastFlushMs = Date.now() - startedAt;
      trainingCsvStatus.lastFlushAt = Date.now();
      trainingCsvStatus.lastError = "";
    })
    .catch((error) => {
      pendingTrainingCsvLines.unshift(...lines);
      trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
      trainingCsvStatus.queuedBytes = pendingTrainingCsvLines.reduce((total, line) => total + Buffer.byteLength(line), 0);
      trainingCsvStatus.lastError = error.message;
    })
    .finally(() => {
      trainingCsvStatus.flushInFlight = false;
    });
}

function queueTrainingCsvSample(event, pilot, participant, sample) {
  const stateType = stateTypeFromSample(sample);
  const row = [
    new Date(sample.time).toISOString(),
    sample.time,
    sample.sourceTime ?? "",
    event.id,
    event.name,
    pilot.id,
    pilot.name,
    sample.receiverId ?? participant.receiverId,
    stateType,
    sample.mode || "",
    sample.armed ? 1 : 0,
    sample.flying ? 1 : 0,
    sample.turtle ? 1 : 0,
    sample.idle ? 1 : 0,
    Math.round(sample.throttleSpread || 0),
    sample.lq ?? "",
    sample.rssi ?? "",
    ...(sample.rawChannels || []).slice(0, 8),
    sampleChannelValue(sample, "ch1"),
    sampleChannelValue(sample, "ch2"),
    sampleChannelValue(sample, "ch3"),
    sampleChannelValue(sample, "ch4"),
    sampleChannelValue(sample, "ch5"),
    sampleChannelValue(sample, "ch6"),
    sampleChannelValue(sample, "ch7"),
    sampleChannelValue(sample, "ch8"),
  ];
  const line = `${row.map(csvCell).join(",")}\n`;
  pendingTrainingCsvLines.push(line);
  trainingCsvStatus.queuedRows = pendingTrainingCsvLines.length;
  trainingCsvStatus.queuedBytes += Buffer.byteLength(line);
  if (pendingTrainingCsvLines.length >= 50 || trainingCsvStatus.queuedBytes >= 64 * 1024) {
    flushTrainingCsvQueue();
  }
}

function stateTypeFromSample(sample) {
  return sample?.turtle ? "turtle" : sample?.flying ? "flight" : "idle";
}

function refreshReceiverState(now = Date.now(), writeDb = false) {
  if (writeDb && now - lastReceiverOfflineMarkAt >= RECEIVER_DB_WRITE_INTERVAL_MS) {
    markOfflineReceivers.run(now - RECEIVER_OFFLINE_AFTER_MS);
    lastReceiverOfflineMarkAt = now;
  }
  const activeReceiverIds = Object.entries(serverLiveState.latestSamplesByReceiver)
    .filter(([, sample]) => now - Number(sample?.serverSeenAt || sample?.time || 0) <= RECEIVER_OFFLINE_AFTER_MS)
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
    serverLiveState.latestSamplesByReceiver[sample.receiverId] = { ...sample, serverSeenAt: receivedAt };
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
      receiverAssignments: [],
      pilotsById: new Map(),
      recentByPilot: new Map(),
      lastProcessedByPilot: new Map(),
      lastPersistedByPilot: new Map(),
      lastStatsRefreshByPilot: new Map(),
      lastCsvStateByPilot: new Map(),
      pendingIntervalsByPilot: new Map(),
      lastIntervalFlushAtByPilot: new Map(),
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
    runtime.receiverAssignments = receiverAssignmentsQuery.all(event.id);
    if (!runtime.receiverAssignments.length && event.startedAt) {
      const assignmentStart = Number(event.startedAt || event.createdAt || now);
      for (const participant of event.participants || []) {
        if (participant?.pilotId && Number(participant?.receiverId) > 0) {
          insertReceiverAssignment.run(event.id, participant.pilotId, Number(participant.receiverId), assignmentStart, now);
        }
      }
      runtime.receiverAssignments = receiverAssignmentsQuery.all(event.id);
    }
    runtime.pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    runtime.contextLoadedAt = now;
  }

  return runtime;
}

function getCsvRuntimeForEvent(event, now = Date.now()) {
  let runtime = csvRuntimeEvents.get(event.id);
  if (!runtime) {
    runtime = {
      event,
      participantByReceiver: new Map(),
      receiverAssignments: [],
      pilotsById: new Map(),
      recentByPilot: new Map(),
      contextLoadedAt: 0,
    };
    csvRuntimeEvents.set(event.id, runtime);
  }

  if (now - runtime.contextLoadedAt > 1000) {
    runtime.event = event;
    runtime.participantByReceiver = new Map(
      event.participants
        .map((participant) => [Number(participant.receiverId), participant])
        .filter(([receiverId]) => Number.isFinite(receiverId)),
    );
    runtime.receiverAssignments = receiverAssignmentsQuery.all(event.id);
    runtime.pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    runtime.contextLoadedAt = now;
  }

  return runtime;
}

function participantForReceiverAt(runtime, event, receiverId, sampleTime, { preferCurrent = false } = {}) {
  const receiver = Number(receiverId);
  const currentParticipant = runtime.participantByReceiver.get(receiver) || null;
  // Stable live path: the current event configuration is authoritative.
  // Assignment history is only needed when replaying samples captured before
  // a receiver migration.
  if (preferCurrent && currentParticipant) return currentParticipant;
  const matched = [...(runtime.receiverAssignments || [])].reverse().find((assignment) => (
    Number(assignment.receiver_id) === receiver &&
    Number(assignment.started_at) <= sampleTime &&
    (!assignment.ended_at || sampleTime < Number(assignment.ended_at))
  ));
  // Browser and server clocks can differ by a few milliseconds. If a recovery
  // sample falls just beyond the recorded migration boundary and that receiver
  // has no newer matching assignment, keep it with the immediately preceding
  // owner instead of dropping it as unmapped.
  const skewMatched = matched || [...(runtime.receiverAssignments || [])].reverse().find((assignment) => (
    Number(assignment.receiver_id) === receiver
    && Number(assignment.started_at) <= sampleTime
    && Number(assignment.ended_at) > 0
    && sampleTime - Number(assignment.ended_at) <= 2000
  ));
  if (skewMatched) {
    return (event.participants || []).find((participant) => participant.pilotId === skewMatched.pilot_id) || {
      pilotId: skewMatched.pilot_id,
      receiverId: skewMatched.receiver_id,
    };
  }
  return currentParticipant;
}

function processTrainingCsvSample(event, pilot, participant, rawSample, runtime, receivedAt) {
  const pilotId = participant.pilotId;
  const receiverId = Number(rawSample.receiverId) || Number(participant.receiverId);
  const sampleTime = Number(rawSample.time) || receivedAt;
  const eventStart = Number(event.startedAt || event.createdAt || sampleTime);
  const eventEnd = Number(event.endedAt || 0) || null;
  if (sampleTime < eventStart || (eventEnd && sampleTime > eventEnd)) return;

  const recentBefore = (runtime.recentByPilot.get(pilotId) || [])
    .filter((sample) => sample.time <= sampleTime && sample.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
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
  runtime.recentByPilot.set(pilotId, recentBefore.slice(-180));
  queueTrainingCsvSample(event, pilot, participant, sample);
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

function flushPilotTrainingIntervals(runtime, pilotId, now = Date.now()) {
  const intervals = runtime.pendingIntervalsByPilot.get(pilotId) || [];
  if (!intervals.length) return false;
  for (const interval of intervals) {
    appendTrainingInterval(interval.eventId, interval.pilotId, interval.type, interval.startedAt, interval.endedAt);
  }
  runtime.pendingIntervalsByPilot.delete(pilotId);
  runtime.lastIntervalFlushAtByPilot.set(pilotId, now);
  return true;
}

function refreshPilotStatsFromSegments(event, pilotId, now = Date.now()) {
  const trainingWindow = getParticipantTrainingWindow(event, pilotId, now);
  const eventStart = trainingWindow.start;
  const eventEnd = trainingWindow.end;
  const totals = segmentTotalsQuery.get(
    eventEnd,
    eventStart,
    event.id,
    pilotId,
  );
  const totalFlightMs = Math.round(totals?.total_flight_ms || 0);
  const utilizationFlightMs = Math.round(totals?.utilization_flight_ms || 0);
  const totalTurtleMs = Math.round(totals?.total_turtle_ms || 0);
  const lastActualFlightEnd = lastActualFlightEndQuery.get(event.id, pilotId)?.last_flight_end ?? null;
  const idleMs = lastActualFlightEnd === null || lastActualFlightEnd === undefined
    ? null
    : Math.max(0, now - lastActualFlightEnd);
  upsertStat.run(
    event.id,
    pilotId,
    totalFlightMs,
    utilizationFlightMs / Math.max(1, eventEnd - eventStart),
    idleMs,
    totalTurtleMs,
    lastActualFlightEnd,
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

function reloadLastPersistedSample(runtime, eventId, pilotId) {
  const row = lastSampleDetail.get(eventId, pilotId) || null;
  runtime.lastPersistedByPilot.set(pilotId, row);
  return row;
}

function refreshPilotStatsThrottled(runtime, event, pilotId, now = Date.now(), force = false) {
  const lastRefreshAt = runtime.lastStatsRefreshByPilot.get(pilotId) || 0;
  if (!force && now - lastRefreshAt < STATS_REFRESH_INTERVAL_MS) return;
  refreshPilotStatsFromSegments(event, pilotId, now);
  runtime.lastStatsRefreshByPilot.set(pilotId, now);
}

function flushPendingTrainingIntervals(now = Date.now(), force = false) {
  const candidates = [];
  for (const runtime of runtimeEvents.values()) {
    for (const pilotId of runtime.pendingIntervalsByPilot.keys()) {
      const lastFlushedAt = runtime.lastIntervalFlushAtByPilot.get(pilotId) || 0;
      if (force || now - lastFlushedAt >= SAMPLE_WRITE_INTERVAL_MS) {
        candidates.push({
          runtime,
          pilotId,
          intervals: (runtime.pendingIntervalsByPilot.get(pilotId) || []).map((interval) => ({ ...interval })),
          lastFlushedAt,
        });
      }
    }
  }
  if (!candidates.length) return 0;

  let flushed = 0;
  const flushedCandidates = [];
  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      const { runtime, pilotId } = candidate;
      if (flushPilotTrainingIntervals(runtime, pilotId, now)) {
        flushedCandidates.push(candidate);
        refreshPilotStatsThrottled(runtime, runtime.event, pilotId, now, force);
        flushed += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    for (const { runtime, pilotId, intervals, lastFlushedAt } of flushedCandidates) {
      const current = runtime.pendingIntervalsByPilot.get(pilotId) || [];
      runtime.pendingIntervalsByPilot.set(pilotId, [...intervals, ...current]);
      runtime.lastIntervalFlushAtByPilot.set(pilotId, lastFlushedAt);
    }
    throw error;
  }
  return flushed;
}

function persistProcessedSample(event, pilot, participant, rawSample, runtime, receivedAt, { backfill = false } = {}) {
  const pilotId = participant.pilotId;
  const receiverId = Number(rawSample.receiverId) || Number(participant.receiverId);
  const sampleTime = Number(rawSample.time) || receivedAt;
  const eventStart = Number(event.startedAt || event.createdAt || sampleTime);
  const eventEnd = Number(event.endedAt || 0) || null;
  if (sampleTime < eventStart || (eventEnd && sampleTime > eventEnd)) {
    return { sample: null, persisted: false, skipReason: "out_of_window", sampleTime };
  }
  // Current packets can use the event runtime's rolling window. Historical
  // packets cannot: current live traffic is interleaved with recovery, so that
  // in-memory window mostly contains samples from "now" and is empty when
  // filtered back to the old capture time. Rebuild the same five-second input
  // window from SQLite instead, keeping the server as the sole state authority.
  const recentBefore = backfill
    ? historicalStateContextQuery.all(
      event.id,
      pilotId,
      sampleTime - RECENT_SAMPLE_WINDOW_MS,
      sampleTime,
    ).map((row) => ({
      time: Number(row.time),
      channels: {
        ch1: Number(row.ch1),
        ch2: Number(row.ch2),
        ch3: Number(row.ch3),
        ch4: Number(row.ch4),
        ch5: Number(row.ch5),
        ch6: Number(row.ch6),
        ch7: Number(row.ch7),
        ch8: Number(row.ch8),
      },
      throttleMin: row.throttle_min !== null && Number.isFinite(Number(row.throttle_min))
        ? Number(row.throttle_min)
        : Number(row.ch3),
      throttleMax: row.throttle_max !== null && Number.isFinite(Number(row.throttle_max))
        ? Number(row.throttle_max)
        : Number(row.ch3),
    }))
    : (runtime.recentByPilot.get(pilotId) || [])
      .filter((sample) => sample.time <= sampleTime && sample.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
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
  if (!backfill) {
    serverLiveState.latestSamplesByReceiver[receiverId] = {
      ...sample,
      serverSeenAt: serverLiveState.latestSamplesByReceiver[receiverId]?.serverSeenAt || Date.now(),
    };
  }

  let previous = getLastPersistedSample(runtime, event.id, pilotId);
  if (!backfill && previous && sampleTime <= previous.time) {
    // The in-memory cursor is deliberately only a cache. If a packet
    // transaction was rolled back, or an older build accepted a future client
    // timestamp, reload SQLite before rejecting the current live sample. This
    // prevents one bad packet from stopping history persistence indefinitely.
    const storedPrevious = reloadLastPersistedSample(runtime, event.id, pilotId);
    if (!storedPrevious || sampleTime > storedPrevious.time) previous = storedPrevious;
  }
  if (previous && sampleTime <= previous.time) {
    if (backfill && sampleTime < previous.time) {
      // Offline recovery can arrive after the current live tail. Preserve the
      // old sample in the authoritative ledger without moving the live cursor
      // backwards; the complete timeline is rebuilt once recovery finishes.
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
        Number.isFinite(Number(sample.throttleMin)) ? Number(sample.throttleMin) : sampleChannelValue(sample, "ch3"),
        Number.isFinite(Number(sample.throttleMax)) ? Number(sample.throttleMax) : sampleChannelValue(sample, "ch3"),
        sample.armed ? 1 : 0,
        sample.flying ? 1 : 0,
        sample.turtle ? 1 : 0,
      );
      // This flag must survive a lost WebSocket completion message and a
      // server restart. The next explicit completion or authoritative history
      // read will rebuild segments/statistics from training_samples.
      markTimelineForRebuild.run(event.id, Date.now(), "out_of_order_backfill");
      return { sample, persisted: true, skipReason: "backfill", sampleTime };
    }
    return { sample, persisted: false, skipReason: "stale", sampleTime };
  }
  if (previous && sampleTime - previous.time < SAMPLE_WRITE_INTERVAL_MS) {
    return { sample, persisted: false, skipReason: "throttled", sampleTime };
  }

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
    Number.isFinite(Number(sample.throttleMin)) ? Number(sample.throttleMin) : sampleChannelValue(sample, "ch3"),
    Number.isFinite(Number(sample.throttleMax)) ? Number(sample.throttleMax) : sampleChannelValue(sample, "ch3"),
    sample.armed ? 1 : 0,
    sample.flying ? 1 : 0,
    sample.turtle ? 1 : 0,
  );

  // Stable core semantics: every accepted 5 Hz sample immediately closes the
  // preceding interval. There is no second in-memory interval queue whose
  // flush timing can diverge from samples, statistics, or a page reload.
  if (previous && sampleTime - previous.time <= MAX_SAMPLE_GAP_MS) {
    appendTrainingInterval(
      event.id,
      pilotId,
      stateTypeFromSample(previous),
      previous.time,
      sampleTime,
    );
  }

  const persistedSample = {
    time: sampleTime,
    armed: sample.armed ? 1 : 0,
    flying: sample.flying ? 1 : 0,
    turtle: sample.turtle ? 1 : 0,
  };
  runtime.lastPersistedByPilot.set(pilotId, persistedSample);
  runtime.lastProcessedByPilot.set(pilotId, sample);
  refreshPilotStatsThrottled(runtime, event, pilotId, receivedAt);

  return { sample, persisted: true, skipReason: "", sampleTime };
}

function rebuildEventTimelineFromSamples(eventId, now = Date.now(), { force = false } = {}) {
  if (!force && !timelineRebuildPendingQuery.get(eventId)) return false;
  const eventRow = eventByIdQuery.get(eventId);
  if (!eventRow) return false;
  const event = eventFromRow(eventRow);
  const rows = db.prepare(`
    SELECT pilot_id, time, flying, turtle
    FROM training_samples
    WHERE event_id = ?
    ORDER BY pilot_id ASC, time ASC
  `).all(eventId);
  const samplesByPilot = new Map();
  for (const row of rows) {
    const samples = samplesByPilot.get(row.pilot_id) || [];
    samples.push(row);
    samplesByPilot.set(row.pilot_id, samples);
  }
  const participants = new Map((event.participants || []).map((participant) => [participant.pilotId, participant]));
  const rebuiltSegments = [];
  const rebuiltStats = [];
  let timelineGapCount = 0;
  let timelineMaxGapMs = 0;

  for (const [pilotId, participant] of participants) {
    const samples = samplesByPilot.get(pilotId) || [];
    const window = getParticipantTrainingWindow(event, participant, now);
    let totalFlightMs = 0;
    let utilizationFlightMs = 0;
    let totalTurtleMs = 0;
    let lastFlightEndAt = null;
    let currentSegment = null;

    const closeSegment = () => {
      if (!currentSegment) return;
      const durationMs = Math.max(0, currentSegment.endedAt - currentSegment.startedAt);
      if (durationMs > 0) {
        rebuiltSegments.push({ pilotId, ...currentSegment, durationMs });
        if (currentSegment.type === "flight") {
          totalFlightMs += durationMs;
          const overlapStart = Math.max(window.start, currentSegment.startedAt);
          const overlapEnd = Math.min(window.end, currentSegment.endedAt);
          utilizationFlightMs += Math.max(0, overlapEnd - overlapStart);
          lastFlightEndAt = Math.max(lastFlightEndAt || 0, currentSegment.endedAt) || lastFlightEndAt;
        }
        if (currentSegment.type === "turtle") totalTurtleMs += durationMs;
      }
      currentSegment = null;
    };

    for (let index = 0; index < samples.length - 1; index += 1) {
      const sample = samples[index];
      const next = samples[index + 1];
      const startedAt = Number(sample.time) || 0;
      const endedAt = Number(next.time) || 0;
      const sampleGapMs = endedAt > startedAt ? endedAt - startedAt : 0;
      timelineMaxGapMs = Math.max(timelineMaxGapMs, sampleGapMs);
      if (sampleGapMs > MAX_SAMPLE_GAP_MS) timelineGapCount += 1;
      if (!startedAt || endedAt <= startedAt || endedAt - startedAt > MAX_SAMPLE_GAP_MS) {
        closeSegment();
        continue;
      }
      const type = stateTypeFromSample(sample);
      if (!currentSegment || currentSegment.type !== type || startedAt > currentSegment.endedAt + MAX_SAMPLE_GAP_MS) {
        closeSegment();
        currentSegment = { type, startedAt, endedAt };
      } else {
        currentSegment.endedAt = Math.max(currentSegment.endedAt, endedAt);
      }
    }
    closeSegment();
    rebuiltStats.push({
      pilotId,
      totalFlightMs,
      utilization: utilizationFlightMs / Math.max(1, window.end - window.start),
      idleMs: lastFlightEndAt === null ? null : Math.max(0, now - lastFlightEndAt),
      totalTurtleMs,
      lastFlightEndAt,
    });
  }

  serialIngestStatus.lastTimelineGapEventId = eventId;
  serialIngestStatus.lastTimelineSampleCount = rows.length;
  serialIngestStatus.lastTimelineGapCount = timelineGapCount;
  serialIngestStatus.lastTimelineMaxGapMs = timelineMaxGapMs;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM training_segments WHERE event_id = ?").run(eventId);
    db.prepare("DELETE FROM training_event_stats WHERE event_id = ?").run(eventId);
    for (const segment of rebuiltSegments) {
      insertTrainingSegment.run(
        eventId,
        segment.pilotId,
        segment.type,
        segment.startedAt,
        segment.endedAt,
        segment.durationMs,
      );
    }
    for (const stat of rebuiltStats) {
      upsertStat.run(
        eventId,
        stat.pilotId,
        Math.round(stat.totalFlightMs),
        stat.utilization,
        stat.idleMs,
        Math.round(stat.totalTurtleMs),
        stat.lastFlightEndAt,
        now,
      );
    }
    clearTimelineRebuildPending.run(eventId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  runtimeEvents.delete(eventId);
  return true;
}

function buildEventTimelinePatch(eventId, replaceFrom, replaceTo) {
  const eventRow = eventByIdQuery.get(eventId);
  if (!eventRow) return null;
  const event = eventFromRow(eventRow);
  const eventStart = Number(event.startedAt || event.createdAt) || 0;
  const eventEnd = Number(event.endedAt) || Number.MAX_SAFE_INTEGER;
  const safeFrom = Math.max(eventStart, Number(replaceFrom) || 0);
  const safeTo = Math.min(eventEnd, Number(replaceTo) || 0);
  if (!safeFrom || safeTo <= safeFrom) return null;

  // One sample on either side is enough to reconstruct every interval that can
  // legally cross the replacement boundary (intervals over MAX_SAMPLE_GAP_MS
  // are intentionally rendered as gaps).
  const rows = timelinePatchSamplesQuery.all(
    eventId,
    Math.max(eventStart, safeFrom - MAX_SAMPLE_GAP_MS),
    Math.min(eventEnd, safeTo + MAX_SAMPLE_GAP_MS),
  );
  const rowsByPilot = new Map();
  for (const row of rows) {
    const samples = rowsByPilot.get(row.pilot_id) || [];
    samples.push(row);
    rowsByPilot.set(row.pilot_id, samples);
  }

  const bandsByPilot = {};
  const pilotIds = new Set((event.participants || []).map((participant) => participant.pilotId).filter(Boolean));
  for (const pilotId of pilotIds) {
    const samples = rowsByPilot.get(pilotId) || [];
    const bands = [];
    for (let index = 0; index < samples.length - 1; index += 1) {
      const sample = samples[index];
      const next = samples[index + 1];
      const sampleTime = Number(sample.time) || 0;
      const nextTime = Number(next.time) || 0;
      if (!sampleTime || nextTime <= sampleTime || nextTime - sampleTime > MAX_SAMPLE_GAP_MS) continue;
      const start = Math.max(safeFrom, sampleTime);
      const end = Math.min(safeTo, nextTime);
      if (end <= start) continue;
      const state = sample.turtle ? "turtle" : sample.flying ? "flying" : "idle";
      const previous = bands[bands.length - 1];
      if (previous && previous.state === state && start - previous.end <= MAX_SAMPLE_GAP_MS) {
        previous.end = Math.max(previous.end, end);
      } else {
        bands.push({ state, start, end });
      }
    }
    // Include an empty array so clients clear a previously optimistic local
    // interval when SQLite proves that the recovered range is actually empty.
    bandsByPilot[pilotId] = bands;
  }
  return {
    eventId,
    replaceFrom: safeFrom,
    replaceTo: safeTo,
    bandsByPilot,
    generatedAt: Date.now(),
  };
}

function eventTimelineHasTailGap(event) {
  for (const participant of event?.participants || []) {
    const pilotId = participant?.pilotId;
    if (!pilotId) continue;
    const latest = latestTwoSamplesQuery.all(event.id, pilotId);
    if (latest.length < 2) continue;
    const newest = latest[0];
    const previous = latest[1];
    const startedAt = Number(previous.time) || 0;
    const endedAt = Number(newest.time) || 0;
    if (!startedAt || endedAt <= startedAt || endedAt - startedAt > MAX_SAMPLE_GAP_MS) continue;
    const type = stateTypeFromSample(previous);
    if (!coveringSegmentQuery.get(event.id, pilotId, type, startedAt, endedAt)) return true;
  }
  return false;
}

function ensureEventTimelineCurrent(eventId, now = Date.now()) {
  const eventRow = eventByIdQuery.get(eventId);
  if (!eventRow) return false;
  const event = eventFromRow(eventRow);
  const pending = Boolean(timelineRebuildPendingQuery.get(eventId));
  if (!pending && !eventTimelineHasTailGap(event)) return false;
  return rebuildEventTimelineFromSamples(eventId, now, { force: true });
}

function getEventTimelineStatus(eventId, now = Date.now()) {
  const row = timelineStatusQuery.get(eventId, eventId, eventId, eventId, eventId) || {};
  const pending = timelineRebuildPendingQuery.get(eventId) || null;
  return {
    generatedAt: now,
    sampleCount: Number(row.sample_count) || 0,
    lastSampleTime: Number(row.last_sample_time) || null,
    segmentCount: Number(row.segment_count) || 0,
    lastSegmentEndTime: Number(row.last_segment_end_time) || null,
    statsUpdatedAt: Number(row.stats_updated_at) || null,
    rebuildPending: Boolean(pending),
    rebuildReason: pending?.reason || "",
  };
}

function buildServerLiveState(event, now = Date.now(), { includeTimeline = false, includeEvents = false } = {}) {
  if (event && includeTimeline) ensureEventTimelineCurrent(event.id, now);
  const overview = event
    ? readCachedEventOverview(event.id, { includeSegments: includeTimeline })
    : { stats: [], segments: [] };
  const bandUpdatesByPilot = event
    ? bandsByPilotFromSegments(recentSegmentUpdatesQuery.all(
      event.id,
      now - Math.max(5000, LIVE_STATE_BROADCAST_INTERVAL_MS * 3),
    ))
    : {};
  const participantByPilot = new Map((event?.participants || []).map((participant) => [participant.pilotId, participant]));
  const statByPilot = new Map((overview.stats || []).map((stat) => [stat.pilot_id, stat]));
  const summaryPilotIds = new Set([
    ...participantByPilot.keys(),
    ...statByPilot.keys(),
  ]);
  const summaries = {};
  for (const pilotId of summaryPilotIds) {
    const stat = statByPilot.get(pilotId) || null;
    const trainingWindow = event ? getParticipantTrainingWindow(event, participantByPilot.get(pilotId) || pilotId, now) : { start: now, end: now };
    // Do not reconstruct the numerator from a previously rounded utilization
    // ratio and a newer denominator. Query the persisted bands directly so
    // coach and audience receive the same exact utilization baseline.
    const totals = event ? segmentTotalsQuery.get(
      trainingWindow.end,
      trainingWindow.start,
      event.id,
      pilotId,
    ) : null;
    const totalFlightMs = Math.round(totals?.total_flight_ms ?? stat?.total_flight_ms ?? 0);
    const utilizationFlightMs = Math.round(totals?.utilization_flight_ms || 0);
    const totalTurtleMs = Math.round(totals?.total_turtle_ms ?? stat?.total_turtle_ms ?? 0);
    const lastFlightEndAt = event
      ? (lastActualFlightEndQuery.get(event.id, pilotId)?.last_flight_end ?? null)
      : (stat?.last_flight_end_at ?? null);
    const idleMs = lastFlightEndAt === null ? null : Math.max(0, now - lastFlightEndAt);
    summaries[pilotId] = {
      pilotId,
      totalFlightMs,
      utilization: utilizationFlightMs / Math.max(1, trainingWindow.end - trainingWindow.start),
      utilizationFlightMs,
      idleMs,
      lastFlightEndedAt: lastFlightEndAt,
      totalTurtleMs,
      updatedAt: now,
    };
  }

  return {
    version: 3,
    serverManaged: true,
    updatedAt: now,
    event,
    participants: event?.participants || [],
    summaries,
    bandUpdatesByPilot,
    csvWrite: getTrainingCsvStatus(),
    latestSamplesByReceiver: serverLiveState.latestSamplesByReceiver,
    receiverState: serverLiveState.receiverState,
    ...(includeEvents ? { events: allEventsQuery.all().map(eventFromRow) } : {}),
    ...(includeTimeline ? { bandsByPilot: bandsByPilotFromSegments(overview.segments || []) } : {}),
  };
}

function maybeBuildServerLiveState(event, now = Date.now(), force = false) {
  if (!force && now - (serverLiveState.lastStateBroadcastAt || 0) < LIVE_STATE_BROADCAST_INTERVAL_MS) return null;
  serverLiveState.lastStateBroadcastAt = now;
  return buildServerLiveState(event, now);
}

function resolveBackfillEvent(requestedEventId, capturedAt, serverReceivedAt) {
  const requestedId = String(requestedEventId || "");
  const exact = requestedId ? eventByIdQuery.get(requestedId) : null;
  const sampleTime = Number(capturedAt) || 0;
  if (exact) {
    const startedAt = Number(exact.started_at) || 0;
    const endedAt = Number(exact.ended_at) || 0;
    const coversCaptureTime = startedAt > 0
      && sampleTime >= startedAt
      && (endedAt > 0 ? sampleTime <= endedAt : Boolean(exact.active) && sampleTime <= serverReceivedAt);
    if (!coversCaptureTime) {
      return {
        eventRow: null,
        requestedEventMissing: false,
        resolvedBy: "",
        candidateCount: 0,
        rejectReason: "event_time_mismatch",
      };
    }
    return {
      eventRow: exact,
      requestedEventMissing: false,
      resolvedBy: "event_id",
      candidateCount: 1,
      rejectReason: "",
    };
  }

  const candidates = sampleTime > 0 && sampleTime <= serverReceivedAt
    ? eventsCoveringTimeQuery.all(sampleTime, sampleTime).filter((row) => (
      Number(row.ended_at) > 0 || (Boolean(row.active) && sampleTime <= serverReceivedAt)
    ))
    : [];
  if (candidates.length === 1) {
    return {
      eventRow: candidates[0],
      requestedEventMissing: Boolean(requestedId),
      resolvedBy: "capture_time",
      candidateCount: 1,
      rejectReason: "",
    };
  }
  return {
    eventRow: null,
    requestedEventMissing: Boolean(requestedId),
    resolvedBy: "",
    candidateCount: candidates.length,
    rejectReason: candidates.length > 1 ? "ambiguous_capture_time" : "event_not_found",
  };
}

function processServerSerialPacket(packet, {
  receivedAt = Date.now(),
  serverReceivedAt = Date.now(),
  eventId = "",
  packetId = "",
  backfill = false,
} = {}) {
  let claimedEventId = "";
  let runtimeEventId = "";
  let transactionStarted = false;
  try {
    const rawSamples = parseSerialPacket(packet, receivedAt);
    if (!rawSamples.length) return {
      accepted: true,
      state: null,
      event: null,
      rawSampleCount: 0,
      mappedSampleCount: 0,
      unmappedSampleCount: 0,
      outOfWindowSampleCount: 0,
    };

    if (!backfill) updateReceiversFromSamples(rawSamples, serverReceivedAt);
    // Match the stable implementation for current live data: always use the
    // active event. Historical recovery first uses its recorded event id, then
    // falls back only when its capture time belongs to exactly one server event.
    const activeEventId = activeEventQuery.get()?.id || "";
    const resolution = backfill
      ? resolveBackfillEvent(eventId, receivedAt, serverReceivedAt)
      : {
        eventRow: activeEventQuery.get(),
        requestedEventMissing: false,
        resolvedBy: "active_event",
        candidateCount: 1,
        rejectReason: "",
      };
    const eventRow = resolution.eventRow;
    if (!eventRow) return {
      accepted: false,
      ackStatus: backfill ? "orphaned" : "retryable",
      retryable: !backfill,
      rejectReason: resolution.rejectReason || (backfill ? "event_not_found" : "no_active_event"),
      requestedEventId: eventId,
      activeEventId,
      resolvedEventId: "",
      resolvedBy: "",
      candidateCount: resolution.candidateCount || 0,
      requestedEventMissing: Boolean(resolution.requestedEventMissing),
      state: maybeBuildServerLiveState(null, serverReceivedAt),
      event: null,
      rawSampleCount: rawSamples.length,
      mappedSampleCount: 0,
      unmappedSampleCount: 0,
      outOfWindowSampleCount: 0,
      noActiveEvent: !backfill,
      missingTargetEvent: Boolean(backfill),
      unassignedReceiverIds: [],
      missingPilotIds: [],
    };

    const event = eventFromRow(eventRow);
    if (packetId) {
      db.exec("BEGIN");
      transactionStarted = true;
      const claim = claimIngestedPacket.run(event.id, packetId, receivedAt, Date.now());
      if (!claim.changes) {
        db.exec("ROLLBACK");
        transactionStarted = false;
        return {
          accepted: false,
          duplicate: true,
          ackStatus: "duplicate",
          state: null,
          event,
          requestedEventId: eventId,
          activeEventId,
          resolvedEventId: event.id,
          resolvedBy: resolution.resolvedBy,
          candidateCount: resolution.candidateCount,
          requestedEventMissing: Boolean(resolution.requestedEventMissing),
        };
      }
      claimedEventId = event.id;
    }
    const runtime = getRuntimeForEvent(event, serverReceivedAt);
    runtimeEventId = event.id;
    const csvSamples = [];
    let persistedSampleCount = 0;
    let throttledSampleCount = 0;
    let staleSampleCount = 0;
    let latestSampleTime = null;
    let unmappedSampleCount = 0;
    let outOfWindowSampleCount = 0;
    const unassignedReceiverIds = new Set();
    const missingPilotIds = new Set();
    for (const rawSample of rawSamples) {
      const participant = participantForReceiverAt(
        runtime,
        event,
        rawSample.receiverId,
        Number(rawSample.time) || receivedAt,
        { preferCurrent: !backfill },
      );
      if (!participant) {
        unmappedSampleCount += 1;
        unassignedReceiverIds.add(Number(rawSample.receiverId) || 0);
        continue;
      }
      const pilot = runtime.pilotsById.get(participant.pilotId);
      if (!pilot) {
        unmappedSampleCount += 1;
        missingPilotIds.add(participant.pilotId);
        continue;
      }
      const persistence = persistProcessedSample(
        event,
        pilot,
        participant,
        rawSample,
        runtime,
        receivedAt,
        { backfill },
      );
      latestSampleTime = Math.max(latestSampleTime || 0, Number(persistence.sampleTime) || 0) || latestSampleTime;
      if (persistence.sample) csvSamples.push({ event, pilot, participant, sample: persistence.sample });
      if (persistence.persisted) persistedSampleCount += 1;
      else if (persistence.skipReason === "throttled") throttledSampleCount += 1;
      else if (persistence.skipReason === "stale") staleSampleCount += 1;
      else if (persistence.skipReason === "out_of_window") outOfWindowSampleCount += 1;
    }

    const state = maybeBuildServerLiveState(event, serverReceivedAt);
    if (transactionStarted) {
      db.exec("COMMIT");
      transactionStarted = false;
    }
    return {
      accepted: true,
      state,
      event,
      csvSamples,
      rawSampleCount: rawSamples.length,
      mappedSampleCount: csvSamples.length,
      persistedSampleCount,
      throttledSampleCount,
      staleSampleCount,
      latestSampleTime,
      unmappedSampleCount,
      outOfWindowSampleCount,
      noActiveEvent: false,
      missingTargetEvent: false,
      ackStatus: persistedSampleCount > 0 ? "persisted" : "processed",
      requestedEventId: eventId,
      activeEventId,
      resolvedEventId: event.id,
      resolvedBy: resolution.resolvedBy,
      candidateCount: resolution.candidateCount,
      requestedEventMissing: Boolean(resolution.requestedEventMissing),
      unassignedReceiverIds: [...unassignedReceiverIds].filter(Boolean).sort((left, right) => left - right),
      missingPilotIds: [...missingPilotIds].filter(Boolean),
    };
  } catch (error) {
    if (transactionStarted) {
      db.exec("ROLLBACK");
    } else if (claimedEventId && packetId) {
      db.prepare("DELETE FROM training_ingested_packets WHERE event_id = ? AND packet_id = ?").run(claimedEventId, packetId);
    }
    if (runtimeEventId) runtimeEvents.delete(runtimeEventId);
    serverLiveState.receiverState.error = error.message || "serial packet processing failed";
    return {
      accepted: false,
      ackStatus: "retryable",
      retryable: true,
      rejectReason: "processing_failed",
      error,
      state: maybeBuildServerLiveState(null, Date.now(), true),
      event: null,
    };
  }
}

function processQueuedSerialPackets({ force = false } = {}) {
  const startedAt = Date.now();
  const packetLimit = force
    ? pendingSerialPackets.length
    : Math.min(pendingSerialPackets.length, SERIAL_PERSISTENCE_MAX_PACKETS_PER_TICK);
  const queuedPackets = pendingSerialPackets.splice(0, packetLimit);
  let processedPackets = 0;
  for (let index = 0; index < queuedPackets.length; index += 1) {
    if (!force && processedPackets > 0 && Date.now() - startedAt >= SERIAL_PERSISTENCE_TIME_BUDGET_MS) {
      pendingSerialPackets.unshift(...queuedPackets.slice(index));
      break;
    }
    const queued = queuedPackets[index];
    const result = processServerSerialPacket(queued.packet, {
      roomId: queued.roomId,
      receivedAt: queued.receivedAt,
      serverReceivedAt: queued.serverReceivedAt || queued.enqueuedAt || Date.now(),
      eventId: queued.eventId,
      packetId: queued.packetId,
      backfill: Boolean(queued.backfill),
    });
    processedPackets += 1;
    if (result.accepted && result.event) {
      for (const csvSample of result.csvSamples || []) {
        queueTrainingCsvSample(csvSample.event, csvSample.pilot, csvSample.participant, csvSample.sample);
      }
    }
    if (result.state && !queued.backfill) broadcastLiveState(queued.roomId, result.state);
    if (queued.client && queued.packetId) {
      const ackStatus = result.ackStatus || (result.duplicate ? "duplicate" : result.accepted ? "processed" : "retryable");
      sendLiveSocketJson(queued.client, {
        type: "live_packet_ack",
        packetId: queued.packetId,
        clientSequence: queued.clientSequence,
        status: ackStatus,
        accepted: ["persisted", "processed", "duplicate"].includes(ackStatus),
        persisted: ackStatus === "persisted",
        duplicate: Boolean(result.duplicate),
        retryable: ackStatus === "retryable",
        rejected: ackStatus === "orphaned",
        orphaned: ackStatus === "orphaned",
        reason: result.rejectReason || "",
        requestedEventId: queued.eventId || "",
        activeEventId: result.activeEventId || "",
        resolvedEventId: result.resolvedEventId || result.event?.id || "",
        resolvedBy: result.resolvedBy || "",
        capturedAt: queued.receivedAt,
        candidateCount: Number(result.candidateCount || 0),
        retryAfterMs: ackStatus === "orphaned" ? 30_000 : ackStatus === "retryable" ? 1000 : 0,
        sampled: true,
        serverTime: Date.now(),
      });
    }
    if (queued.backfill) {
      serialIngestStatus.backfillProcessedPackets += 1;
      serialIngestStatus.backfillPersistedSamples += Number(result.persistedSampleCount || 0);
      serialIngestStatus.backfillThrottledSamples += Number(result.throttledSampleCount || 0);
      serialIngestStatus.backfillStaleSamples += Number(result.staleSampleCount || 0);
      serialIngestStatus.backfillUnmappedSamples += Number(result.unmappedSampleCount || 0);
      serialIngestStatus.backfillOutOfWindowSamples += Number(result.outOfWindowSampleCount || 0);
      if (result.requestedEventMissing) serialIngestStatus.backfillRequestedEventMissingPackets += 1;
      if (result.requestedEventMissing && result.ackStatus === "orphaned") {
        serialIngestStatus.backfillMissingEventPackets += 1;
      }
      if (result.resolvedBy === "capture_time") serialIngestStatus.backfillResolvedByCaptureTimePackets += 1;
      if (result.ackStatus === "orphaned") serialIngestStatus.backfillOrphanedPackets += 1;
      serialIngestStatus.lastBackfillProcessedAt = Date.now();
      serialIngestStatus.lastBackfillEventId = result.event?.id || "";
      serialIngestStatus.lastBackfillRequestedEventId = queued.eventId || "";
      serialIngestStatus.lastBackfillActiveEventId = result.activeEventId || "";
      serialIngestStatus.lastBackfillPacketId = queued.packetId || "";
      serialIngestStatus.lastBackfillCapturedAt = queued.receivedAt || null;
      serialIngestStatus.lastBackfillResolvedBy = result.resolvedBy || "";
      serialIngestStatus.lastBackfillCandidateCount = Number(result.candidateCount || 0);
      serialIngestStatus.lastBackfillAckStatus = result.ackStatus || "";
      serialIngestStatus.lastBackfillRejectReason = result.rejectReason || "";
      onBackfillResult({ queued, result });
    }
    if (result.duplicate) {
      serialIngestStatus.duplicatePackets += 1;
      if (queued.backfill) serialIngestStatus.backfillDuplicatePackets += 1;
    }
    else if (result.accepted) {
      serialIngestStatus.processedPackets += 1;
      const rawSampleCount = Number(result.rawSampleCount || 0);
      const mappedSampleCount = Number(result.mappedSampleCount || 0);
      const persistedSampleCount = Number(result.persistedSampleCount || 0);
      const throttledSampleCount = Number(result.throttledSampleCount || 0);
      const staleSampleCount = Number(result.staleSampleCount || 0);
      const unmappedSampleCount = Number(result.unmappedSampleCount || 0);
      const outOfWindowSampleCount = Number(result.outOfWindowSampleCount || 0);
      serialIngestStatus.receivedSamples += rawSampleCount;
      serialIngestStatus.mappedSamples += mappedSampleCount;
      serialIngestStatus.persistedSamples += persistedSampleCount;
      serialIngestStatus.throttledSamples += throttledSampleCount;
      serialIngestStatus.staleSamples += staleSampleCount;
      serialIngestStatus.unmappedSamples += unmappedSampleCount;
      serialIngestStatus.outOfWindowSamples += outOfWindowSampleCount;
      const pureThrottle = persistedSampleCount === 0
        && mappedSampleCount > 0
        && throttledSampleCount === mappedSampleCount
        && staleSampleCount === 0
        && unmappedSampleCount === 0
        && outOfWindowSampleCount === 0;
      // Backfill is a separate recovery lane. It must not replace the health
      // report for the currently connected receiver array, otherwise the UI
      // alternates between a healthy 9/9 live packet and an unrelated old
      // unmapped packet while recovery is running. Pure 200 ms throttling is
      // healthy too and should not flash as "落库 0/N".
      if (!queued.backfill && !pureThrottle) {
        serialIngestStatus.lastPacketRawSamples = rawSampleCount;
        serialIngestStatus.lastPacketMappedSamples = mappedSampleCount;
        serialIngestStatus.lastPacketPersistedSamples = persistedSampleCount;
        serialIngestStatus.lastPacketThrottledSamples = throttledSampleCount;
        serialIngestStatus.lastPacketStaleSamples = staleSampleCount;
        serialIngestStatus.lastPacketUnmappedSamples = unmappedSampleCount;
        serialIngestStatus.lastPacketOutOfWindowSamples = outOfWindowSampleCount;
        serialIngestStatus.lastPacketNoActiveEvent = Boolean(result.noActiveEvent);
        serialIngestStatus.lastPacketUnassignedReceiverIds = result.unassignedReceiverIds || [];
        serialIngestStatus.lastPacketMissingPilotIds = result.missingPilotIds || [];
        serialIngestStatus.lastEventId = result.event?.id || "";
      }
      if (!queued.backfill && Number(result.latestSampleTime) > 0) {
        serialIngestStatus.lastSampleTime = Number(result.latestSampleTime);
      }
      if (!queued.backfill && persistedSampleCount > 0) {
        serialIngestStatus.lastPersistedSampleAt = Date.now();
        serialIngestStatus.lastPersistedSampleTime = Math.max(
          Number(serialIngestStatus.lastPersistedSampleTime) || 0,
          Number(result.latestSampleTime) || 0,
        ) || null;
      }
      if (!queued.backfill && mappedSampleCount > 0) serialIngestStatus.lastMappedSampleAt = Date.now();
    }
    else serialIngestStatus.failedPackets += 1;
    serialIngestStatus.lastError = result.error?.message || "";
  }
  const elapsedMs = Date.now() - startedAt;
  if (processedPackets) {
    serialIngestStatus.lastProcessMs = elapsedMs;
    serialIngestStatus.maxProcessMs = Math.max(serialIngestStatus.maxProcessMs, elapsedMs);
    serialIngestStatus.lastProcessedAt = Date.now();
  }
  try {
    flushPendingTrainingIntervals(Date.now());
  } catch (error) {
    serialIngestStatus.lastError = error.message || "training interval flush failed";
    serialIngestStatus.failedPackets += 1;
  }
  return processedPackets;
}

function processQueuedTrainingCsvPackets() {
  const queuedPackets = pendingTrainingCsvPackets.splice(0, pendingTrainingCsvPackets.length);
  if (!queuedPackets.length) return;

  for (const queued of queuedPackets) {
    const eventRow = queued.eventId ? eventByIdQuery.get(queued.eventId) : activeEventQuery.get();
    if (!eventRow) continue;
    const event = eventFromRow(eventRow);
    const runtime = getCsvRuntimeForEvent(event, queued.receivedAt);
    const rawSamples = parseSerialPacket(queued.packet, queued.receivedAt);
    for (const rawSample of rawSamples) {
      const participant = participantForReceiverAt(runtime, event, rawSample.receiverId, Number(rawSample.time) || queued.receivedAt);
      if (!participant) continue;
      const pilot = runtime.pilotsById.get(participant.pilotId);
      if (!pilot) continue;
      processTrainingCsvSample(event, pilot, participant, rawSample, runtime, queued.receivedAt);
    }
  }
}
return {
  COACH_LLM_CONFIG_KEY, COACH_SNAPSHOT_INTERVAL_MS, COACH_STALE_AFTER_MS, COACH_WINDOW_MS,
  DEFAULT_COACH_LLM_CONFIG, DEFAULT_LESSON_BUDGET_CONFIG, LESSON_BUDGET_CONFIG_KEY, LESSON_EXTRA_MATERIAL_KEY,
  LESSON_SYSTEM_PROMPT_KEY, LESSON_TEACHING_MANUAL_KEY, PERSONAL_LESSON_OPTIMIZE_LIMIT,
  activeEventQuery, allPilotsQuery, buildEventTimelinePatch, buildServerLiveState, coachLlmRuntime, eventByIdQuery,
  coachSnapshotStore, ensureTrainingCsvFile, flushPendingTrainingIntervals, flushTrainingCsvQueue, getTrainingCsvStatus,
  ensureEventTimelineCurrent, getEventTimelineStatus,
  maybeBuildServerLiveState, processQueuedSerialPackets, processQueuedTrainingCsvPackets,
  rebuildEventTimelineFromSamples,
  refreshReceiverState, refreshTrainingCsvFileSize, upsertStat,
};
}
