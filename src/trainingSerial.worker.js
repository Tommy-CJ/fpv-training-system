import { createSerialCaptureClock } from "./serialCaptureClock.js";
import { consumeSerialJsonStream } from "./serialJsonStream.js";

const SERIAL_PORT_BUFFER_SIZE = 8 * 1024 * 1024;

let activePort = null;
let activeReader = null;
let keepReading = false;
let commandChain = Promise.resolve();

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
