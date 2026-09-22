import process from "node:process";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function clampChannel(value) {
  return Math.max(172, Math.min(1811, Math.round(value)));
}

function makeReceiverItem(receiverId, now, startedAt) {
  const elapsedSeconds = (now - startedAt) / 1000;
  const cycle = (elapsedSeconds + receiverId * 3.1) % 32;
  const flying = cycle >= 4 && cycle < 20;
  const turtle = cycle >= 24 && cycle < 27;
  const armed = flying || (cycle >= 20 && cycle < 24) || turtle;
  const phase = elapsedSeconds * (1.15 + receiverId * 0.035) + receiverId * 0.7;
  const roll = 992 + Math.sin(phase) * (flying ? 560 : 35);
  const pitch = 992 + Math.cos(phase * 0.83) * (flying ? 520 : 30);
  const yaw = 992 + Math.sin(phase * 0.51) * (flying ? 430 : 25);
  const throttle = flying
    ? 820 + (Math.sin(phase * 1.73) + 1) * 330
    : turtle ? 172 : armed ? 300 : 172;
  return {
    rx: receiverId,
    ch: [
      clampChannel(roll),
      clampChannel(pitch),
      clampChannel(throttle),
      clampChannel(yaw),
      armed ? 1792 : 172,
      flying && receiverId % 2 === 0 ? 1792 : 992,
      turtle ? 1792 : 172,
      172,
    ],
    lq: Math.max(85, Math.min(100, Math.round(96 + Math.sin(phase * 0.19) * 3))),
    rssi: Math.round(-48 - receiverId * 0.8 - Math.abs(Math.sin(phase * 0.23)) * 5),
    t: now,
  };
}

function makePacket(receiverCount, now, startedAt) {
  return {
    type: "rx_batch",
    v: 1,
    t: now,
    Vin_mV: 5000,
    A_mA: 240 + receiverCount * 42,
    items: Array.from({ length: receiverCount }, (_, index) => makeReceiverItem(index + 1, now, startedAt)),
  };
}

const receiverCount = Math.max(1, Math.min(16, Number(argument("receivers", "8")) || 8));
const rateHz = Math.max(1, Math.min(60, Number(argument("rate", "30")) || 30));
const countLimit = Math.max(0, Number(argument("count", "0")) || 0);
const stdoutMode = hasFlag("stdout");
const relayUrl = String(argument("relay", "wss://app.1.gzfpv.cn/live-ws"));
const intervalMs = Math.max(1, Math.round(1000 / rateHz));
const startedAt = Date.now();
let sent = 0;
let timer = null;
let socket = null;
let stopping = false;

function stop(exitCode = 0) {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  socket?.close();
  process.exitCode = exitCode;
}

function emitPacket() {
  const now = Date.now();
  const packet = makePacket(receiverCount, now, startedAt);
  if (stdoutMode) {
    process.stdout.write(`${JSON.stringify(packet)}\n`);
  } else if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "serial_packet",
      room: "default",
      packet,
      clientTime: now,
      source: "virtual_receiver",
    }));
  } else {
    return;
  }
  sent += 1;
  if (countLimit && sent >= countLimit) stop(0);
}

function startPackets() {
  emitPacket();
  if (!countLimit || sent < countLimit) timer = setInterval(emitPacket, intervalMs);
}

if (stdoutMode) {
  startPackets();
} else {
  socket = new WebSocket(relayUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "publish_live", room: "default" }));
    console.error(`[virtual-array] 已连接训练系统：${relayUrl}`);
    console.error(`[virtual-array] ${receiverCount} 个接收机 / ${rateHz} Hz / 与真实阵列相同的数据协议`);
    startPackets();
  });
  socket.addEventListener("error", () => {
    console.error(`[virtual-array] 无法连接训练系统：${relayUrl}`);
  });
  socket.addEventListener("close", () => {
    if (stopping) return;
    console.error("[virtual-array] 训练系统连接已断开，请先启动项目服务后重试。");
    stop(1);
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
