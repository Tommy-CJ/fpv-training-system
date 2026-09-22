import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildPersistenceSerialSnapshot, isHistoricalRecoveryRecord, shouldSendCurrentPersistence } from "../src/livePersistence.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "fpv-training-live-"));

const snapshotAt = Date.now();
if (!shouldSendCurrentPersistence(1, true) || shouldSendCurrentPersistence(0, false)) {
  throw new Error("current 5 Hz persistence was blocked by historical outbox recovery");
}
if (
  !isHistoricalRecoveryRecord({ clientSequence: 40 }, 40, 0)
  || isHistoricalRecoveryRecord({ clientSequence: 41 }, 40, 0)
  || !isHistoricalRecoveryRecord({ capturedAt: snapshotAt - 1 }, 1, snapshotAt)
  || isHistoricalRecoveryRecord({ capturedAt: snapshotAt + 1 }, 1, snapshotAt)
  || !isHistoricalRecoveryRecord({ capturedAt: snapshotAt - 1 }, 0, snapshotAt)
) {
  throw new Error("historical recovery generation did not survive legacy records or a client sequence reset");
}
const partialReceiverSnapshot = buildPersistenceSerialSnapshot(Object.fromEntries(
  Array.from({ length: 16 }, (_, index) => [index + 1, {
    receiverId: index + 1,
    time: snapshotAt - index * 20,
    sourceTime: snapshotAt - index * 20,
    rawChannels: [992, 992, 172, 992, 172, 172, 172, 172],
    lq: 100,
    rssi: -45,
  }]),
), snapshotAt);
if (partialReceiverSnapshot?.items?.length !== 16 || partialReceiverSnapshot.items.map((item) => item.rx).join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16") {
  throw new Error(`per-receiver persistence snapshot lost partial serial frames: ${JSON.stringify(partialReceiverSnapshot)}`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const port = await freePort();
const server = spawn(process.execPath, [path.join(repoRoot, "server.js")], {
  cwd: runtimeDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), COACH_PASSWORD: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early\n${serverOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/events`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error(`server did not start\n${serverOutput}`);
}

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

function connect(role, afterSequence = 0) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live-ws`);
    const messages = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: role, room: "default", afterSequence }));
      resolve({ socket, messages });
    }, { once: true });
  });
}

function rawPacket(receiverId, highThrottle) {
  return {
    type: "rx_batch",
    items: [{
      rx: receiverId,
      ch: [992, 992, highThrottle ? 1811 : 172, 992, 1811, 172, 172, 172],
      lq: 100,
      rssi: -45,
    }],
  };
}

function rawReceiverArray(receiverCount, highThrottle) {
  return {
    type: "rx_batch",
    items: Array.from({ length: receiverCount }, (_, index) => rawPacket(index + 1, highThrottle).items[0]),
  };
}

