import { createSerialCaptureClock } from "./serialCaptureClock.js";
import { consumeSerialJsonStream } from "./serialJsonStream.js";

const SERIAL_PORT_BUFFER_SIZE = 8 * 1024 * 1024;
const LIVE_RECONNECT_MS = 2000;
const LIVE_MAX_BUFFERED_BYTES = 256 * 1024;
const LIVE_STALE_FRAME_MS = 3000;

let activePort = null;
let activeReader = null;
let keepReading = false;
let commandChain = Promise.resolve();
let liveSocket = null;
let liveSocketUrl = "";
let liveRoom = "default";
let liveReconnectTimer = null;

function clearLiveReconnect() {
  if (liveReconnectTimer !== null) clearTimeout(liveReconnectTimer);
  liveReconnectTimer = null;
}

function connectLiveSocket() {
  if (!liveSocketUrl || !keepReading || !activePort) return;
  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) return;
  clearLiveReconnect();
  const socket = new WebSocket(liveSocketUrl);
  liveSocket = socket;
  socket.addEventListener("open", () => {
    if (liveSocket !== socket || !keepReading) return;
    socket.send(JSON.stringify({ type: "publish_live", room: liveRoom }));
  });
  socket.addEventListener("close", () => {
    if (liveSocket !== socket) return;
    liveSocket = null;
    if (keepReading && activePort && liveSocketUrl) {
      liveReconnectTimer = setTimeout(connectLiveSocket, LIVE_RECONNECT_MS);
    }
  });
  socket.addEventListener("error", () => {
    // close schedules a bounded retry; serial reading must continue.
  });
}

function closeLiveSocket() {
  clearLiveReconnect();
  liveSocketUrl = "";
  const socket = liveSocket;
  liveSocket = null;
  socket?.close();
}

function compactLivePacket(packet) {
  const compactItem = (item) => {
    const result = { rx: Number(item?.rx), ch: Array.isArray(item?.ch) ? item.ch.slice(0, 8).map(Number) : [] };
    for (const [key, value] of [["lq", item?.lq ?? item?.linkQuality], ["rssi", item?.rssi], ["t", item?.t]]) {
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) result[key] = Number(value);
    }
    return result;
  };
  if (packet?.type === "rx_batch" && Array.isArray(packet.items)) {
    const result = {
      type: "rx_batch",
      v: Number(packet.v) || 1,
      items: packet.items.map(compactItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    if (Number.isFinite(Number(packet.t))) result.t = Number(packet.t);
    return result;
  }
  return compactItem(packet);
}

function publishWorkerLive(packet, capturedAt) {
  const socket = liveSocket;
  // Buffered serial bytes retain their original capture time and must never
  // fast-play as current sticks after the Worker itself resumes.
  if (Date.now() - capturedAt >= LIVE_STALE_FRAME_MS) return;
  if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) return;
  socket.send(JSON.stringify({
    type: "live_batch",
    room: liveRoom,
    batch: compactLivePacket(packet),
    clientTime: capturedAt,
    liveOnly: true,
  }));
}

function portDescriptor(port, ports) {
  const info = port?.getInfo?.() || {};
  const usbVendorId = Number(info.usbVendorId) || 0;
  const usbProductId = Number(info.usbProductId) || 0;
  const matching = ports.filter((candidate) => {
    const candidateInfo = candidate?.getInfo?.() || {};
    return (Number(candidateInfo.usbVendorId) || 0) === usbVendorId
      && (Number(candidateInfo.usbProductId) || 0) === usbProductId;
  });
  return {
    usbVendorId,
    usbProductId,
    ordinal: Math.max(0, matching.indexOf(port)),
    authorizedIndex: Math.max(0, ports.indexOf(port)),
  };
}

function findPort(ports, descriptor) {
  const exact = ports.find((port) => {
    const current = portDescriptor(port, ports);
    return current.usbVendorId === Number(descriptor?.usbVendorId || 0)
      && current.usbProductId === Number(descriptor?.usbProductId || 0)
      && current.ordinal === Number(descriptor?.ordinal || 0);
  });
  return exact || ports[Number(descriptor?.authorizedIndex)] || null;
}

