import assert from "node:assert/strict";

const realNow = Date.now;
let now = 100_000;
Date.now = () => now;

const pendingCommands = new Map();
const postedFrames = [];
let onWorkerMessage;
globalThis.self = {
  addEventListener(type, handler) {
    if (type === "message") onWorkerMessage = handler;
  },
  postMessage(message) {
    if (message.type === "response") {
      const pending = pendingCommands.get(message.requestId);
      pendingCommands.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else pending.reject(new Error(message.error));
    } else postedFrames.push(message);
  },
};

const reads = [];
let waitingRead = null;
const reader = {
  read() {
    if (reads.length) return Promise.resolve(reads.shift());
    return new Promise((resolve) => { waitingRead = resolve; });
  },
  cancel() {
    waitingRead?.({ done: true });
    waitingRead = null;
    return Promise.resolve();
  },
  releaseLock() {},
};
const port = {
  getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
  open: async () => {},
  close: async () => {},
  readable: { getReader: () => reader },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { serial: { getPorts: async () => [port] } },
});

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}
globalThis.WebSocket = FakeWebSocket;

try {
  await import("../src/trainingSerial.worker.js");
  let nextRequestId = 0;
  function command(type, payload = {}) {
    const requestId = ++nextRequestId;
    return new Promise((resolve, reject) => {
      pendingCommands.set(requestId, { resolve, reject });
      onWorkerMessage({ data: { type, requestId, ...payload } });
    });
  }
  async function feed(t) {
    const packet = {
      type: "rx_batch", v: 1, t, role: "master", Vin_mV: 5000,
      items: [{ rx: 1, ch: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] }],
    };
    const result = { value: new TextEncoder().encode(JSON.stringify(packet)), done: false };
    if (waitingRead) {
      const resolve = waitingRead;
      waitingRead = null;
      resolve(result);
    } else reads.push(result);
    await new Promise((resolve) => setImmediate(resolve));
  }

  await command("open", { descriptor: { usbVendorId: 0x0483, usbProductId: 0x5740 } });
  await command("configure_live", { url: "ws://localhost/live-ws", room: "default" });
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  assert.deepEqual(socket.sent[0], { type: "publish_live", room: "default" });

  // The Window never consumes postedFrames. Live delivery must still happen.
  await feed(1000);
  assert.equal(postedFrames.filter((message) => message.type === "serial_frames").length, 1);
  assert.equal(socket.sent.filter((message) => message.type === "live_batch").length, 1);
  assert.equal(socket.sent[1].batch.role, undefined, "local serial telemetry must stay local");

  now += 5000;
  await feed(1033);
  assert.equal(socket.sent.filter((message) => message.type === "live_batch").length, 1,
    "buffered historical serial frames must not fast-play as current live data");

  now += 33;
  await feed(6066);
  assert.equal(socket.sent.filter((message) => message.type === "live_batch").length, 2,
    "current frames must resume on the Worker socket");

  socket.bufferedAmount = 256 * 1024 + 1;
  now += 33;
  await feed(6099);
  assert.equal(socket.sent.filter((message) => message.type === "live_batch").length, 2,
    "network backpressure must not queue ordinary live frames");

  await command("close");
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  console.log("Worker live transport verification passed");
} finally {
  Date.now = realNow;
}
