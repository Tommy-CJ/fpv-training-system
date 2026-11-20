import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { NativeTrainingCollector } from "../collector.mjs";
import { CollectorOutbox } from "../outbox.mjs";

const require = createRequire(import.meta.url);
const { findConfiguredPort, portIdentity, portLabel, portReadyToOpen, sortPorts } = require("../portInfo.cjs");
const hub = {
  path: "COM16", manufacturer: "Microsoft", friendlyName: "USB 串行设备 (COM16)",
  vendorId: "0483", productId: "5740", serialNumber: "TRAINING_HUB_001",
  pnpId: "USB\\VID_0483&PID_5740\\TRAINING_HUB_001",
};
const flightController = {
  ...hub, serialNumber: "FLIGHT_CONTROLLER_001",
  pnpId: "USB\\VID_0483&PID_5740\\FLIGHT_CONTROLLER_001",
};
assert.match(portLabel(hub), /TRAINING_HUB_001.*COM16/);
assert.doesNotMatch(portLabel(hub), /Microsoft/);
assert.notEqual(portIdentity(hub), portIdentity(flightController),
  "a flight controller with the same STM32 VID/PID must not be accepted as the saved receiver hub");
assert.equal(findConfiguredPort([hub], { portPath: "", portIdentity: "" }), null,
  "the collector must never auto-select even a unique STM32 port");
assert.equal(findConfiguredPort([flightController], { portPath: "COM16", portIdentity: portIdentity(hub) }), null,
  "the same COM path and VID/PID must not override the selected device identity");
assert.equal(findConfiguredPort([hub], { portPath: "COM16", portIdentity: portIdentity(hub) }), hub);
assert.equal(portReadyToOpen([hub], { portPath: "COM16", portIdentity: portIdentity(hub) }, false), null,
  "a saved port must remain disconnected until the user clicks Connect");
assert.equal(portReadyToOpen([hub], { portPath: "COM16", portIdentity: portIdentity(hub) }, true), hub);
assert.equal(sortPorts([{ path: "COM5", friendlyName: "蓝牙链接上的标准串行 (COM5)" }, hub])[0].path, "COM16");

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  sent = [];
  send(text) {
    assert.equal(this.readyState, 1);
    const message = JSON.parse(text);
    if (message.packetId) {
      assert.ok(collector.outbox.pending().some((record) => record.packetId === message.packetId),
        "durable frame must be committed to SQLite before WebSocket.send");
    }
    this.sent.push(message);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "fpv-collector-test-"));
const sockets = [];
const collector = new NativeTrainingCollector({
  dbPath: path.join(temporaryDir, "cache.sqlite"),
  remoteOrigin: "https://example.invalid",
  socketFactory: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
  fetchImpl: async (url) => ({ ok: true, json: async () => String(url).endsWith("/api/pilots")
    ? [{ id: "pilot-1", name: "张晨" }]
    : [{ id: "event-1", name: "训练事件", active: true, participants: [{ pilotId: "pilot-1", receiverId: 1 }] }] }),
});

const legacyPath = path.join(temporaryDir, "legacy.sqlite");
const legacyDb = new DatabaseSync(legacyPath);
legacyDb.exec(`
  CREATE TABLE packets (packet_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
    event_id TEXT NOT NULL, captured_at INTEGER NOT NULL, batch_json TEXT NOT NULL);
  INSERT INTO packets VALUES ('legacy:1', 1, 'old-event', 1000, '{}');
`);
legacyDb.close();
const migratedOutbox = new CollectorOutbox(legacyPath);
assert.equal(migratedOutbox.pendingCount(), 1, "existing SQLite packets must remain eligible after migration");
migratedOutbox.markRejected("legacy:1", "orphaned", "event_time_mismatch");
assert.equal(migratedOutbox.count(), 1);
assert.equal(migratedOutbox.pendingCount(), 0);
migratedOutbox.close();
const reopenedMigration = new CollectorOutbox(legacyPath);
assert.equal(reopenedMigration.rejectedCount(), 1, "rejection must persist in an upgraded SQLite cache");
assert.deepEqual(reopenedMigration.recoveryEvents(1), []);
reopenedMigration.close();

function packet(time, throttle = 600) {
  return { type: "rx_batch", v: 1, t: time, items: [{ rx: 1, ch: [992, 992, throttle, 992, 1811, 992, 992, 992], lq: 100 }] };
}

