import { useCallback, useEffect, useRef, useState } from "react";
import PilotLibraryPage from "./pages/PilotLibraryPage.jsx";
import EventPage from "./pages/EventPage.jsx";
import MonitorPage from "./pages/MonitorPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import { apiGet, apiPost, buttonStyle, defaultChannelConfig, panelStyle, primaryButtonStyle } from "./trainingShared.js";

function makePilot(index) {
  return {
    id: `pilot-${Date.now()}-${index}`,
    name: `新飞手 ${index}`,
    rates: "BF: 600/600/500",
    note: "",
    channelConfig: JSON.parse(JSON.stringify(defaultChannelConfig)),
  };
}

function crsfToPwm(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(((number - 172) * 1000) / (1811 - 172) + 1000);
}

function parseSerialPacket(packet, receivedAt = Date.now()) {
  const frameTime = Number(packet.t) || null;
  const items = packet.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
  const samples = [];

  for (const item of items) {
    const receiverId = Number(item.rx);
    const channels = Array.isArray(item.ch) ? item.ch : [];
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

function readSerialPower(packet, receivedAt = Date.now()) {
  const voltageV = Number(packet?.Vin_mV) / 1000;
  const currentA = Number(packet?.A_mA) / 1000;
  if (!Number.isFinite(voltageV) && !Number.isFinite(currentA)) return null;
  const safeVoltageV = Number.isFinite(voltageV) ? voltageV : null;
  const safeCurrentA = Number.isFinite(currentA) ? currentA : null;
  return {
    voltageV: safeVoltageV,
    currentA: safeCurrentA,
    powerW: safeVoltageV !== null && safeCurrentA !== null ? safeVoltageV * safeCurrentA : null,
    updatedAt: receivedAt,
  };
}

function compactSerialItem(item) {
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

function stripLocalSerialTelemetry(packet) {
  if (!packet || typeof packet !== "object") return packet;
  if (packet.type === "rx_batch" && Array.isArray(packet.items)) {
    const compact = {
      type: "rx_batch",
      v: Number(packet.v) || 1,
      items: packet.items.map(compactSerialItem).filter((item) => Number.isFinite(item.rx) && item.ch.length >= 8),
    };
    const time = Number(packet.t);
    if (Number.isFinite(time)) compact.t = time;
    return compact;
  }
  return compactSerialItem(packet);
}

function parseSerialLine(line) {
  const candidates = [line];
  const firstBrace = line.indexOf("{");
  const lastBrace = line.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(line.slice(firstBrace, lastBrace + 1));
  }

  const rxIndex = line.indexOf('"rx"');
  if (rxIndex >= 0) {
    const tail = line.slice(rxIndex).replace(/^[,{]+/, "");
    const body = tail.endsWith("}") ? tail : `${tail}}`;
    candidates.push(`{${body}`);
  }

  for (const candidate of candidates) {
    try {
      return { packet: JSON.parse(candidate), line: candidate };
    } catch {
      // Try the next recovery candidate.
    }
  }
  return null;
}

const LIVE_ROOM_ID = "default";
const RECEIVER_ONLINE_WINDOW_MS = 900;
const TRAINING_HUB_VENDOR_ID = 0x0483;
const TRAINING_HUB_PRODUCT_ID = 0x5740;

function getLiveSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/live-ws`;
}

function isTrainingHubPort(port) {
  const info = port?.getInfo?.() || {};
  return info.usbVendorId === TRAINING_HUB_VENDOR_ID && info.usbProductId === TRAINING_HUB_PRODUCT_ID;
}

function formatSerialPortName(port) {
  const info = port?.getInfo?.() || {};
  if (info.usbVendorId || info.usbProductId) {
    const vendorId = Number(info.usbVendorId || 0).toString(16).padStart(4, "0");
    const productId = Number(info.usbProductId || 0).toString(16).padStart(4, "0");
    const label = isTrainingHubPort(port) ? "TRAINING_HUB" : "USB";
    return `${label} ${vendorId}:${productId}`;
  }
  return "Selected serial port";
}

function sameEvents(left = [], right = []) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a?.id !== b?.id ||
      a?.name !== b?.name ||
      a?.startedAt !== b?.startedAt ||
      a?.endedAt !== b?.endedAt ||
      Boolean(a?.active) !== Boolean(b?.active) ||
      JSON.stringify(a?.participants || []) !== JSON.stringify(b?.participants || [])
    ) {
      return false;
    }
  }
  return true;
}

export default function TrainingSystem({ onBack, onOpenBracket, audience = false, initialTab = "pilots" }) {
  const [tab, setTab] = useState(initialTab);
  const [pilots, setPilots] = useState([]);
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState({ receivers: [], samples: [] });
  const [status, setStatus] = useState("正在读取数据...");
  const [statusLog, setStatusLog] = useState([{ time: Date.now(), message: "正在读取数据..." }]);
  const [, setServerConnected] = useState(false);
  const portRef = useRef(null);
  const readerRef = useRef(null);
  const serialLoopRef = useRef(false);
  const serialConnectInFlightRef = useRef(false);
  const manualSerialDisconnectRef = useRef(false);
  const serialReconnectTimerRef = useRef(0);
  const serialLatestRef = useRef({});
  const serialRenderFrameRef = useRef(0);
  const serialInputFpsRef = useRef({ count: 0, startedAt: 0 });
  const liveSocketRef = useRef(null);
  const liveRelayRef = useRef({ lastSentAt: 0, lastUiAt: 0, minIntervalMs: 30 });
  const serialStateRef = useRef(null);
  const serialStateUiRef = useRef({ lastAt: 0, receiverCount: 0, maxReceiverId: 0, connected: false });
  const [serialRenderTick, setSerialRenderTick] = useState(0);
  const [serialInputFps, setSerialInputFps] = useState(0);
  const [liveStateSeed, setLiveStateSeed] = useState(null);
  const [liveRelayState, setLiveRelayState] = useState({
    connected: false,
    mode: audience ? "subscriber" : "publisher",
    minIntervalMs: 30,
    lastAt: null,
    error: "",
    power: null,
  });
  const [serialState, setSerialState] = useState({
    supported: typeof navigator !== "undefined" && Boolean(navigator.serial),
    connected: false,
    connecting: false,
    baudRate: 115200,
    portName: "",
    receiverCount: 0,
    maxReceiverId: 0,
    packetCount: 0,
    lastDataAt: null,
    lastReceiverId: null,
    lastLine: "",
    error: "",
  });

  useEffect(() => {
    serialStateRef.current = serialState;
  }, [serialState]);

  function pushStatus(message) {
    setStatus(message);
    setStatusLog((current) => [{ time: Date.now(), message }, ...current].slice(0, 80));
  }

  const requestSerialRender = useCallback(() => {
    if (serialRenderFrameRef.current) return;
    serialRenderFrameRef.current = window.requestAnimationFrame(() => {
      serialRenderFrameRef.current = 0;
      setSerialRenderTick(Date.now());
    });
  }, []);

  function recordSerialInputFrame(receivedAt = Date.now()) {
    const stats = serialInputFpsRef.current;
    if (!stats.startedAt) {
      serialInputFpsRef.current = { count: 1, startedAt: receivedAt };
      return;
    }
    stats.count += 1;
    const elapsed = receivedAt - stats.startedAt;
    if (elapsed >= 1000) {
      setSerialInputFps((stats.count * 1000) / elapsed);
      serialInputFpsRef.current = { count: 0, startedAt: receivedAt };
    }
  }

  const pruneStaleSerialSamples = useCallback((now = Date.now()) => {
    let changed = false;
    const latest = {};
    for (const [receiverId, sample] of Object.entries(serialLatestRef.current)) {
      if (now - Number(sample?.time || 0) < RECEIVER_ONLINE_WINDOW_MS) {
        latest[receiverId] = sample;
      } else {
        changed = true;
      }
    }
    if (!changed) return;
    serialLatestRef.current = latest;
    requestSerialRender();
  }, [requestSerialRender]);

  useEffect(() => () => {
    if (serialRenderFrameRef.current) window.cancelAnimationFrame(serialRenderFrameRef.current);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const lastDataAt = Number(serialStateRef.current?.lastDataAt || 0);
      pruneStaleSerialSamples();
      if (!lastDataAt || Date.now() - lastDataAt > 1500) {
        setSerialInputFps(0);
        serialInputFpsRef.current = { count: 0, startedAt: 0 };
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [pruneStaleSerialSamples]);

  useEffect(() => {
    let stopped = false;
    async function loadAll() {
      try {
        const [nextPilots, nextEvents, nextLive] = await Promise.all([
          apiGet("/api/pilots", []),
          apiGet("/api/events", []),
          apiGet("/api/training-live", { receivers: [], samples: [] }),
        ]);
        if (stopped) return;
        setPilots(nextPilots.length ? nextPilots : [makePilot(1), makePilot(2)]);
        setEvents(nextEvents);
        setLive(nextLive);
        setServerConnected(true);
        pushStatus("数据已读取");
      } catch (error) {
        if (stopped) return;
        setServerConnected(false);
        pushStatus(`服务器连接失败：${error.message}`);
      }
    }
    loadAll();
    return () => {
      stopped = true;
    };
  }, []);

  function clearSerialConnection(error = "") {
    serialLoopRef.current = false;
    portRef.current = null;
    readerRef.current = null;
    serialLatestRef.current = {};
    requestSerialRender();
    setSerialState((current) => ({
      ...current,
      connected: false,
      connecting: false,
      portName: "",
      receiverCount: 0,
      maxReceiverId: 0,
      lastDataAt: null,
      lastReceiverId: null,
      lastLine: "",
      error,
      power: null,
    }));
    if (error) pushStatus(error);
  }

  async function releaseSerialResources({ clear = true, error = "" } = {}) {
    serialLoopRef.current = false;
    const reader = readerRef.current;
    const port = portRef.current;
    readerRef.current = null;
    portRef.current = null;

    try {
      await reader?.cancel();
    } catch {
      // reader may already be closed
    }
    try {
      reader?.releaseLock();
    } catch {
      // lock may already be released
    }
    try {
      await port?.close();
    } catch {
      // port may already be closed or disconnected
    }

    if (clear) clearSerialConnection(error);
  }

  async function openSerialPort(port, { requested = false } = {}) {
    if (!port || audience) return false;
    if (portRef.current === port && serialStateRef.current?.connected) return true;
    if (serialConnectInFlightRef.current) return false;

    serialConnectInFlightRef.current = true;
    setSerialState((current) => ({
      ...current,
      supported: true,
      connecting: true,
      error: "",
    }));

    try {
      if (portRef.current && portRef.current !== port) {
        await releaseSerialResources({ clear: false });
      }
      await port.open({ baudRate: 115200 });
      manualSerialDisconnectRef.current = false;
      portRef.current = port;
      serialLatestRef.current = {};
      requestSerialRender();
      setSerialState((current) => ({
        ...current,
        supported: true,
        connected: true,
        connecting: false,
        baudRate: 115200,
        portName: formatSerialPortName(port),
        packetCount: 0,
        receiverCount: 0,
        maxReceiverId: 0,
        lastDataAt: null,
        lastReceiverId: null,
        lastLine: "",
        error: "",
      }));
      pushStatus(requested ? "Serial connected" : "Serial auto-connected");
      void readSerialLoop(port);
      return true;
    } catch (error) {
      if (portRef.current === port) portRef.current = null;
      setSerialState((current) => ({
        ...current,
        connected: false,
        connecting: false,
        error: `Serial open failed: ${error.message}`,
      }));
      if (requested) pushStatus(`Serial open failed: ${error.message}`);
      return false;
    } finally {
      serialConnectInFlightRef.current = false;
    }
  }

  async function autoConnectSerialArray() {
    if (audience || !navigator.serial || manualSerialDisconnectRef.current || portRef.current) return;
    try {
      const ports = await navigator.serial.getPorts();
      const port = ports.find(isTrainingHubPort);
      if (port) await openSerialPort(port);
    } catch (error) {
      setSerialState((current) => ({ ...current, error: `Serial auto-connect failed: ${error.message}` }));
    }
  }

  async function savePilots(nextPilots) {
    setPilots(nextPilots);
    try {
      await apiPost("/api/pilots", nextPilots);
      pushStatus("飞手库已保存");
    } catch (error) {
      pushStatus(`飞手库保存失败：${error.message}`);
      throw error;
    }
  }

  async function saveEvents(nextEvents) {
    setEvents(nextEvents);
    try {
      await apiPost("/api/events", nextEvents);
      publishTrainingState(nextEvents);
      pushStatus("训练事件已保存");
    } catch (error) {
      pushStatus(`训练事件保存失败：${error.message}`);
      throw error;
    }
  }

  async function saveLive(nextLive) {
    setLive(nextLive);
    try {
      await apiPost("/api/training-live", nextLive);
      pushStatus("接收机设置已保存");
    } catch (error) {
      pushStatus(`接收机设置保存失败：${error.message}`);
      throw error;
    }
  }

  void saveLive;

  const updateSerialFromPacket = useCallback((packet, line, receivedAt = Date.now()) => {
    const power = readSerialPower(packet, receivedAt);
    const updatedSamples = parseSerialPacket(packet, receivedAt);
    if (!updatedSamples.length) {
      if (power) setSerialState((current) => ({ ...current, power }));
      return [];
    }
    recordSerialInputFrame(receivedAt);

    const latest = { ...serialLatestRef.current };
    for (const sample of updatedSamples) {
      latest[sample.receiverId] = sample;
    }

    serialLatestRef.current = latest;
    requestSerialRender();
    const receiverIds = Object.keys(latest).map(Number);
    const lastSample = updatedSamples[updatedSamples.length - 1];
    const receiverCount = receiverIds.length;
    const maxReceiverId = Math.max(0, ...receiverIds);
    const shouldUpdateSerialUi =
      receivedAt - serialStateUiRef.current.lastAt >= 250 ||
      serialStateUiRef.current.receiverCount !== receiverCount ||
      serialStateUiRef.current.maxReceiverId !== maxReceiverId ||
      !serialStateUiRef.current.connected;
    if (shouldUpdateSerialUi) {
      serialStateUiRef.current = { lastAt: receivedAt, receiverCount, maxReceiverId, connected: true };
      setSerialState((current) => ({
        ...current,
        connected: true,
        receiverCount,
        maxReceiverId,
        packetCount: current.packetCount + 1,
        lastDataAt: receivedAt,
        lastReceiverId: lastSample.receiverId,
        lastLine: line,
        error: "",
        power: power || current.power || null,
      }));
    } else if (power) {
      setSerialState((current) => ({ ...current, power }));
    }
    return updatedSamples;
  }, [requestSerialRender]);

  const publishLivePacket = useCallback((packet) => {
    if (audience) return;
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== 1) return;

    const now = performance.now();
    const bufferedAmount = socket.bufferedAmount;
    const minIntervalMs = bufferedAmount > 512 * 1024 ? 250 : bufferedAmount > 128 * 1024 ? 100 : 30;
    liveRelayRef.current.minIntervalMs = minIntervalMs;
    if (now - liveRelayRef.current.lastSentAt < minIntervalMs) return;

    liveRelayRef.current.lastSentAt = now;
    socket.send(JSON.stringify({
      type: "live_batch",
      room: LIVE_ROOM_ID,
      batch: stripLocalSerialTelemetry(packet),
      clientTime: Date.now(),
    }));
    const wallNow = Date.now();
    if (wallNow - (liveRelayRef.current.lastUiAt || 0) >= 250) {
      liveRelayRef.current.lastUiAt = wallNow;
      setLiveRelayState((current) => ({
        ...current,
        minIntervalMs,
        lastAt: wallNow,
        error: "",
      }));
    }
  }, [audience]);

  const publishLiveState = useCallback((state) => {
    if (audience) return;
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 512 * 1024) return;
    socket.send(JSON.stringify({
      type: "live_state",
      room: LIVE_ROOM_ID,
      state,
      clientTime: Date.now(),
    }));
  }, [audience]);

  const publishTrainingState = useCallback((nextEvents, receiverState = serialStateRef.current) => {
    const activeEvent = nextEvents.find((event) => event.active) || null;
    const safeReceiverState = receiverState || {};
    publishLiveState({
      version: 2,
      updatedAt: Date.now(),
      event: activeEvent,
      events: nextEvents,
      receiverState: {
        connected: Boolean(safeReceiverState.connected),
        connecting: Boolean(safeReceiverState.connecting),
        supported: Boolean(safeReceiverState.supported),
        receiverCount: safeReceiverState.receiverCount || 0,
        maxReceiverId: safeReceiverState.maxReceiverId || 0,
        packetCount: safeReceiverState.packetCount || 0,
        lastDataAt: safeReceiverState.lastDataAt || null,
        lastReceiverId: safeReceiverState.lastReceiverId || null,
        portName: safeReceiverState.portName || "",
        error: safeReceiverState.error || "",
      },
      latestSamplesByReceiver: serialLatestRef.current,
    });
  }, [publishLiveState]);

  useEffect(() => {
    if (audience) return undefined;
    const timer = window.setInterval(() => {
      if (events.some((event) => event.active)) return;
      publishTrainingState(events);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [audience, events, publishTrainingState]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return undefined;
    let stopped = false;
    let reconnectTimer = null;

    function connectLiveSocket() {
      const socket = new WebSocket(getLiveSocketUrl());
      liveSocketRef.current = socket;

      socket.addEventListener("open", () => {
        if (stopped) return;
        const mode = audience ? "subscribe_live" : "publish_live";
        socket.send(JSON.stringify({ type: mode, room: LIVE_ROOM_ID }));
        setLiveRelayState((current) => ({
          ...current,
          connected: true,
          mode: audience ? "subscriber" : "publisher",
          error: "",
        }));
      });

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (audience && message.type === "live_batch" && message.batch) {
          const line = JSON.stringify(message.batch);
          updateSerialFromPacket(message.batch, line, message.serverTime || Date.now());
        }
        if (audience && message.type === "live_state" && message.state) {
          const latest = message.state.latestSamplesByReceiver || {};
          const now = Date.now();
          const hasRecentLiveBatch = now - Number(serialStateRef.current?.lastDataAt || 0) < 2000;
          if (!hasRecentLiveBatch || message.state.bandsByPilot || message.state.samplesByPilot) {
            setLiveStateSeed({ ...message.state, receivedAt: now });
          }
          if (!serialStateRef.current?.lastDataAt && Object.keys(latest).length) {
            serialLatestRef.current = latest;
            requestSerialRender();
          }
          if (Array.isArray(message.state.events)) {
            setEvents((current) => (sameEvents(current, message.state.events) ? current : message.state.events));
          } else if (message.state.event?.id) {
            setEvents((current) => {
              const liveEvent = { ...message.state.event, active: Boolean(message.state.event.active) };
              const next = current.map((eventItem) => (
                eventItem.id === liveEvent.id ? liveEvent : { ...eventItem, active: false }
              ));
              const merged = next.some((eventItem) => eventItem.id === liveEvent.id) ? next : [liveEvent, ...next];
              return sameEvents(current, merged) ? current : merged;
            });
          } else {
            setEvents((current) => {
              const next = current.map((eventItem) => ({ ...eventItem, active: false }));
              return sameEvents(current, next) ? current : next;
            });
          }
          const relayReceiverState = message.state.receiverState || {};
          if (Object.keys(relayReceiverState).length) {
            setSerialState((current) => ({
              ...current,
              ...relayReceiverState,
              connected: Boolean(relayReceiverState.connected),
              receiverCount: relayReceiverState.receiverCount || 0,
              maxReceiverId: relayReceiverState.maxReceiverId || 0,
              lastDataAt: Math.max(Number(current.lastDataAt || 0), Number(relayReceiverState.lastDataAt || 0)) || null,
              lastReceiverId: Number(relayReceiverState.lastDataAt || 0) >= Number(current.lastDataAt || 0)
                ? relayReceiverState.lastReceiverId || null
                : current.lastReceiverId,
              error: relayReceiverState.error || "",
            }));
          } else {
            const receiverIds = Object.keys(latest).map(Number);
            setSerialState((current) => ({
              ...current,
              connected: receiverIds.length > 0,
              receiverCount: receiverIds.length,
              maxReceiverId: Math.max(0, ...receiverIds),
              lastDataAt: message.serverTime || Date.now(),
              lastReceiverId: receiverIds[receiverIds.length - 1] || null,
              error: "",
            }));
          }
        }
        if (message.type === "live_batch" || message.type === "live_state" || message.type === "live_ack") {
          const now = Date.now();
          const shouldUpdateRelayUi = message.type === "live_ack" || now - (liveRelayRef.current.lastUiAt || 0) >= 250;
          if (shouldUpdateRelayUi) {
            liveRelayRef.current.lastUiAt = now;
            setLiveRelayState((current) => ({
              ...current,
              connected: true,
              lastAt: now,
              error: "",
            }));
          }
        }
      });

      socket.addEventListener("error", () => {
        pushStatus("实时中继连接异常");
        setLiveRelayState((current) => ({ ...current, error: "实时中继连接异常" }));
      });

      socket.addEventListener("close", () => {
        if (liveSocketRef.current === socket) liveSocketRef.current = null;
        setLiveRelayState((current) => ({ ...current, connected: false }));
        if (!stopped) reconnectTimer = window.setTimeout(connectLiveSocket, 2000);
      });
    }

    connectLiveSocket();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      liveSocketRef.current?.close();
      liveSocketRef.current = null;
    };
  }, [audience, requestSerialRender, updateSerialFromPacket]);

  useEffect(() => {
    if (audience || !navigator.serial) return undefined;
    let stopped = false;

    function scheduleAutoConnect(delayMs = 0) {
      if (stopped || manualSerialDisconnectRef.current) return;
      if (serialReconnectTimerRef.current) window.clearTimeout(serialReconnectTimerRef.current);
      serialReconnectTimerRef.current = window.setTimeout(() => {
        serialReconnectTimerRef.current = 0;
        if (!stopped) void autoConnectSerialArray();
      }, delayMs);
    }

    function handleSerialConnect(event) {
      if (manualSerialDisconnectRef.current) return;
      const port = event.target;
      if (isTrainingHubPort(port)) {
        void openSerialPort(port);
      } else {
        scheduleAutoConnect(300);
      }
    }

    function handleSerialDisconnect(event) {
      if (event.target !== portRef.current) return;
      void releaseSerialResources({ clear: true, error: "Serial disconnected" });
      scheduleAutoConnect(800);
    }

    function handlePageHide() {
      void releaseSerialResources({ clear: false });
    }

    navigator.serial.addEventListener("connect", handleSerialConnect);
    navigator.serial.addEventListener("disconnect", handleSerialDisconnect);
    window.addEventListener("pagehide", handlePageHide);
    scheduleAutoConnect(0);

    return () => {
      stopped = true;
      if (serialReconnectTimerRef.current) window.clearTimeout(serialReconnectTimerRef.current);
      navigator.serial.removeEventListener("connect", handleSerialConnect);
      navigator.serial.removeEventListener("disconnect", handleSerialDisconnect);
      window.removeEventListener("pagehide", handlePageHide);
      void releaseSerialResources({ clear: false });
    };
  // Serial listeners are registered once per page mode; helpers read current values from refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience]);

  async function readSerialLoop(port) {
    const decoder = new TextDecoder();
    let buffer = "";
    serialLoopRef.current = true;
    while (serialLoopRef.current && port.readable) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        while (serialLoopRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            const parsed = parseSerialLine(line);
            if (parsed) {
              updateSerialFromPacket(parsed.packet, parsed.line);
              publishLivePacket(parsed.packet);
            } else {
              pushStatus(`串口 JSON 解析失败：${line.slice(0, 80)}`);
              setSerialState((current) => ({ ...current, error: `串口 JSON 解析失败：${line.slice(0, 80)}` }));
            }
          }
        }
      } catch (error) {
        if (serialLoopRef.current) {
          clearSerialConnection(`串口读取失败，已断开：${error.message}`);
          return;
        }
      } finally {
        reader.releaseLock();
        if (readerRef.current === reader) readerRef.current = null;
      }
      if (!serialLoopRef.current) break;
    }
    if (portRef.current === port) clearSerialConnection("串口已断开");
  }

  async function connectSerialArray() {
    if (!navigator.serial) {
      pushStatus("当前浏览器不支持 Web Serial，请使用 Edge/Chrome 的 localhost 或 HTTPS 页面");
      setSerialState((current) => ({ ...current, supported: false, error: "当前浏览器不支持 Web Serial，请使用 Edge/Chrome 的 localhost 或 HTTPS 页面" }));
      return;
    }
    try {
      manualSerialDisconnectRef.current = false;
      const port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: TRAINING_HUB_VENDOR_ID, usbProductId: TRAINING_HUB_PRODUCT_ID }],
      });
      await openSerialPort(port, { requested: true });
    } catch (error) {
      pushStatus(`串口连接失败：${error.message}`);
      setSerialState((current) => ({ ...current, connected: false, connecting: false, error: `串口连接失败：${error.message}` }));
    }
  }

  async function disconnectSerialArray() {
    manualSerialDisconnectRef.current = true;
    if (serialReconnectTimerRef.current) window.clearTimeout(serialReconnectTimerRef.current);
    await releaseSerialResources({ clear: true });
    publishTrainingState(events, {
      ...serialStateRef.current,
      connected: false,
      connecting: false,
      receiverCount: 0,
      maxReceiverId: 0,
      lastDataAt: null,
      lastReceiverId: null,
      error: "",
    });
  }

  async function bindSerialReceiver(receiverId = 1) {
    if (!portRef.current?.writable) {
      throw new Error("串口未连接");
    }
    const writer = portRef.current.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(`BIND:${receiverId}\n`)).catch((error) => {
        setSerialState((current) => ({ ...current, error: `BIND:${receiverId} 写入状态异常：${error.message}` }));
      });
      setSerialState((current) => ({ ...current, error: "", lastCommand: `BIND:${receiverId}` }));
    } finally {
      writer.releaseLock();
    }
  }

  const tabs = [
    ["pilots", "飞手库"],
    ["events", "事件和系统"],
    ["monitor", "实时监测"],
    ["history", "历史记录"],
  ];

  function getDisplayLive() {
    const receiverCount = serialState.maxReceiverId || 0;
    const now = Date.now();
    const receivers = Array.from({ length: receiverCount }, (_, index) => {
      const id = index + 1;
      const serialSample = serialLatestRef.current[id];
      const serialOnline = Boolean(serialSample && now - serialSample.time < RECEIVER_ONLINE_WINDOW_MS);
      return {
        id,
        name: `接收机 ${id}`,
        online: serialOnline,
        paired: Boolean(serialOnline && (serialSample.lq > 0 || serialSample.rssi > -127)),
        lq: serialSample?.lq ?? null,
        rssi: serialSample?.rssi ?? null,
        binding: false,
        bindRequestedAt: null,
        lastSeenAt: serialSample?.time || null,
        source: "serial",
      };
    });
    return { ...live, receiverCount, receivers };
  }

  const displayLive = getDisplayLive();
  const receiverConnected = Boolean(serialState.connected);
  const latestLog = statusLog[0]?.message || status;

  function renderMainStatus() {
    const parts = [
      { label: `实时中继：${liveRelayState.connected ? "已连接" : "未连接"}`, ok: liveRelayState.connected },
      { label: `接收阵列：${receiverConnected ? "已连接" : "未连接"}`, ok: receiverConnected },
    ];
    return (
      <div style={{ fontSize: 13, marginTop: 6 }}>
        {parts.map((part, index) => (
          <span key={part.label} style={{ color: part.ok ? "#64748b" : "#b91c1c", fontWeight: part.ok ? 500 : 800 }}>
            {index > 0 && <span style={{ color: "#94a3b8", fontWeight: 500 }}> / </span>}
            {part.label}
          </span>
        ))}
      </div>
    );
  }

  const titleStyle = {
    margin: 0,
    fontSize: "clamp(28px, 7vw, 34px)",
    fontWeight: 950,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    color: "#0f172a",
    letterSpacing: 0,
    textAlign: "center",
  };
  const logoStyle = { width: "clamp(34px, 9vw, 42px)", height: "clamp(34px, 9vw, 42px)", objectFit: "contain", flex: "0 0 auto" };
  const headerStyle = {
    ...panelStyle,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 14,
    marginBottom: 16,
    flexWrap: "wrap",
  };
  const headerTitleBlockStyle = { flex: "1 1 100%", minWidth: 0, textAlign: "center" };
  const headerActionsStyle = { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", alignItems: "center", maxWidth: "100%" };

  function formatStatusLogTime(ms) {
    return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
  }

  function renderStatusLogBar() {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, maxWidth: "100%", flexWrap: "wrap" }}>
        <input
          readOnly
          value={latestLog}
          title={latestLog}
          style={{
            height: 36,
            borderRadius: 10,
            border: "1px solid #d4d4d8",
            padding: "0 10px",
            background: "#fff",
            color: latestLog.includes("失败") || latestLog.includes("异常") ? "#b91c1c" : "#334155",
            boxSizing: "border-box",
            width: 340,
            maxWidth: "min(340px, calc(100vw - 90px))",
          }}
        />
        <details style={{ position: "relative" }}>
          <summary style={{ ...buttonStyle, height: 36, display: "inline-flex", alignItems: "center", listStyle: "none" }}>
            日志
          </summary>
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 42,
              width: 420,
              maxHeight: 280,
              overflow: "auto",
              border: "1px solid #d4d4d8",
              borderRadius: 12,
              background: "#fff",
              boxShadow: "0 12px 28px rgba(15,23,42,.14)",
              padding: 10,
              zIndex: 20,
            }}
          >
            {statusLog.map((item) => (
              <div key={`${item.time}-${item.message}`} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 8, padding: "7px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                <span style={{ color: "#64748b" }}>{formatStatusLogTime(item.time)}</span>
                <span style={{ color: item.message.includes("失败") || item.message.includes("异常") ? "#b91c1c" : "#334155" }}>{item.message}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  if (audience) {
    return (
      <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", background: "#f5f7fb", padding: "clamp(10px, 4vw, 20px)", fontFamily: "'Microsoft YaHei','寰蒋闆呴粦',Arial,sans-serif", letterSpacing: 0, color: "#111827" }}>
        <header style={headerStyle}>
          <div style={headerTitleBlockStyle}>
            <h1 style={titleStyle}>
              <img src="/logo_single.png" alt="" style={logoStyle} />
              <span>训练状态监测</span>
            </h1>
            {renderMainStatus()}
          </div>
          <div style={headerActionsStyle}>
            <button type="button" style={buttonStyle} onClick={onBack}>返回首页</button>
          </div>
        </header>
        <MonitorPage pilots={pilots} events={events} latestSamplesRef={serialLatestRef} renderTick={serialRenderTick} inputFps={serialInputFps} stateSeed={liveStateSeed} />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", background: "#f5f7fb", padding: "clamp(10px, 4vw, 20px)", fontFamily: "'Microsoft YaHei','寰蒋闆呴粦',Arial,sans-serif", letterSpacing: 0, color: "#111827" }}>
      <header style={headerStyle}>
        <div style={headerTitleBlockStyle}>
          <h1 style={titleStyle}>
            <img src="/logo_single.png" alt="" style={logoStyle} />
            <span>训练系统</span>
          </h1>
          {renderMainStatus()}
          {renderStatusLogBar()}
        </div>
        <div style={headerActionsStyle}>
          {tabs.map(([key, label]) => (
            <button key={key} type="button" style={tab === key ? primaryButtonStyle : buttonStyle} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
          {onOpenBracket && <button type="button" style={buttonStyle} onClick={onOpenBracket}>双败淘汰赛</button>}
          <button type="button" style={buttonStyle} onClick={onBack}>返回首页</button>
        </div>
      </header>

      {tab === "pilots" && <PilotLibraryPage key={pilots.map((pilot) => `${pilot.id}:${pilot.updatedAt || ""}:${pilot.name}`).join("|")} pilots={pilots} onSave={savePilots} />}
      {tab === "events" && <EventPage pilots={pilots} events={events} live={displayLive} serialState={serialState} serialPower={serialState.power} onConnectSerial={connectSerialArray} onDisconnectSerial={disconnectSerialArray} onSaveEvents={saveEvents} onBindReceiver={async (id) => {
        try {
          if (serialState.connected) await bindSerialReceiver(id);
          try {
            const result = await apiPost(`/api/receivers/${id}/bind`, {});
            setLive({ ...live, receivers: result.receivers || (await apiGet("/api/training-live", live)).receivers });
          } catch {
            // Binding is driven by the serial command; server-side receiver state sync is optional.
          }
          pushStatus(`接收机 ${id} 已发送对频指令`);
        } catch (error) {
          pushStatus(`接收机 ${id} 对频失败：${error.message}`);
        }
      }} />}
      <div style={{ display: tab === "monitor" ? "block" : "none" }}>
        <MonitorPage pilots={pilots} events={events} latestSamplesRef={serialLatestRef} renderTick={serialRenderTick} inputFps={serialInputFps} />
      </div>
      {tab === "history" && <HistoryPage events={events} onDeleteEvent={async (eventId) => {
        setEvents((current) => {
          const nextEvents = current.filter((event) => event.id !== eventId);
          publishTrainingState(nextEvents);
          return nextEvents;
        });
        pushStatus("历史事件已删除");
      }} />}
    </div>
  );
}