try {
  await waitForServer();
  await json("/api/pilots", {
    method: "POST",
    body: JSON.stringify([{ id: "pilot-1", name: "测试飞手", channelConfig: { ch5: [{ name: "Arm", type: "arm", min: 1500, max: 2000 }], ch6: [], ch7: [{ name: "Turtle", type: "turtle", min: 1500, max: 2000 }], ch8: [] } }]),
  });
  const startedAt = Date.now() - 10 * 60 * 1000;
  const started = await json("/api/events/start", {
    method: "POST",
    body: JSON.stringify({ id: "event-live-test", name: "实时链路验证", startedAt, participants: [{ pilotId: "pilot-1", receiverId: 1, trainingStartAt: startedAt }] }),
  });

  const publisher = await connect("publish_live");
  // The stable core contract does not depend on the browser's secondary
  // persistOnly/outbox message. A plain 30 Hz live frame must be enough for
  // the server's 200 ms sampler to create authoritative SQLite history.
  const liveOnlyPersistenceAt = Date.now();
  for (let index = 0; index < 8; index += 1) {
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawPacket(1, index % 2 === 0),
      clientTime: Date.now(),
      liveOnly: true,
    }));
    await delay(35);
  }
  await delay(350);
  const liveOnlyStoredSamples = await json(`/api/training-events/${started.event.id}/samples?since=${liveOnlyPersistenceAt - 50}`);
  if (!liveOnlyStoredSamples.length) {
    throw new Error("30 Hz live stream no longer feeds the server-owned 5 Hz SQLite sampler");
  }
  const historicalCapturedAt = startedAt + 1000;
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(1, true),
    clientTime: historicalCapturedAt,
    clientSequence: 0,
    packetId: "verify:historical-backfill",
    eventId: started.event.id,
    backfill: true,
  }));
  for (let index = 0; index < 30; index += 1) {
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawPacket(1, index % 2 === 0),
      clientTime: startedAt + 2000 + index * 33,
      clientSequence: index + 1,
      packetId: `verify:legacy-backfill:${index + 1}`,
      eventId: started.event.id,
      backfill: true,
      persistOnly: true,
    }));
  }
  const priorityLiveAt = Date.now();
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(1, true),
    clientTime: priorityLiveAt,
    clientSequence: 1000,
    packetId: "verify:current-priority",
    eventId: started.event.id,
    liveOnly: true,
    durable: true,
  }));
  await delay(800);
  const prioritySamples = await json(`/api/training-events/${started.event.id}/samples?since=${priorityLiveAt - 50}`);
  if (!prioritySamples.some((sample) => Number(sample.time) >= priorityLiveAt - 50)) {
    const priorityStatus = await json("/api/training-csv/status");
    throw new Error(`current 5 Hz sample waited behind historical recovery backlog: ${JSON.stringify({ priorityLiveAt, prioritySamples, ingest: priorityStatus.ingest })}`);
  }
  await delay(1200);
  const compactedBackfillStatus = await json("/api/training-csv/status");
  const acknowledgedBackfill = publisher.messages.filter((message) => message.type === "live_packet_ack" && message.packetId?.startsWith("verify:legacy-backfill:")).length;
  if (acknowledgedBackfill !== 30 || compactedBackfillStatus.ingest?.supersededPackets < 20) {
    throw new Error(`legacy 30Hz backfill was not compacted safely: ${JSON.stringify({ acknowledgedBackfill, ingest: compactedBackfillStatus.ingest })}`);
  }
  const subscriber = await connect("subscribe_live");
  const orderingMessageStart = subscriber.messages.length;
  const newerLiveClientTime = Date.now();
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(1, false),
    clientTime: newerLiveClientTime,
    liveOnly: true,
  }));
  await delay(20);
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(1, true),
    clientTime: newerLiveClientTime - 100,
    clientSequence: 1001,
    packetId: "verify:delayed-durable",
    eventId: started.event.id,
    liveOnly: true,
    durable: true,
  }));
  await delay(300);
  const orderingBatches = subscriber.messages.slice(orderingMessageStart)
    .filter((message) => message.type === "live_batch" && !message.snapshot);
  if (orderingBatches.length !== 1) {
    throw new Error(`a delayed durable frame rolled the live audience backwards: ${orderingBatches.length} broadcasts`);
  }
  const durableBroadcastStart = subscriber.messages.length;
  for (let index = 1; index <= 18; index += 1) {
    const capturedAt = Date.now();
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawPacket(1, index % 2 === 0),
      clientTime: capturedAt,
      clientSequence: index,
      packetId: `verify:${index}`,
      eventId: started.event.id,
      liveOnly: true,
      durable: true,
    }));
    await delay(35);
  }
  await delay(700);
  const liveSequences = subscriber.messages.slice(durableBroadcastStart)
    .filter((message) => message.type === "live_batch" && !message.snapshot)
    .map((message) => message.sequence);
  if (liveSequences.length !== 18 || new Set(liveSequences).size !== 18) {
    throw new Error(`expected 18 distinct live batches, got ${liveSequences.length}`);
  }
  const acknowledgedDurableFrames = publisher.messages.filter((message) => (
    message.type === "live_packet_ack" && /^verify:\d+$/.test(message.packetId || "")
  )).length;
  if (acknowledgedDurableFrames !== 18) {
    throw new Error(`durable live frames were not acknowledged exactly once: ${acknowledgedDurableFrames}/18`);
  }
  const transferStatus = await json("/api/training-csv/status");
  if (!transferStatus.ingest?.persistedSamples || !transferStatus.ingest?.lastPersistedSampleTime) {
    throw new Error(`history status reported mapping without actual SQLite persistence: ${JSON.stringify(transferStatus.ingest)}`);
  }
  if (transferStatus.audienceDownload?.audienceCount !== 1 || transferStatus.audienceDownload?.bitsPerSecond <= 0) {
    throw new Error(`audience download pressure metrics missing: ${JSON.stringify(transferStatus.audienceDownload)}`);
  }
  if (!transferStatus.ingest?.compactedCurrentPackets) {
    throw new Error(`current 30 Hz sampling compaction was not reported separately: ${JSON.stringify(transferStatus.ingest)}`);
  }

  // An unrelated stale recovery record must not replace the diagnostic for
  // the healthy current receiver stream with a flashing "0/0 unmapped" state.
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawReceiverArray(9, true),
    clientTime: startedAt + 500,
    clientSequence: 1999,
    packetId: "verify:missing-event-backfill",
    eventId: "missing-event",
    backfill: true,
    persistOnly: true,
  }));
  await delay(350);
  const statusAfterMissingBackfill = await json("/api/training-csv/status");
  if (
    statusAfterMissingBackfill.ingest?.lastEventId !== transferStatus.ingest.lastEventId
    || statusAfterMissingBackfill.ingest?.lastPacketMappedSamples !== transferStatus.ingest.lastPacketMappedSamples
    || statusAfterMissingBackfill.ingest?.lastPacketUnmappedSamples !== transferStatus.ingest.lastPacketUnmappedSamples
  ) {
    throw new Error(`backfill overwrote current-stream diagnostics: ${JSON.stringify(statusAfterMissingBackfill.ingest)}`);
  }

  // Simulate recovery data whose live_backfill_complete notification is lost.
  // After the recovery stream becomes quiet, the server itself must finish the
  // rebuild and notify clients; mobile reconnect correctness cannot depend on
  // one final browser control message surviving a socket transition.
  const lostCompletionResyncStart = subscriber.messages.length;
  const lostCompletionAt = startedAt + 2 * 60 * 1000;
  for (const [offset, highThrottle] of [[0, true], [300, false]]) {
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawPacket(1, highThrottle),
      clientTime: lostCompletionAt + offset,
      clientSequence: 2000 + offset,
      packetId: `verify:lost-completion:${offset}`,
      eventId: started.event.id,
      backfill: true,
      persistOnly: true,
    }));
    await delay(300);
  }
  const verificationDb = new DatabaseSync(path.join(runtimeDir, "data", "training.db"), { readOnly: true });
  const durableRebuildMarker = verificationDb.prepare(
    "SELECT reason FROM training_timeline_rebuild_queue WHERE event_id = ?",
  ).get(started.event.id);
  verificationDb.close();
  if (durableRebuildMarker?.reason !== "out_of_order_backfill") {
    throw new Error(`out-of-order recovery did not persist its rebuild marker: ${JSON.stringify(durableRebuildMarker)}`);
  }
  await delay(1300);
  if (!subscriber.messages.slice(lostCompletionResyncStart).some((message) => (
    message.type === "live_timeline_resync" && message.eventId === started.event.id
  ))) {
    throw new Error("server did not automatically finalize a quiet backfill stream after the browser completion message was lost");
  }
  const rebuiltFullState = subscriber.messages.slice(lostCompletionResyncStart).find((message) => (
    message.type === "live_state"
    && (message.state?.bandsByPilot?.["pilot-1"] || []).some((band) => (
      Number(band.start) <= lostCompletionAt && Number(band.end) >= lostCompletionAt + 300
    ))
  ));
  if (!rebuiltFullState) {
    throw new Error("server finalized recovery but did not replace the stale reconnect snapshot with a complete rebuilt timeline");
  }
  const selfHealedOverview = await json(`/api/training-events/${started.event.id}/stats?cached=1`);
  if (selfHealedOverview.timeline?.rebuildPending) {
    throw new Error(`automatic backfill finalization left timeline rebuild pending: ${JSON.stringify(selfHealedOverview.timeline)}`);
  }
  if (!selfHealedOverview.segments.some((segment) => (
    segment.pilot_id === "pilot-1"
    && Number(segment.started_at) <= lostCompletionAt
    && Number(segment.ended_at) >= lostCompletionAt + 300
  ))) {
    throw new Error("automatic backfill finalization did not rebuild an out-of-order timeline");
  }

  const currentEvents = await json("/api/events");
  const currentEvent = currentEvents.find((event) => event.id === started.event.id);
  const beforeReceiverMigrationAt = Date.now() - 1;
  currentEvent.participants[0].receiverId = 10;
  await json("/api/events", { method: "POST", body: JSON.stringify(currentEvents) });

  const migrationStateStart = subscriber.messages.length;
  publisher.socket.send(JSON.stringify({
    type: "live_state",
    room: "default",
    state: { event: currentEvent, updatedAt: Date.now() },
  }));
  await delay(150);
  const migrationState = subscriber.messages
    .slice(migrationStateStart)
    .find((message) => message.type === "live_state" && message.state?.bandsByPilot)?.state;
  if (
    !(migrationState?.bandsByPilot?.["pilot-1"] || []).length
    || Number(migrationState.event?.participants?.[0]?.receiverId) !== 10
  ) {
    throw new Error(`receiver migration did not publish a fresh complete timeline baseline: ${JSON.stringify(migrationState)}`);
  }

  // A delayed packet captured before the receiver change must still map through
  // the assignment history, even though it arrives after RX10 became current.
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(1, true),
    clientTime: beforeReceiverMigrationAt,
    clientSequence: 18,
    packetId: "verify:receiver-migration-backfill",
    eventId: started.event.id,
    backfill: true,
    persistOnly: true,
  }));
  await delay(600);
  const migrationSamples = await json(`/api/training-events/${started.event.id}/samples?since=${beforeReceiverMigrationAt - 50}`);
  if (!migrationSamples.some((sample) => (
    sample.pilotId === "pilot-1"
    && Number(sample.receiverId) === 1
    && Math.abs(Number(sample.time) - beforeReceiverMigrationAt) <= 50
  ))) {
    throw new Error("pre-migration backfill did not follow receiver assignment history");
  }

  await delay(30);
  for (let index = 19; index <= 30; index += 1) {
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawPacket(10, index % 2 === 0),
      clientTime: Date.now(),
      clientSequence: index,
      packetId: `verify:${index}`,
      eventId: started.event.id,
    }));
    await delay(35);
  }
  await delay(700);

  const authoritativeState = subscriber.messages.filter((message) => message.type === "live_state").at(-1)?.state;
  const authoritativeBandCount = Object.values(authoritativeState?.bandUpdatesByPilot || {})
    .reduce((total, bands) => total + bands.length, 0);
  if (!authoritativeBandCount) throw new Error("live state did not include incremental authoritative band updates");

  const resumedSubscriber = await connect("subscribe_live", 25);
  await delay(150);
  const resumedState = resumedSubscriber.messages.find((message) => message.type === "live_state")?.state;
  if (!(resumedState?.bandsByPilot?.["pilot-1"] || []).length) {
    throw new Error(`reloaded audience did not receive a complete authoritative timeline: ${JSON.stringify(resumedState)}`);
  }
  if (!resumedState?.summaries?.["pilot-1"]) {
    throw new Error(`reloaded audience did not receive authoritative statistics: ${JSON.stringify(resumedState)}`);
  }
  const resumedSummary = resumedState.summaries["pilot-1"];
  if (Number(resumedSummary.utilizationFlightMs || 0) > Number(resumedSummary.totalFlightMs || 0) + 1) {
    throw new Error(`authoritative utilization numerator exceeded actual flight time: ${JSON.stringify(resumedSummary)}`);
  }
  const replayedSequences = resumedSubscriber.messages.filter((message) => message.type === "live_batch").map((message) => message.sequence);
  const latestPublishedSequence = subscriber.messages.filter((message) => message.type === "live_batch").at(-1)?.sequence;
  if (replayedSequences.join(",") !== String(latestPublishedSequence)) {
    throw new Error(`latest-frame resume mismatch: ${replayedSequences.join(",")}`);
  }
  resumedSubscriber.socket.close();

  const reloadedPublisher = await connect("publish_live");
  await delay(150);
  const reloadedPublisherState = reloadedPublisher.messages.find((message) => message.type === "live_state")?.state;
  if (!(reloadedPublisherState?.bandsByPilot?.["pilot-1"] || []).length || !reloadedPublisherState?.summaries?.["pilot-1"]) {
    throw new Error(`reloaded coach did not receive complete timeline/statistics: ${JSON.stringify(reloadedPublisherState)}`);
  }
  reloadedPublisher.socket.close();

  const storedSamples = await json(`/api/training-events/${started.event.id}/samples?since=${startedAt}`);
  if (!storedSamples.some((sample) => sample.time === historicalCapturedAt)) {
    throw new Error("historical backfill did not preserve its original capture time");
  }
  const storedReceiverIds = new Set(storedSamples
    .filter((sample) => sample.pilotId === "pilot-1")
    .map((sample) => Number(sample.receiverId)));
  if (!storedReceiverIds.has(1) || !storedReceiverIds.has(10)) {
    throw new Error(`receiver migration samples were not joined under one pilot: ${[...storedReceiverIds].join(",")}`);
  }
  const latestStoredSampleAt = Math.max(...storedSamples.map((sample) => Number(sample.time) || 0));
  const latestReloadedBandEnd = Math.max(...(resumedState.bandsByPilot["pilot-1"] || []).map((band) => Number(band.end) || 0));
  if (latestStoredSampleAt - latestReloadedBandEnd > 1000) {
    throw new Error(`reloaded timeline lost its nearby persisted tail: ${JSON.stringify({ latestStoredSampleAt, latestReloadedBandEnd })}`);
  }
  publisher.socket.send(JSON.stringify({ type: "live_backfill_complete", room: "default", eventId: started.event.id }));
  await delay(50);
  if (!subscriber.messages.some((message) => message.type === "live_timeline_resync" && message.eventId === started.event.id)) {
    throw new Error("audience was not told to refresh authoritative history after backfill");
  }
  if (!publisher.messages.some((message) => message.type === "live_timeline_resync" && message.eventId === started.event.id)) {
    throw new Error("publisher was not told to refresh authoritative history after backfill");
  }
  const rebuiltTimeline = await json(`/api/training-events/${started.event.id}/stats?cached=1`);
  if (!rebuiltTimeline.segments.some((segment) => (
    segment.pilot_id === "pilot-1"
    && Number(segment.started_at) <= historicalCapturedAt
    && Number(segment.ended_at) > historicalCapturedAt
  ))) {
    throw new Error("out-of-order recovery samples did not rebuild the authoritative SQLite timeline");
  }

  const loadSubscribers = await Promise.all(Array.from({ length: 12 }, () => connect("subscribe_live")));
  for (let index = 0; index < 5; index += 1) {
    publisher.socket.send(JSON.stringify({
      type: "live_batch",
      room: "default",
      batch: rawReceiverArray(16, index % 2 === 0),
      clientTime: Date.now(),
      clientSequence: 31 + index,
      packetId: `verify:capacity:${index}`,
      eventId: started.event.id,
    }));
    await delay(10);
  }
  await delay(150);
  const capacityStatus = await json("/api/training-csv/status");
  if (capacityStatus.audienceDownload?.targetLiveFps !== 30) {
    throw new Error(`healthy audience links were pre-throttled below 30Hz: ${JSON.stringify(capacityStatus.audienceDownload)}`);
  }
  for (const connection of loadSubscribers) connection.socket.close();
  await delay(300);

  // Current live packets must follow the stable core path: the active event
  // and its current receiver mapping win even if the publisher carries a
  // stale event id. Historical assignment lookup is reserved for backfill.
  const stableLiveAt = Date.now();
  publisher.socket.send(JSON.stringify({
    type: "live_batch",
    room: "default",
    batch: rawPacket(10, true),
    clientTime: Date.now() - 4 * 60 * 1000,
    clientSequence: 99,
    packetId: "verify:stable-live-mapping",
    eventId: "stale-event-id",
    liveOnly: true,
    durable: true,
  }));
  await delay(700);
  const stableLiveSamples = await json(`/api/training-events/${started.event.id}/samples?since=${stableLiveAt - 100}`);
  if (!stableLiveSamples.some((sample) => sample.pilotId === "pilot-1" && Number(sample.receiverId) === 10)) {
    throw new Error("current live packet did not use active-event receiver mapping");
  }
  const receiverStateSubscriber = await connect("subscribe_live");
  await delay(150);
  const receiverState = receiverStateSubscriber.messages.find((message) => message.type === "live_state")?.state?.receiverState;
  receiverStateSubscriber.socket.close();
  if (!receiverState?.connected || receiverState.receiverCount < 1) {
    throw new Error(`server receipt clock did not keep receiver state online: ${JSON.stringify(receiverState)}`);
  }

  const detail = await json(`/api/events/${started.event.id}/detail?recompute=1`);
  const receivers = detail.participants[0].receiverHistory.map((item) => item.receiverId);
  if (receivers.join(",") !== "1,10") throw new Error(`receiver migration missing: ${receivers.join(",")}`);
  if (!detail.participants[0].segments.length) throw new Error("expected persisted timeline segments");

  const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const uploadedMedia = await json(`/api/training-events/${started.event.id}/media`, {
    method: "POST",
    body: JSON.stringify({ dataUrl: tinyPng, caption: "联调现场", capturedAt: Date.now() }),
  });
  if (uploadedMedia.media?.length !== 1 || !uploadedMedia.media[0].url?.startsWith("/uploads/training/")) {
    throw new Error(`training media upload failed: ${JSON.stringify(uploadedMedia)}`);
  }
  const publicMedia = await json(`/api/training-events/${started.event.id}/media`);
  if (publicMedia.media?.[0]?.caption !== "联调现场") throw new Error("training media public listing failed");

  const endedAt = Date.now();
  const editedEvents = await json("/api/events");
  const editedEvent = editedEvents.find((event) => event.id === started.event.id);
  editedEvent.participants[0].trainingEndAt = endedAt;
  await json("/api/events", { method: "POST", body: JSON.stringify(editedEvents) });
  const firstStats = await json(`/api/training-events/${started.event.id}/stats?cached=1`);
  await delay(1100);
  const secondStats = await json(`/api/training-events/${started.event.id}/stats?cached=1`);
  if (firstStats.stats[0].utilization !== secondStats.stats[0].utilization) throw new Error("utilization changed after participant end");

  const trimAt = Math.max(startedAt + 500, detail.lastSampleAt - 100);
  const trimmed = await json(`/api/events/${started.event.id}/trim`, { method: "POST", body: JSON.stringify({ endedAt: trimAt }) });
  if (trimmed.event.endedAt !== trimAt || trimmed.event.active) throw new Error("event trim did not fix end time");

  await json(`/api/training-events/${started.event.id}/weather-config`, {
    method: "POST",
    body: JSON.stringify({ longitude: 23.13, latitude: 113.25, trainingDate: "2026-09-16" }),
  });
  const secondEvent = { id: "event-weather-test", name: "天气继承验证", createdAt: Date.now(), active: false, participants: [] };
  await json("/api/events", { method: "POST", body: JSON.stringify([secondEvent, ...editedEvents.filter((event) => event.id !== started.event.id)]) });
  const inheritedWeather = await json(`/api/training-events/${secondEvent.id}/weather-config`);
  if (inheritedWeather.config.longitude !== 113.25 || inheritedWeather.config.latitude !== 23.13) throw new Error("weather location was not inherited");

  await json("/api/teaching/lesson-system-prompt", { method: "POST", body: JSON.stringify({ systemPrompt: "记住备课提示词" }) });
  const lessonPrompt = await json("/api/teaching/lesson-system-prompt");
  if (lessonPrompt.systemPrompt !== "记住备课提示词") throw new Error("lesson prompt was not persisted");
  await json("/api/coach/llm-config", { method: "POST", body: JSON.stringify({ systemPrompt: "记住助教提示词" }) });
  const coachConfig = await json("/api/coach/llm-config");
  if (coachConfig.systemPrompt !== "记住助教提示词") throw new Error("coach prompt was not persisted");
  await json("/api/ai-summary-config", { method: "POST", body: JSON.stringify({ systemPrompt: "记住总结提示词", includeTasks: true, includeReviews: false }) });
  const summaryConfig = await json("/api/ai-summary-config");
  if (summaryConfig.systemPrompt !== "记住总结提示词" || summaryConfig.includeReviews !== false) throw new Error("summary prompt was not persisted");

  await json(`/api/events/${started.event.id}`, { method: "DELETE" });
  const removedMediaResponse = await fetch(`http://127.0.0.1:${port}${publicMedia.media[0].url}`);
  if (removedMediaResponse.status !== 404) throw new Error("event deletion left its training media file behind");

  publisher.socket.close();
  subscriber.socket.close();
  console.log(JSON.stringify({ ok: true, liveBatches: liveSequences.length, receiverHistory: receivers, trimDeletedSamples: trimmed.deletedSamples, audienceMbps: Number((transferStatus.audienceDownload.bitsPerSecond / 1_000_000).toFixed(3)), mediaCount: publicMedia.media.length }));
} finally {
  server.kill();
  await delay(100);
  await fs.rm(runtimeDir, { recursive: true, force: true });
}