try {
  collector.setEventId("event-1");
  collector.start();
  await collector.refreshEventId();
  sockets[0].open();
  assert.equal(sockets[0].sent[0].type, "publish_live");

  const serial = new EventEmitter();
  collector.attachSerial(serial);
  const now = Date.now();
  const first = packet(1000);
  const encoded = Buffer.from(JSON.stringify(first));
  serial.emit("data", encoded.subarray(0, 20));
  assert.equal(collector.framesRead, 0, "split serial JSON cannot be published early");
  serial.emit("data", encoded.subarray(20));
  assert.equal(collector.framesRead, 1);
  assert.equal(collector.getMonitorSnapshot().receivers[0]?.receiverId, 1);
  assert.equal(collector.getMonitorSnapshot().receivers[0]?.pilotName, "张晨");
  assert.equal(collector.getMonitorSnapshot().eventName, "训练事件");
  assert.equal(collector.outbox.count(), 1, "selected durable frame is on disk before ACK");
  assert.equal(sockets[0].sent.filter((item) => item.source === "native_collector").length, 1);
  const firstDurable = sockets[0].sent.find((item) => item.packetId);
  assert.ok(firstDurable);
  assert.equal(firstDurable.persistOnly, true);
  assert.equal(firstDurable.durable, true);
  assert.equal(firstDurable.backfill, undefined);

  sockets[0].receive({ type: "live_packet_ack", packetId: firstDurable.packetId, status: "accepted", sampled: false });
  assert.equal(collector.outbox.count(), 1, "an unprocessed ACK cannot remove disk evidence");
  sockets[0].receive({ type: "live_packet_ack", packetId: firstDurable.packetId, status: "persisted", sampled: true });
  assert.equal(collector.outbox.count(), 0);

  sockets[0].close();
  collector.acceptFrame(packet(1230, 800), now + 230);
  collector.acceptFrame(packet(1460, 500), now + 460);
  assert.equal(collector.outbox.count(), 2, "network outage retains sampled frames on disk");
  const reopenedOutbox = new CollectorOutbox(path.join(temporaryDir, "cache.sqlite"));
  assert.equal(reopenedOutbox.count(), 2, "a second process can recover the disk cache");
  reopenedOutbox.close();

  collector.connect();
  sockets[1].open();
  const replay = sockets[1].sent.filter((item) => item.packetId);
  assert.equal(replay.length, 2);
  assert.ok(replay.every((item) => item.backfill === true && item.persistOnly === true));
  assert.equal(sockets[1].sent.filter((item) => item.source === "native_collector").length, 0,
    "historical recovery cannot be painted as current live");
  assert.ok(replay.every((item) => item.clientTime >= now && item.clientTime <= now + 460));
  for (const item of replay) {
    sockets[1].receive({ type: "live_packet_ack", packetId: item.packetId, status: "persisted", sampled: true });
  }
  assert.equal(collector.outbox.count(), 0);
  assert.ok(sockets[1].sent.some((item) => item.type === "live_backfill_complete"));
  assert.equal(collector.getStatus().serverConnected, true);

  const orphan = collector.outbox.cache("event-1", now - 10_000, packet(1700));
  collector.flushOutbox();
  assert.ok(sockets[1].sent.some((item) => item.packetId === orphan.packetId && item.backfill === true));
  sockets[1].receive({
    type: "live_packet_ack", packetId: orphan.packetId,
    status: "orphaned", reason: "event_time_mismatch", accepted: false,
  });
  assert.equal(collector.outbox.count(), 1, "rejected packet evidence must stay in SQLite");
  assert.equal(collector.outbox.pendingCount(), 0, "rejected packet must leave the retry queue");
  assert.equal(collector.outbox.rejectedCount(), 1);
  assert.equal(collector.getStatus().rejectedPackets, 1);
  assert.equal(collector.outbox.recoveryCount(collector.outbox.sequence), 0,
    "rejected evidence must not block recovery completion");
  const orphanSends = sockets[1].sent.filter((item) => item.packetId === orphan.packetId).length;
  collector.flushOutbox();
  assert.equal(sockets[1].sent.filter((item) => item.packetId === orphan.packetId).length, orphanSends,
    "orphaned ACK must not schedule another send");

  const reopenedRejected = new CollectorOutbox(path.join(temporaryDir, "cache.sqlite"));
  assert.equal(reopenedRejected.count(), 1);
  assert.equal(reopenedRejected.pendingCount(), 0, "rejected state must survive a process restart");
  assert.equal(reopenedRejected.db.prepare("SELECT reason FROM rejected_packets WHERE packet_id = ?")
    .get(orphan.packetId)?.reason, "event_time_mismatch");
  reopenedRejected.close();

  sockets[1].close();
  collector.connect();
  sockets[2].open();
  assert.equal(sockets[2].sent.filter((item) => item.packetId === orphan.packetId).length, 0,
    "reconnect must not replay a definitively rejected packet");
  const healthy = collector.outbox.cache("event-1", Date.now(), packet(1800));
  assert.equal(collector.sendDurable(healthy, false), true);
  sockets[2].receive({ type: "live_packet_ack", packetId: healthy.packetId, status: "persisted", sampled: true });
  assert.equal(collector.outbox.count(), 1, "successful ACK must delete only the processed packet");
  assert.equal(collector.outbox.pendingCount(), 0);

  sockets[2].bufferedAmount = 300_000;
  collector.backpressureSince = Date.now() - 6000;
  collector.flushOutbox();
  assert.equal(sockets[2].readyState, 3, "stalled network backpressure must trigger a reconnect");
  console.log("Native collector serial framing, live, SQLite ACK, explicit replay, and durable orphan quarantine passed.");
} finally {
  collector.stop();
  rmSync(temporaryDir, { recursive: true, force: true });
}