function respond(requestId, result = {}, error = null) {
  self.postMessage({
    type: "response",
    requestId,
    ok: !error,
    ...(error ? { error: error.message || String(error), code: error.code || "serial_worker_error" } : result),
  });
}

async function closePort() {
  keepReading = false;
  closeLiveSocket();
  const reader = activeReader;
  const port = activePort;
  activeReader = null;
  activePort = null;
  try {
    await reader?.cancel();
  } catch {
    // A disconnected stream may already be cancelled.
  }
  try {
    reader?.releaseLock();
  } catch {
    // The read loop normally owns and releases the lock.
  }
  try {
    await port?.close();
  } catch {
    // The operating system may already have removed the port.
  }
}

async function readPort(port) {
  const decoder = new TextDecoder();
  const captureClock = createSerialCaptureClock();
  let jsonBuffer = "";

  // Web Serial creates a new readable stream after non-fatal overflow,
  // framing, and parity errors. Keep the port open and immediately acquire
  // that new stream; closing here makes recovery depend on throttled page
  // timers and turns one recoverable error into a long data outage.
  while (keepReading && activePort === port && port.readable) {
    const reader = port.readable.getReader();
    activeReader = reader;
    try {
      while (keepReading && activePort === port) {
        const { value, done } = await reader.read();
        if (done) break;
        const consumed = consumeSerialJsonStream(jsonBuffer, decoder.decode(value, { stream: true }));
        jsonBuffer = consumed.buffer;
        const frames = consumed.frames.map(({ packet, line }) => ({
          packet,
          line,
          capturedAt: captureClock.capture(packet, Date.now()),
        }));
        for (const frame of frames) publishWorkerLive(frame.packet, frame.capturedAt);
        if (frames.length || consumed.failures.length) {
          self.postMessage({
            type: "serial_frames",
            frames,
            failures: consumed.failures.slice(-1),
          });
        }
      }
    } catch (error) {
      if (keepReading && activePort === port) {
        self.postMessage({ type: "serial_read_warning", error: error.message || "串口读取异常，正在继续" });
        jsonBuffer = "";
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A close command may already have released it.
      }
      if (activeReader === reader) activeReader = null;
    }
  }

  if (keepReading && activePort === port) {
    keepReading = false;
    closeLiveSocket();
    self.postMessage({ type: "serial_disconnected", error: "串口已断开，正在自动重连" });
  }
}

async function openPort(descriptor) {
  if (!navigator.serial) {
    const error = new Error("当前浏览器的 Worker 不支持 Web Serial");
    error.code = "worker_serial_unsupported";
    throw error;
  }
  await closePort();
  const ports = await navigator.serial.getPorts();
  const port = findPort(ports, descriptor);
  if (!port) throw new Error("Worker 找不到已授权的接收阵列串口");
  await port.open({ baudRate: 115200, bufferSize: SERIAL_PORT_BUFFER_SIZE });
  activePort = port;
  keepReading = true;
  void readPort(port);
  return { descriptor: portDescriptor(port, ports) };
}

async function writePort(text) {
  if (!activePort?.writable) throw new Error("串口未连接");
  const writer = activePort.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(String(text || "")));
  } finally {
    writer.releaseLock();
  }
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  commandChain = commandChain.catch(() => undefined).then(async () => {
    if (message.type === "open") {
      const result = await openPort(message.descriptor);
      respond(message.requestId, result);
      return;
    }
    if (message.type === "configure_live") {
      liveSocketUrl = String(message.url || "");
      liveRoom = String(message.room || "default");
      connectLiveSocket();
      respond(message.requestId, { configured: true });
      return;
    }
    if (message.type === "close") {
      await closePort();
      respond(message.requestId, { closed: true });
      return;
    }
    if (message.type === "write") {
      await writePort(message.text);
      respond(message.requestId, { written: true });
    }
  }).catch((error) => respond(message.requestId, {}, error));
});
