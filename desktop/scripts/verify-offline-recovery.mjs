import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeTrainingCollector } from "../collector.mjs";

class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  deferClose = false;
  sent = [];

  send(text) {
    assert.equal(this.readyState, WebSocket.OPEN);
    this.sent.push(JSON.parse(text));
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    if (!this.deferClose) this.finishClose();
  }

  finishClose() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function packet(sourceTime) {
  return {
    type: "rx_batch", t: sourceTime,
    items: [{ rx: 1, ch: [992, 992, 500, 992, 1811, 992, 992, 992] }],
  };
}

const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "fpv-offline-recovery-"));
const realNow = Date.now;
let now = realNow();
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
    ? [] : [{ id: "event-1", active: true, participants: [] }] }),
});

try {
  Date.now = () => now;
  collector.start();
  await collector.refreshEventId();
  sockets[0].open();
  sockets[0].deferClose = true;

  const captureTimes = new Map();
  for (let index = 0; index < 64; index += 1) {
    now += 230;
    collector.acceptFrame(packet(index * 230), now);
    collector.flushOutbox();
    captureTimes.set(`${collector.outbox.sessionId}:${index + 1}`, now);
  }
  const oldOnline = sockets[0].sent.filter((message) => message.packetId);
  assert.equal(oldOnline.length, 3, "a silent OPEN socket must hold at most three online durable frames");
  assert.ok(oldOnline.every((message) => !message.backfill));
  assert.equal(sockets[0].readyState, WebSocket.CLOSING,
    "an unacknowledged online frame must force reconnection within the ACK deadline");
  assert.equal(collector.socket, null, "reconnection cannot wait for the old socket close event");
  assert.equal(collector.outbox.pendingCount(), 64, "all unacknowledged frames must remain on disk");

  collector.connect();
  sockets[1].open();
  sockets[0].finishClose();
  assert.equal(collector.socket, sockets[1], "late close from the old socket cannot drop the new connection");
  assert.ok(sockets[1].sent.some((message) => message.backfill === true));
  assert.equal(collector.onlineInFlight.size, 0);

  now += 230;
  collector.acceptFrame(packet(64 * 230), now);
  const fresh = sockets[1].sent.find((message) => message.packetId && !message.backfill);
  assert.ok(fresh, "current reliable data must be sent while old history drains");
  assert.ok(sockets[1].sent.some((message) => message.source === "native_collector"),
    "current live frames must resume immediately");
  sockets[1].receive({ type: "live_packet_ack", packetId: fresh.packetId, status: "persisted", sampled: true });

  const acknowledged = new Set();
  while (acknowledged.size < captureTimes.size) {
    const next = sockets[1].sent.filter((message) => message.backfill && !acknowledged.has(message.packetId));
    assert.ok(next.length, "recovery pump must continue until every old packet is ACKed");
    for (const message of next) {
      assert.equal(message.clientTime, captureTimes.get(message.packetId),
        "replayed packets must retain their original capture time");
      acknowledged.add(message.packetId);
      sockets[1].receive({ type: "live_packet_ack", packetId: message.packetId, status: "persisted", sampled: true });
    }
  }
  assert.equal(collector.outbox.pendingCount(), 0);
  assert.ok(sockets[1].sent.some((message) => message.type === "live_backfill_complete"));

  now += 230;
  collector.acceptFrame(packet(65 * 230), now);
  const duringRebuild = sockets[1].sent.find((message) => message.packetId
    && message.clientTime === now && !message.backfill);
  assert.ok(duringRebuild);
  now += 8000;
  collector.flushOutbox();
  assert.equal(collector.socket, sockets[1], "server rebuild must not trigger a false reconnect");
  assert.equal(sockets[1].sent.filter((message) => message.packetId === duringRebuild.packetId).length, 1,
    "an online packet must not be replayed while the server rebuilds");
  assert.equal(collector.outbox.pendingCount(), 1);
  sockets[1].receive({ type: "live_packet_ack", packetId: duringRebuild.packetId, status: "persisted", sampled: true });
  assert.equal(collector.outbox.pendingCount(), 0);

  const before = sockets[1].sent.length;
  for (let index = 0; index < 4; index += 1) {
    now += 230;
    collector.acceptFrame(packet((66 + index) * 230), now);
  }
  const online = sockets[1].sent.slice(before).filter((message) => message.packetId);
  assert.equal(online.length, 3, "normal ACK delay must bound online outstanding frames");
  sockets[1].receive({ type: "live_packet_ack", packetId: online[0].packetId, status: "persisted", sampled: true });
  const resumed = sockets[1].sent.slice(before).filter((message) => message.packetId);
  assert.equal(resumed.length, 4, "an ACK must immediately send the oldest waiting current frame");
  for (const message of resumed.slice(1)) {
    sockets[1].receive({ type: "live_packet_ack", packetId: message.packetId, status: "persisted", sampled: true });
  }
  assert.equal(collector.outbox.pendingCount(), 0);

  const steadyStart = sockets[1].sent.length;
  const steadyAcked = new Set();
  for (let index = 0; index < 100; index += 1) {
    now += 230;
    collector.acceptFrame(packet((70 + index) * 230), now);
    for (const message of sockets[1].sent.slice(steadyStart)) {
      if (!message.packetId || steadyAcked.has(message.packetId) || message.clientTime > now - 500) continue;
      steadyAcked.add(message.packetId);
      sockets[1].receive({ type: "live_packet_ack", packetId: message.packetId, status: "persisted", sampled: true });
    }
    collector.flushOutbox();
  }
  now += 600;
  for (const message of sockets[1].sent.slice(steadyStart)) {
    if (!message.packetId || steadyAcked.has(message.packetId)) continue;
    steadyAcked.add(message.packetId);
    sockets[1].receive({ type: "live_packet_ack", packetId: message.packetId, status: "persisted", sampled: true });
  }
  assert.equal(steadyAcked.size, 100, "500 ms ACK latency must sustain the reliable frame rate");
  assert.equal(sockets[1].sent.slice(steadyStart).filter((message) => message.backfill).length, 0,
    "healthy delayed ACKs must not trigger historical recovery");
  assert.equal(collector.outbox.pendingCount(), 0);
  console.log("Silent OPEN socket recovery, bounded online sends, current priority, and original-time replay passed.");
} finally {
  Date.now = realNow;
  collector.stop();
  rmSync(temporaryDir, { recursive: true, force: true });
}
