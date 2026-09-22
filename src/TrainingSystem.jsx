import { useCallback, useEffect, useRef, useState } from "react";
import SkillTreePage from "./pages/SkillTreePage.jsx";
import PilotLibraryPage from "./pages/PilotLibraryPage.jsx";
import EventPage from "./pages/EventPage.jsx";
import MonitorPage from "./pages/MonitorPage.jsx";
import CoachPage from "./pages/CoachPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import TrackManagementPage from "./pages/TrackManagementPage.jsx";
import { apiGet, apiPost, buttonStyle, defaultChannelConfig, isValueInRanges, panelStyle, primaryButtonStyle } from "./trainingShared.js";
import {
  cacheLivePacket,
  deleteCachedLivePacket,
  deleteCachedLivePacketsByEventId,
  listCachedLivePackets,
} from "./liveOutbox.js";
import {
  buildPersistenceSerialSnapshot,
  isHistoricalRecoveryRecord,
  outboxAckRetryDelay,
  shouldDeleteOutboxPacketForAck,
  shouldDiscardOrphanedOutboxPacket,
  shouldSendCurrentPersistence,
} from "./livePersistence.js";
import { consumeSerialJsonStream } from "./serialJsonStream.js";
import {
  claimTrainingSerialPort,
  findPreferredTrainingSerialPort,
  isBetaflightSerialPortClaimed,
  releaseTrainingSerialPortClaim,
  rememberTrainingSerialPort,
} from "./serialPortClaim.js";

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

function isValidCrsfChannel(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 172 && number <= 1811;
}

function parseSerialPacket(packet, receivedAt = Date.now()) {
  const frameTime = Number(packet.t) || null;
  const items = packet.type === "rx_batch" && Array.isArray(packet.items) ? packet.items : [packet];
  const samples = [];

  for (const item of items) {
    const receiverId = Number(item.rx);
    const channels = Array.isArray(item.ch) ? item.ch : [];
    if (!Number.isFinite(receiverId) || receiverId < 1 || channels.length < 8) continue;

    const rawChannels = channels.slice(0, 8).map(Number);
    if (rawChannels.some((value) => !isValidCrsfChannel(value))) continue;

    const pwmChannels = rawChannels.map(crsfToPwm);
    if (pwmChannels.some((value) => value === null)) continue;

    const linkQuality = Number(item.lq ?? item.linkQuality ?? 0);
    const rssi = Number(item.rssi ?? -127);
    samples.push({
      time: receivedAt,
      sourceTime: Number(item.t) || frameTime,
      receiverId,
      rawChannels,
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

function appendLiveBand(bands, band) {
  const start = Number(band?.start);
  const end = Number(band?.end);
  const state = band?.state;
  if (!state || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const previous = bands[bands.length - 1];
  if (previous && previous.state === state && start - previous.end <= 1000) {
    previous.end = Math.max(previous.end, end);
    return;
  }
  bands.push({ ...band, start, end });
}

function mergeLiveBandUpdates(existingBands = [], updates = []) {
  const sortedUpdates = updates
    .filter((band) => Number(band?.end) > Number(band?.start))
    .sort((left, right) => Number(left.start) - Number(right.start));
  if (!sortedUpdates.length) return existingBands;
  const replaceFrom = Number(sortedUpdates[0].start);
  const merged = [];
  for (const band of existingBands) {
    const start = Number(band?.start);
    const end = Number(band?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= replaceFrom) appendLiveBand(merged, band);
    else if (start < replaceFrom) appendLiveBand(merged, { ...band, end: replaceFrom });
  }
  for (const band of sortedUpdates) appendLiveBand(merged, band);
  return merged;
}

function mergeLiveBandMaps(existingByPilot = {}, updatesByPilot = {}) {
  const merged = { ...existingByPilot };
  for (const [pilotId, updates] of Object.entries(updatesByPilot || {})) {
    if (!updates?.length) continue;
    merged[pilotId] = mergeLiveBandUpdates(merged[pilotId] || [], updates);
  }
  return merged;
}

function replaceLiveBandRange(existingBands = [], updates = [], replaceFrom, replaceTo) {
  const from = Number(replaceFrom);
  const to = Number(replaceTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return existingBands;
  const pieces = [];
  for (const band of existingBands || []) {
    const start = Number(band?.start);
    const end = Number(band?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= from || start >= to) {
      pieces.push({ ...band, start, end });
      continue;
    }
    if (start < from) pieces.push({ ...band, start, end: from });
    if (end > to) pieces.push({ ...band, start: to, end });
  }
  for (const band of updates || []) {
    const start = Math.max(from, Number(band?.start));
    const end = Math.min(to, Number(band?.end));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) pieces.push({ ...band, start, end });
  }
  const merged = [];
  for (const band of pieces.sort((left, right) => left.start - right.start)) appendLiveBand(merged, band);
  return merged;
}

function replaceLiveBandMapRange(existingByPilot = {}, updatesByPilot = {}, replaceFrom, replaceTo) {
  const merged = { ...existingByPilot };
  const pilotIds = new Set([...Object.keys(existingByPilot || {}), ...Object.keys(updatesByPilot || {})]);
  for (const pilotId of pilotIds) {
    merged[pilotId] = replaceLiveBandRange(
      existingByPilot?.[pilotId] || [],
      updatesByPilot?.[pilotId] || [],
      replaceFrom,
      replaceTo,
    );
  }
  return merged;
}

const LIVE_ROOM_ID = "default";
// CORE DATA-PLANE INVARIANTS (see docs/LIVE_DATA_PIPELINE.md):
// - Online transport is one 30 Hz stream; selected ~5 Hz frames are upgraded
//   in-place with durable metadata after IndexedDB commits.
// - Never delete a durable record before the server ACK and local delete both
//   complete. Historical replay is persistOnly and must never drive live UI.
// - Recovery work is lower priority than current live/current durable frames.
const RECEIVER_ONLINE_WINDOW_MS = 900;
const SERIAL_SAMPLE_BUFFER_MS = 10000;
const SERIAL_SAMPLE_BUFFER_LIMIT = 600;
const TRAINING_HUB_VENDOR_ID = 0x0483;
const TRAINING_HUB_PRODUCT_ID = 0x5740;
const LIVE_SESSION_STORAGE_KEY = "fpv-training-live-session";
const LIVE_SEQUENCE_STORAGE_KEY = "fpv-training-live-sequence";
// PROTECTED LIVE-PIPELINE CONTRACT: this ~5 Hz durable cadence is embedded in
// the single 30 Hz live stream. It must remain IndexedDB-first and ACK-deleted;
// do not replace it with a second online persistOnly stream or client-derived
// flight state. See docs/LIVE_DATA_PIPELINE.md before changing this section.
const PERSISTENCE_SAMPLE_INTERVAL_MS = 200;
const SERIAL_PORT_BUFFER_SIZE = 8 * 1024 * 1024;
const OUTBOX_MAX_IN_FLIGHT = 64;
const OUTBOX_REPLAY_BATCH_SIZE = 16;
const OUTBOX_REPLAY_INTERVAL_MS = 25;
const OUTBOX_ACK_TIMEOUT_MS = 3000;
const AUDIENCE_LIVE_STALE_MS = 1000;

function loadLiveSessionId() {
  try {
    let value = window.sessionStorage.getItem(LIVE_SESSION_STORAGE_KEY);
    if (!value) {
      value = typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.sessionStorage.setItem(LIVE_SESSION_STORAGE_KEY, value);
    }
    return value;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function loadLiveSequence() {
  try {
    return Math.max(0, Number(window.localStorage.getItem(LIVE_SEQUENCE_STORAGE_KEY)) || 0);
  } catch {
    return 0;
  }
}

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
  return "Virtual / selected serial port";
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

const ANNOUNCER_STORAGE_KEY = "training-announcer-settings-v1";
const DEFAULT_ANNOUNCER_SETTINGS = {
  enabled: true,
  ttsEnabled: true,
  ttsVoiceName: "",
  ttsVoiceURI: "",
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  ttsWarmupEnabled: true,
  ttsWarmupIdleMs: 5000,
  ttsWarmupMs: 350,
  aiTtsEnabled: false,
  aiTtsMinIntervalMs: 30000,
  longIdleEnabled: true,
  longIdleMinutes: 6,
  longIdleCooldownMinutes: 2,
  turtleEnabled: true,
  turtleWindowMinutes: 5,
  turtleCountThreshold: 3,
  turtleCooldownMinutes: 5,
  longFlightEnabled: true,
  longFlightMinutes: 3,
  longFlightCooldownMinutes: 8,
  receiverOfflineEnabled: true,
  receiverOfflineCooldownMinutes: 2,
  slowPaceEnabled: true,
  slowPaceMinutes: 10,
  slowPaceUtilizationPct: 20,
  slowPaceCooldownMinutes: 10,
};

function loadAnnouncerSettings() {
  try {
    const saved = window.localStorage.getItem(ANNOUNCER_STORAGE_KEY);
    if (!saved) return DEFAULT_ANNOUNCER_SETTINGS;
    const parsed = JSON.parse(saved);
    delete parsed.ttsEngine;
    delete parsed.sapiVoiceName;
    return { ...DEFAULT_ANNOUNCER_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_ANNOUNCER_SETTINGS;
  }
}

function getRanges(config, type) {
  const entries = [];
  Object.entries(config || {}).forEach(([channelKey, ranges]) => {
    (ranges || []).forEach((range) => {
      if (range.type === type) entries.push({ ...range, channelKey });
    });
  });
  return entries;
}

function getPilotStateForAnnouncement(pilot, sample, recentSamples) {
  const channels = sample?.channels || {};
  const config = pilot?.channelConfig || {};
  const armRanges = getRanges(config, "arm");
  const turtleRanges = getRanges(config, "turtle");
  const armed = armRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const turtleSwitch = turtleRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const throttleValues = recentSamples.map((item) => item.channels?.ch3).filter((value) => Number.isFinite(value));
  const throttleSpread = throttleValues.length ? Math.max(...throttleValues) - Math.min(...throttleValues) : 0;
  return {
    armed,
    turtle: armed && turtleSwitch,
    flying: armed && throttleSpread > 80,
  };
}

function optionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getParticipantTrainingWindow(event, participant, now = Date.now()) {
  const eventStart = optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || now;
  const eventEnd = optionalTimestamp(event?.endedAt) || now;
  const start = Math.max(eventStart, optionalTimestamp(participant?.trainingStartAt) || eventStart);
  const end = Math.max(start, Math.min(eventEnd, optionalTimestamp(participant?.trainingEndAt) || eventEnd));
  return { start, end };
}

function formatAnnouncerDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes} 分钟`;
}

function statTotalFlightMs(stat) {
  const value = Number(stat?.total_flight_ms ?? stat?.totalFlightMs ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function statLastFlightEndedAt(stat) {
  const idleMs = Number(stat?.idle_ms ?? stat?.idleMs);
  if (!Number.isFinite(idleMs) || idleMs < 0) return null;
  const updatedAt = Number(stat?.updated_at ?? stat?.updatedAt ?? Date.now());
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return Math.max(0, updatedAt - idleMs);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatBitRate(value) {
  const bitsPerSecond = Number(value) || 0;
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
  if (bitsPerSecond >= 1000) return `${(bitsPerSecond / 1000).toFixed(0)} Kbps`;
  return `${Math.round(bitsPerSecond)} bps`;
}

function formatHistoryLag(value) {
  const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function audiencePressureText(level) {
  return ({ low: "低", medium: "中", high: "高", critical: "已满载" })[level] || "低";
}

function audiencePressureColor(level) {
  if (level === "critical") return "#b91c1c";
  if (level === "high") return "#c2410c";
  if (level === "medium") return "#a16207";
  return "#047857";
}

function isChineseVoice(voice) {
  const lang = String(voice?.lang || "").toLowerCase();
  const name = String(voice?.name || "");
  return lang.startsWith("zh") || /中文|普通话|国语|粤语|汉语|Chinese|Mandarin|Cantonese/i.test(name);
}

function voiceValue(voice) {
  return voice?.voiceURI || voice?.name || "";
}

function isPreferredChineseVoice(voice) {
  const text = `${voice?.name || ""} ${voice?.voiceURI || ""}`;
  return /晓晓|Xiaoxiao/i.test(text) && /Online|Natural|Neural/i.test(text);
}

export default function TrainingSystem({ onBack, onOpenBracket, bracketLive = false, audience = false, initialTab = "pilots" }) {
  const [tab, setTab] = useState(initialTab);
  const [pilots, setPilots] = useState([]);
  const [events, setEvents] = useState([]);
  const [live, setLive] = useState({ receivers: [], samples: [] });
  const [status, setStatus] = useState("正在读取数据...");
  const [statusLog, setStatusLog] = useState([{ time: Date.now(), message: "正在读取数据..." }]);
  const [announcements, setAnnouncements] = useState([]);
  const [announcerSettings, setAnnouncerSettings] = useState(loadAnnouncerSettings);
  const [ttsVoices, setTtsVoices] = useState([]);
  const [announcerStatsSeed, setAnnouncerStatsSeed] = useState({ eventId: "", statsByPilot: {} });
  const [coachSuggestedMessages, setCoachSuggestedMessages] = useState([]);
  const [csvWriteStatus, setCsvWriteStatus] = useState(null);
  const [, setServerConnected] = useState(false);
  const portRef = useRef(null);
  const readerRef = useRef(null);
  const ttsAudioContextRef = useRef(null);
  const lastTtsQueuedAtRef = useRef(0);
  const aiTtsStartedAtRef = useRef(Date.now());
  const aiTtsLastSpokenAtRef = useRef(0);
  const aiTtsLastSignatureByPilotRef = useRef(new Map());
  const aiTtsPlayedRef = useRef(new Set());
  const serialLoopRef = useRef(false);
  const serialConnectInFlightRef = useRef(false);
  const manualSerialDisconnectRef = useRef(false);
  const serialReconnectTimerRef = useRef(0);
  const serialClaimTimerRef = useRef(0);
  const serialClaimOwnerRef = useRef(typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const serialLatestRef = useRef({});
  const serialSamplesRef = useRef({});
  const announcerRuntimeRef = useRef({ pilots: new Map(), receivers: new Map(), cooldowns: new Map(), eventId: "" });
  const serialRenderFrameRef = useRef(0);
  const serialInputFpsRef = useRef({ count: 0, startedAt: 0 });
  const liveSocketRef = useRef(null);
  const liveRelayRef = useRef({ lastSentAt: 0, lastUiAt: 0, minIntervalMs: 30 });
  const eventsRef = useRef([]);
  const liveSessionIdRef = useRef(loadLiveSessionId());
  const liveClientSequenceRef = useRef(loadLiveSequence());
  const audienceSequenceRef = useRef(0);
  const audienceStreamIdRef = useRef("");
  const audiencePendingBatchRef = useRef(null);
  const audienceBatchFrameRef = useRef(0);
  const outboxInFlightRef = useRef(new Map());
  const outboxFlushTimerRef = useRef(0);
  const outboxFlushDueAtRef = useRef(0);
  const outboxWriteChainRef = useRef(Promise.resolve());
  const outboxRecoveryWriteFenceRef = useRef(Promise.resolve());
  const outboxRecoveringRef = useRef(false);
  const outboxRecoveryCutoffSequenceRef = useRef(0);
  const outboxRecoveryCutoffCapturedAtRef = useRef(0);
  const outboxRecoveryHadRecordsRef = useRef(false);
  const outboxEmptyPassesRef = useRef(0);
  const outboxBackfillAtByEventRef = useRef(new Map());
  const outboxRetryAfterRef = useRef(new Map());
  const outboxOrphanedRef = useRef(new Map());
  // Event ids confirmed missing on the server. Keep this knowledge for the
  // lifetime of the page so a late IndexedDB write cannot resurrect a deleted
  // event's cache after the first bulk cleanup has completed.
  const outboxDiscardedEventIdsRef = useRef(new Set());
  const outboxDiscardCleanupInFlightRef = useRef(new Set());
  const outboxAcknowledgedDeleteRef = useRef(new Set());
  const outboxAcknowledgedDeleteTimerRef = useRef(0);
  const persistenceSampleRef = useRef({ eventId: "", capturedAt: 0 });
  const serialStateRef = useRef(null);
  const serialStateUiRef = useRef({ lastAt: 0, receiverCount: 0, maxReceiverId: 0, connected: false });
  const [serialRenderTick, setSerialRenderTick] = useState(0);
  const [serialInputFps, setSerialInputFps] = useState(0);
  const [liveStateSeed, setLiveStateSeed] = useState(null);
  const [liveSyncVersion, setLiveSyncVersion] = useState(0);
  const [liveRelayState, setLiveRelayState] = useState({
    connected: false,
    mode: audience ? "subscriber" : "publisher",
    minIntervalMs: 30,
    lastAt: null,
    error: "",
    power: null,
    outboxRecovering: false,
    outboxPending: 0,
    outboxPendingMore: false,
    outboxError: "",
    outboxOrphaned: 0,
    outboxOrphanReason: "",
    outboxActiveEventId: "",
    outboxOldestEventId: "",
    outboxNewestEventId: "",
    outboxEventGroups: "",
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

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  function pushStatus(message) {
    setStatus(message);
    setStatusLog((current) => [{ time: Date.now(), message }, ...current].slice(0, 80));
  }

  function stopTrainingSerialClaim() {
    if (serialClaimTimerRef.current) window.clearInterval(serialClaimTimerRef.current);
    serialClaimTimerRef.current = 0;
    releaseTrainingSerialPortClaim(serialClaimOwnerRef.current);
  }

  function startTrainingSerialClaim(port) {
    stopTrainingSerialClaim();
    void claimTrainingSerialPort(port, serialClaimOwnerRef.current);
    serialClaimTimerRef.current = window.setInterval(() => {
      if (portRef.current === port && serialStateRef.current?.connected) {
        void claimTrainingSerialPort(port, serialClaimOwnerRef.current);
      } else {
        stopTrainingSerialClaim();
      }
    }, 1000);
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(ANNOUNCER_STORAGE_KEY, JSON.stringify(announcerSettings));
    } catch {
      // Local storage can be unavailable in private or locked-down browser modes.
    }
  }, [announcerSettings]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return undefined;
    function loadVoices() {
      const voices = window.speechSynthesis.getVoices().filter(isChineseVoice);
      setTtsVoices(voices);
      setAnnouncerSettings((current) => {
        if (!voices.length) return current;
        const selected = voices.find((voice) => current.ttsVoiceURI && voiceValue(voice) === current.ttsVoiceURI)
          || voices.find((voice) => current.ttsVoiceName && voice.name === current.ttsVoiceName);
        if (selected) return { ...current, ttsVoiceName: selected.name, ttsVoiceURI: voiceValue(selected) };
        const preferred = voices.find(isPreferredChineseVoice)
          || voices.find((voice) => voice.lang?.toLowerCase() === "zh-cn")
          || voices.find((voice) => voice.lang?.toLowerCase().startsWith("zh-cn"))
          || voices[0];
        return preferred ? { ...current, ttsVoiceName: preferred.name, ttsVoiceURI: voiceValue(preferred) } : current;
      });
    }
    loadVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    if (audience) return undefined;
    let stopped = false;
    async function loadCsvWriteStatus() {
      const status = await apiGet("/api/training-csv/status", null);
      if (!stopped && status) setCsvWriteStatus(status);
    }
    loadCsvWriteStatus();
    const timer = window.setInterval(loadCsvWriteStatus, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [audience]);

  useEffect(() => {
    if (audience) return undefined;
    const activeEventId = events.find((event) => event.active)?.id || "";
    if (!activeEventId) {
      setAnnouncerStatsSeed({ eventId: "", statsByPilot: {} });
      return undefined;
    }

    let stopped = false;
    async function loadAnnouncerStatsSeed() {
      const overview = await apiGet(`/api/training-events/${activeEventId}/stats?includeSegments=0`, { stats: [] });
      if (stopped) return;
      const statsByPilot = {};
      for (const stat of overview?.stats || []) {
        const pilotId = stat?.pilot_id ?? stat?.pilotId;
        if (pilotId) statsByPilot[pilotId] = stat;
      }
      setAnnouncerStatsSeed({ eventId: activeEventId, statsByPilot });
    }

    loadAnnouncerStatsSeed();
    const timer = window.setInterval(loadAnnouncerStatsSeed, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [audience, events]);

  useEffect(() => {
    if (audience) return undefined;
    let stopped = false;
    async function loadCoachSuggestedMessages() {
      const snapshot = await apiGet("/api/coach/overview", null);
      if (stopped) return;
      const messages = (snapshot?.pilots || [])
        .map((pilot) => pilot.suggestedMessage ? {
          ...pilot.suggestedMessage,
          pilotName: pilot.pilotName,
          pilotId: pilot.pilotId,
          receiverId: pilot.receiverId,
        } : null)
        .filter(Boolean)
        .sort((left, right) => Number(right.generatedAt || 0) - Number(left.generatedAt || 0))
        .slice(0, 12);
      setCoachSuggestedMessages(messages);
    }
    loadCoachSuggestedMessages();
    const timer = window.setInterval(loadCoachSuggestedMessages, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [audience]);

  function playTtsWarmup(durationMs = 350) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return Promise.resolve();
    }
    try {
      const context = ttsAudioContextRef.current || new AudioContextClass();
      ttsAudioContextRef.current = context;
      const resumePromise = context.state === "suspended" ? context.resume() : Promise.resolve();
      return resumePromise.then(() => new Promise((resolve) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.00001;
        oscillator.frequency.value = 440;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        window.setTimeout(() => {
          try {
            oscillator.stop();
            oscillator.disconnect();
            gain.disconnect();
          } catch {
            // The warmup sound graph may already be stopped by the browser.
          }
          resolve();
        }, Math.max(0, durationMs));
      }));
    } catch {
      return Promise.resolve();
    }
  }

  const speakUtterance = useCallback((message, { force = false } = {}) => {
    if (!force && !announcerSettings.ttsEnabled) return false;
    if (!("speechSynthesis" in window)) {
      pushStatus("当前浏览器不支持语音播报");
      return false;
    }
    const utterance = new SpeechSynthesisUtterance(message);
    const voice = ttsVoices.find((item) => announcerSettings.ttsVoiceURI && voiceValue(item) === announcerSettings.ttsVoiceURI)
      || ttsVoices.find((item) => item.name === announcerSettings.ttsVoiceName)
      || ttsVoices[0]
      || null;
    utterance.lang = voice?.lang || "zh-CN";
    if (voice) utterance.voice = voice;
    utterance.rate = Math.max(0.5, Math.min(1.6, Number(announcerSettings.ttsRate) || 1));
    utterance.pitch = Math.max(0.5, Math.min(1.8, Number(announcerSettings.ttsPitch) || 1));
    utterance.volume = Math.max(0, Math.min(1, Number(announcerSettings.ttsVolume) || 1));
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      pushStatus(`语音播报失败：${event.error || "当前音色不可用"}`);
    };
    try {
      window.speechSynthesis.resume?.();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      pushStatus(`语音播报失败：${error.message}`);
      return false;
    }
  }, [announcerSettings, ttsVoices]);

  const speakAnnouncementText = useCallback((message, { force = false, retryDefault = true } = {}) => {
    if (!force && !announcerSettings.ttsEnabled) return false;
    if (!("speechSynthesis" in window)) {
      pushStatus("当前浏览器不支持语音播报");
      return false;
    }
    const now = Date.now();
    const idleMs = now - (lastTtsQueuedAtRef.current || 0);
    lastTtsQueuedAtRef.current = now;
    if (!force && announcerSettings.ttsWarmupEnabled && idleMs >= Number(announcerSettings.ttsWarmupIdleMs || 0)) {
      void playTtsWarmup(Number(announcerSettings.ttsWarmupMs) || 350)
        .catch(() => {})
        .then(() => {
          speakUtterance(message, { force, retryDefault });
        });
      return true;
    }
    return speakUtterance(message, { force, retryDefault });
  }, [announcerSettings, speakUtterance]);

  useEffect(() => {
    if (audience || !announcerSettings.aiTtsEnabled) return;
    const now = Date.now();
    const minIntervalMs = Math.max(1000, Number(announcerSettings.aiTtsMinIntervalMs || 0));
    if (now - aiTtsLastSpokenAtRef.current < minIntervalMs) return;
    for (const item of coachSuggestedMessages) {
      if (!item.speakable || Number(item.generatedAt || 0) < aiTtsStartedAtRef.current) continue;
      const pilotKey = `${item.eventId || ""}:${item.pilotId || ""}:${item.receiverId || ""}`;
      const signature = item.signature || `${item.priority || ""}:${item.reason || ""}:${item.message || ""}`;
      if (aiTtsLastSignatureByPilotRef.current.get(pilotKey) === signature) continue;
      const key = `${item.eventId || ""}:${item.pilotId || ""}:${item.generatedAt || ""}:${item.message}`;
      if (aiTtsPlayedRef.current.has(key)) continue;
      aiTtsPlayedRef.current.add(key);
      aiTtsLastSignatureByPilotRef.current.set(pilotKey, signature);
      aiTtsLastSpokenAtRef.current = now;
      speakAnnouncementText(item.message, { force: true });
      break;
    }
  }, [announcerSettings.aiTtsEnabled, announcerSettings.aiTtsMinIntervalMs, audience, coachSuggestedMessages, speakAnnouncementText]);

  const emitAnnouncement = useCallback((key, message, cooldownMs, now = Date.now()) => {
    if (!announcerSettings.enabled) return;
    const runtime = announcerRuntimeRef.current;
    const lastAt = runtime.cooldowns.get(key) || 0;
    if (now - lastAt < cooldownMs) return;
    runtime.cooldowns.set(key, now);
    setAnnouncements((current) => [{ time: now, message }, ...current].slice(0, 30));
    speakAnnouncementText(message);
  }, [announcerSettings.enabled, speakAnnouncementText]);

  useEffect(() => {
    if (audience) return undefined;
    const timer = window.setInterval(() => {
      const activeEvent = events.find((event) => event.active);
      const runtime = announcerRuntimeRef.current;
      const now = Date.now();
      if (!activeEvent) {
        runtime.eventId = "";
        runtime.pilots.clear();
        runtime.receivers.clear();
        return;
      }
      if (runtime.eventId !== activeEvent.id) {
        runtime.eventId = activeEvent.id;
        runtime.pilots.clear();
        runtime.receivers.clear();
      }

      const pilotById = new Map(pilots.map((pilot) => [pilot.id, pilot]));
      const statsByPilot = announcerStatsSeed.eventId === activeEvent.id ? announcerStatsSeed.statsByPilot : {};
      let activePilotCount = 0;
      let totalWindowMs = 0;
      let totalFlightMs = 0;

      for (const participant of activeEvent.participants || []) {
        const pilot = pilotById.get(participant.pilotId);
        if (!pilot) continue;
        const receiverId = Number(participant.receiverId);
        const sample = serialLatestRef.current[receiverId] || null;
        const online = Boolean(sample && now - Number(sample.time || 0) <= 2500);
        const paired = Boolean(online && (sample.lq > 0 || sample.rssi > -127));
        const receiverKey = `${activeEvent.id}:rx:${receiverId}`;
        const previousReceiver = runtime.receivers.get(receiverKey);
        const wasOnline = typeof previousReceiver === "object" ? previousReceiver.online : previousReceiver === true;
        const wasPaired = typeof previousReceiver === "object" ? previousReceiver.paired : false;
        if (announcerSettings.receiverOfflineEnabled && wasOnline && !online) {
          emitAnnouncement(
            `offline:${receiverKey}`,
            `${receiverId}号接收机信号丢失`,
            announcerSettings.receiverOfflineCooldownMinutes * 60000,
            now,
          );
        }
        if (announcerSettings.receiverOfflineEnabled && wasPaired && !paired) {
          emitAnnouncement(
            `unpaired:${receiverKey}`,
            `${pilot.name}的${receiverId}号接收机从已对频变为未对频`,
            announcerSettings.receiverOfflineCooldownMinutes * 60000,
            now,
          );
        }
        runtime.receivers.set(receiverKey, { online, paired });

        const trainingWindow = getParticipantTrainingWindow(activeEvent, participant, now);
        if (now < trainingWindow.start || now > trainingWindow.end) continue;

        const pilotKey = `${activeEvent.id}:${pilot.id}`;
        const pilotRuntime = runtime.pilots.get(pilotKey) || {
          recent: [],
          lastUpdatedAt: now,
          flying: false,
          turtle: false,
          flyingStartedAt: null,
          lastFlightEndedAt: null,
          totalFlightMs: 0,
          turtleStarts: [],
          longFlightAnnouncedFor: null,
        };
        const statSeed = statsByPilot[pilot.id] || null;
        const seededTotalFlightMs = statTotalFlightMs(statSeed);
        const seededLastFlightEndedAt = statLastFlightEndedAt(statSeed);
        if (seededTotalFlightMs > pilotRuntime.totalFlightMs) {
          pilotRuntime.totalFlightMs = seededTotalFlightMs;
        }
        const boundedSeededLastFlightEndedAt = seededLastFlightEndedAt && seededLastFlightEndedAt >= trainingWindow.start
          ? Math.min(now, seededLastFlightEndedAt)
          : null;
        if (boundedSeededLastFlightEndedAt && (!pilotRuntime.lastFlightEndedAt || boundedSeededLastFlightEndedAt > pilotRuntime.lastFlightEndedAt)) {
          pilotRuntime.lastFlightEndedAt = boundedSeededLastFlightEndedAt;
        }

        const elapsed = Math.max(0, now - pilotRuntime.lastUpdatedAt);
        if (pilotRuntime.flying) pilotRuntime.totalFlightMs += Math.min(elapsed, 2000);
        pilotRuntime.lastUpdatedAt = now;

        let state = { flying: false, turtle: false };
        if (online) {
          pilotRuntime.recent = [...pilotRuntime.recent, sample].filter((item) => item.time >= now - 5000).slice(-120);
          state = getPilotStateForAnnouncement(pilot, sample, pilotRuntime.recent);
        }

        if (!pilotRuntime.flying && state.flying) {
          pilotRuntime.flyingStartedAt = now;
          pilotRuntime.longFlightAnnouncedFor = null;
        }
        if (pilotRuntime.flying && !state.flying) {
          pilotRuntime.lastFlightEndedAt = now;
          pilotRuntime.flyingStartedAt = null;
        }
        if (!pilotRuntime.turtle && state.turtle) {
          pilotRuntime.turtleStarts.push(now);
        }
        pilotRuntime.turtleStarts = pilotRuntime.turtleStarts.filter((time) => now - time <= announcerSettings.turtleWindowMinutes * 60000);

        if (announcerSettings.longIdleEnabled && !state.flying) {
          const idleSince = pilotRuntime.lastFlightEndedAt || trainingWindow.start;
          const idleMs = now - idleSince;
          if (idleMs >= announcerSettings.longIdleMinutes * 60000) {
            emitAnnouncement(
              `idle:${pilotKey}`,
              `${pilot.name}已经 ${formatAnnouncerDuration(idleMs)}未起飞`,
              announcerSettings.longIdleCooldownMinutes * 60000,
              now,
            );
          }
        }

        if (announcerSettings.turtleEnabled && pilotRuntime.turtleStarts.length >= announcerSettings.turtleCountThreshold) {
          emitAnnouncement(
            `turtle:${pilotKey}`,
            `${pilot.name}连续 Turtle 次数较高`,
            announcerSettings.turtleCooldownMinutes * 60000,
            now,
          );
        }

        if (
          announcerSettings.longFlightEnabled &&
          state.flying &&
          pilotRuntime.flyingStartedAt &&
          now - pilotRuntime.flyingStartedAt >= announcerSettings.longFlightMinutes * 60000 &&
          pilotRuntime.longFlightAnnouncedFor !== pilotRuntime.flyingStartedAt
        ) {
          pilotRuntime.longFlightAnnouncedFor = pilotRuntime.flyingStartedAt;
          emitAnnouncement(
            `long-flight:${pilotKey}:${pilotRuntime.flyingStartedAt}`,
            `${pilot.name}完成一次长时间稳定飞行`,
            announcerSettings.longFlightCooldownMinutes * 60000,
            now,
          );
        }

        pilotRuntime.flying = state.flying;
        pilotRuntime.turtle = state.turtle;
        runtime.pilots.set(pilotKey, pilotRuntime);
        activePilotCount += 1;
        totalWindowMs += Math.max(1, now - trainingWindow.start);
        totalFlightMs += Math.max(pilotRuntime.totalFlightMs, seededTotalFlightMs);
      }

      if (
        announcerSettings.slowPaceEnabled &&
        activePilotCount > 0 &&
        totalWindowMs / activePilotCount >= announcerSettings.slowPaceMinutes * 60000 &&
        totalFlightMs / Math.max(1, totalWindowMs) < announcerSettings.slowPaceUtilizationPct / 100
      ) {
        emitAnnouncement(
          `slow-pace:${activeEvent.id}`,
          "当前训练节奏偏慢",
          announcerSettings.slowPaceCooldownMinutes * 60000,
          now,
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [announcerSettings, announcerStatsSeed, audience, emitAnnouncement, events, pilots]);

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
        if (serialStateRef.current?.portName === "虚拟测试阵列" && lastDataAt) {
          serialLatestRef.current = {};
          serialSamplesRef.current = {};
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
            error: "",
            power: null,
          }));
        }
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
        eventsRef.current = nextEvents;
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

  function clearSerialConnection(error = "", { preserveSamples = false } = {}) {
    serialLoopRef.current = false;
    portRef.current = null;
    readerRef.current = null;
    serialLatestRef.current = {};
    if (!preserveSamples) serialSamplesRef.current = {};
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

  async function releaseSerialResources({ clear = true, error = "", preserveSamples = false } = {}) {
    serialLoopRef.current = false;
    stopTrainingSerialClaim();
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

    if (clear) clearSerialConnection(error, { preserveSamples });
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
      if (await isBetaflightSerialPortClaimed(port)) {
        throw new Error("该串口正在被内置 BF 使用，请在 BF 断开后重试");
      }
      if (portRef.current && portRef.current !== port) {
        await releaseSerialResources({ clear: false });
      }
      // Web Serial defaults to only 255 bytes. A hidden tab can be scheduled
      // late even when its reader remains active, so leave enough native
      // headroom to absorb a long scheduling stall without cutting a JSON
      // object in half. The API requires this value to remain below 16 MiB.
      await port.open({ baudRate: 115200, bufferSize: SERIAL_PORT_BUFFER_SIZE });
      manualSerialDisconnectRef.current = false;
      portRef.current = port;
      startTrainingSerialClaim(port);
      void rememberTrainingSerialPort(port);
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
      const candidates = [];
      for (const port of ports) {
        if (isTrainingHubPort(port) && !await isBetaflightSerialPortClaimed(port)) candidates.push(port);
      }
      const preferred = findPreferredTrainingSerialPort(ports);
      const port = (preferred && candidates.includes(preferred))
        ? preferred
        : (candidates.length === 1 ? candidates[0] : null);
      if (!port && candidates.length > 1) {
        setSerialState((current) => ({
          ...current,
          error: "检测到多个相同型号串口，请点“连接阵列”并在浏览器中选择 TRAINING_HUB",
        }));
        return;
      }
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
    // Serial sampling reads this ref outside React's render cycle. Update it at
    // the same instant as the state transition so an event switch cannot emit
    // even one durable frame under the previous event id.
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    try {
      await apiPost("/api/events", nextEvents);
      const refreshedEvents = await apiGet("/api/events", nextEvents);
      const resolvedEvents = Array.isArray(refreshedEvents) ? refreshedEvents : nextEvents;
      eventsRef.current = resolvedEvents;
      setEvents(resolvedEvents);
      publishTrainingState(resolvedEvents);
      pushStatus("训练事件已保存");
      return resolvedEvents;
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
    // FPS describes frames actually arriving at this page. The sample timestamp
    // remains authoritative for strips, but it may be old during recovery or
    // differ from the audience device clock.
    recordSerialInputFrame();

    const latest = { ...serialLatestRef.current };
    for (const sample of updatedSamples) {
      latest[sample.receiverId] = sample;
      const queue = serialSamplesRef.current[sample.receiverId] || [];
      queue.push(sample);
      const cutoff = sample.time - SERIAL_SAMPLE_BUFFER_MS;
      while (queue.length && (queue[0].time < cutoff || queue.length > SERIAL_SAMPLE_BUFFER_LIMIT)) queue.shift();
      serialSamplesRef.current[sample.receiverId] = queue;
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

  const scheduleOutboxFlush = useCallback((delayMs = 0) => {
    if (audience) return;
    const dueAt = Date.now() + Math.max(0, delayMs);
    // A new online packet schedules a 3 s ACK watchdog every 200 ms. It must
    // never postpone an already scheduled 25 ms recovery pump; doing so was the
    // main reason a four-minute cache drained at only about 8-11 packets/s.
    if (outboxFlushTimerRef.current && outboxFlushDueAtRef.current <= dueAt) return;
    if (outboxFlushTimerRef.current) window.clearTimeout(outboxFlushTimerRef.current);
    outboxFlushDueAtRef.current = dueAt;
    outboxFlushTimerRef.current = window.setTimeout(async () => {
      outboxFlushTimerRef.current = 0;
      outboxFlushDueAtRef.current = 0;
      const socket = liveSocketRef.current;
      const socketReady = Boolean(socket && socket.readyState === 1);
      try {
        // Freeze recovery only after every write that was already scheduled at
        // reconnect time has committed. Without this fence, a fast first scan
        // can declare the outbox empty just before its final offline records
        // appear in IndexedDB.
        await outboxRecoveryWriteFenceRef.current.catch(() => undefined);
        const activeEventId = eventsRef.current.find((event) => event.active)?.id || "";
        const recoveryCapturedAtCutoff = Number(outboxRecoveryCutoffCapturedAtRef.current) || 0;
        const records = await listCachedLivePackets(240, [...outboxOrphanedRef.current.keys()], {
          priorityEventId: activeEventId,
          capturedAtCutoff: recoveryCapturedAtCutoff || Number.MAX_SAFE_INTEGER,
        });
        const discardedEventIds = [...new Set(records
          .map((record) => String(record?.eventId || ""))
          .filter((eventId) => eventId && outboxDiscardedEventIdsRef.current.has(eventId)))];
        if (discardedEventIds.length) {
          let startedCleanup = false;
          for (const discardedEventId of discardedEventIds) {
            if (outboxDiscardCleanupInFlightRef.current.has(discardedEventId)) continue;
            startedCleanup = true;
            outboxDiscardCleanupInFlightRef.current.add(discardedEventId);
            const writeFence = outboxWriteChainRef.current;
            void writeFence.catch(() => undefined)
              .then(() => deleteCachedLivePacketsByEventId(discardedEventId))
              .then((deleted) => {
                for (const record of records) {
                  if (String(record?.eventId || "") !== discardedEventId) continue;
                  outboxInFlightRef.current.delete(record.packetId);
                  outboxRetryAfterRef.current.delete(record.packetId);
                  outboxOrphanedRef.current.delete(record.packetId);
                }
                if (deleted > 0) pushStatus(`已清理已删除事件 ${discardedEventId} 的 ${deleted} 个残留缓存包`);
              })
              .catch((error) => {
                const outboxError = `已删除事件残留缓存清理失败：${error.message || "IndexedDB 删除失败"}`;
                setLiveRelayState((current) => ({ ...current, outboxError }));
              })
              .finally(() => {
                outboxDiscardCleanupInFlightRef.current.delete(discardedEventId);
                scheduleOutboxFlush(0);
              });
          }
          scheduleOutboxFlush(startedCleanup ? 50 : 100);
          return;
        }
        const now = Date.now();
        let expiredAcknowledgement = false;
        for (const [packetId, sentAt] of outboxInFlightRef.current) {
          if (now - Number(sentAt || 0) < OUTBOX_ACK_TIMEOUT_MS) continue;
          outboxInFlightRef.current.delete(packetId);
          expiredAcknowledgement = true;
        }
        if (expiredAcknowledgement) {
          outboxRecoveringRef.current = true;
          outboxRecoveryCutoffSequenceRef.current = Math.max(
            Number(outboxRecoveryCutoffSequenceRef.current) || 0,
            liveClientSequenceRef.current,
          );
          outboxRecoveryCutoffCapturedAtRef.current = Math.max(
            Number(outboxRecoveryCutoffCapturedAtRef.current) || 0,
            now,
          );
          outboxEmptyPassesRef.current = 0;
        }
        const recoveryCutoff = Number(outboxRecoveryCutoffSequenceRef.current) || 0;
        const recoveryRecords = outboxRecoveringRef.current
          ? records.filter((record) => isHistoricalRecoveryRecord(record, recoveryCutoff, recoveryCapturedAtCutoff))
          : [];
        const eventCounts = new Map();
        for (const record of recoveryRecords) {
          const eventId = String(record.eventId || "(无事件ID)");
          eventCounts.set(eventId, (eventCounts.get(eventId) || 0) + 1);
        }
        const outboxEventGroups = [...eventCounts.entries()]
          .map(([eventId, count]) => `${eventId}: ${count}`)
          .join("；");
        const oldestRecoveryRecord = recoveryRecords.reduce((oldest, record) => (
          !oldest || Number(record.capturedAt || 0) < Number(oldest.capturedAt || 0) ? record : oldest
        ), null);
        const newestRecoveryRecord = recoveryRecords.reduce((newest, record) => (
          !newest || Number(record.capturedAt || 0) > Number(newest.capturedAt || 0) ? record : newest
        ), null);
        const outboxOrphaned = outboxOrphanedRef.current.size;
        const latestOrphan = [...outboxOrphanedRef.current.values()].at(-1);
        setLiveRelayState((current) => {
          const outboxPending = Math.max(recoveryRecords.length, outboxOrphaned);
          const outboxPendingMore = outboxOrphaned > recoveryRecords.length
            || (records.length >= 240 && recoveryRecords.length >= 240);
          if (
            current.outboxRecovering === outboxRecoveringRef.current
            && current.outboxPending === outboxPending
            && current.outboxPendingMore === outboxPendingMore
            && current.outboxOrphaned === outboxOrphaned
            && current.outboxActiveEventId === activeEventId
            && current.outboxOldestEventId === String(oldestRecoveryRecord?.eventId || "")
            && current.outboxNewestEventId === String(newestRecoveryRecord?.eventId || "")
            && current.outboxEventGroups === outboxEventGroups
          ) return current;
          return {
            ...current,
            outboxRecovering: outboxRecoveringRef.current,
            outboxPending,
            outboxPendingMore,
            outboxOrphaned,
            outboxOrphanReason: latestOrphan?.reason || "",
            outboxActiveEventId: activeEventId,
            outboxOldestEventId: String(oldestRecoveryRecord?.eventId || ""),
            outboxNewestEventId: String(newestRecoveryRecord?.eventId || ""),
            outboxEventGroups,
          };
        });
        // Keep reporting the local cache while offline, but do not consume or
        // mark recovery complete until a server connection can ACK the data.
        if (!socketReady) return;
        if (recoveryRecords.length) outboxRecoveryHadRecordsRef.current = true;
        const pendingRecords = recoveryRecords.filter((record) => !outboxInFlightRef.current.has(record.packetId));
        const sendableRecords = pendingRecords.filter((record) => (
          Number(outboxRetryAfterRef.current.get(record.packetId) || 0) <= now
        ));
        if (pendingRecords.length) {
          outboxEmptyPassesRef.current = 0;
        } else if (!recoveryRecords.length) {
          outboxEmptyPassesRef.current += 1;
          if (outboxEmptyPassesRef.current >= 2) {
            const completedRecovery = outboxRecoveringRef.current && outboxRecoveryHadRecordsRef.current;
            outboxRecoveringRef.current = false;
            outboxRecoveryCutoffSequenceRef.current = 0;
            outboxRecoveryCutoffCapturedAtRef.current = 0;
            outboxRecoveryHadRecordsRef.current = false;
            setLiveRelayState((current) => ({
              ...current,
              outboxRecovering: false,
              outboxPending: 0,
              outboxPendingMore: false,
            }));
            if (completedRecovery && socket.readyState === 1) {
              const recoveredEventIds = [...outboxBackfillAtByEventRef.current.keys()].filter(Boolean);
              const activeEventId = eventsRef.current.find((event) => event.active)?.id || "";
              if (!recoveredEventIds.length && activeEventId) recoveredEventIds.push(activeEventId);
              for (const eventId of recoveredEventIds) {
                socket.send(JSON.stringify({
                  type: "live_backfill_complete",
                  room: LIVE_ROOM_ID,
                  eventId,
                  cutoffSequence: recoveryCutoff,
                  cutoffCapturedAt: recoveryCapturedAtCutoff,
                }));
              }
              outboxBackfillAtByEventRef.current = new Map();
            }
          } else scheduleOutboxFlush(200);
          return;
        } else {
          scheduleOutboxFlush(OUTBOX_REPLAY_INTERVAL_MS);
          return;
        }
        let sent = 0;
        const availableSlots = Math.min(
          OUTBOX_REPLAY_BATCH_SIZE,
          Math.max(0, OUTBOX_MAX_IN_FLIGHT - outboxInFlightRef.current.size),
        );
        for (const record of sendableRecords) {
          const eventKey = String(record.eventId || "");
          const capturedAt = Number(record.capturedAt) || 0;
          if (sent >= availableSlots || socket.bufferedAmount > 256 * 1024) break;
          outboxBackfillAtByEventRef.current.set(eventKey, capturedAt);
          outboxInFlightRef.current.set(record.packetId, Date.now());
          socket.send(JSON.stringify({
            type: "live_batch",
            room: LIVE_ROOM_ID,
            batch: record.batch,
            clientTime: record.capturedAt,
            clientSequence: record.clientSequence,
            packetId: record.packetId,
            eventId: record.eventId,
            backfill: true,
            persistOnly: true,
          }));
          sent += 1;
        }
        const earliestRetryAt = pendingRecords.reduce(
          (earliest, record) => Math.min(earliest, Number(outboxRetryAfterRef.current.get(record.packetId) || Infinity)),
          Infinity,
        );
        const retryDelay = Number.isFinite(earliestRetryAt)
          ? Math.min(5000, Math.max(500, earliestRetryAt - Date.now()))
          : 500;
        scheduleOutboxFlush(sent ? OUTBOX_REPLAY_INTERVAL_MS : retryDelay);
      } catch (error) {
        setLiveRelayState((current) => ({
          ...current,
          outboxError: `断网缓存扫描失败：${error.message || "IndexedDB 不可用"}`,
        }));
        scheduleOutboxFlush(3000);
      }
    }, Math.max(0, delayMs));
  }, [audience]);

  const queueAcknowledgedOutboxDelete = useCallback((packetId) => {
    if (!packetId) return;
    outboxInFlightRef.current.set(packetId, Number.POSITIVE_INFINITY);
    outboxAcknowledgedDeleteRef.current.add(packetId);
    if (outboxAcknowledgedDeleteTimerRef.current) return;
    outboxAcknowledgedDeleteTimerRef.current = window.setTimeout(() => {
      outboxAcknowledgedDeleteTimerRef.current = 0;
      const packetIds = [...outboxAcknowledgedDeleteRef.current];
      outboxAcknowledgedDeleteRef.current.clear();
      if (!packetIds.length) return;
      void deleteCachedLivePacket(packetIds)
        .then(() => {
          for (const acknowledgedPacketId of packetIds) {
            outboxInFlightRef.current.delete(acknowledgedPacketId);
            outboxRetryAfterRef.current.delete(acknowledgedPacketId);
            outboxOrphanedRef.current.delete(acknowledgedPacketId);
          }
          scheduleOutboxFlush(0);
        })
        .catch((error) => {
          for (const acknowledgedPacketId of packetIds) outboxInFlightRef.current.delete(acknowledgedPacketId);
          outboxRecoveringRef.current = true;
          outboxRecoveryCutoffSequenceRef.current = Math.max(
            Number(outboxRecoveryCutoffSequenceRef.current) || 0,
            liveClientSequenceRef.current,
          );
          outboxRecoveryCutoffCapturedAtRef.current = Math.max(
            Number(outboxRecoveryCutoffCapturedAtRef.current) || 0,
            Date.now(),
          );
          const outboxError = `断网缓存批量确认失败，将重试：${error.message || "IndexedDB 删除失败"}`;
          setLiveRelayState((current) => ({ ...current, outboxError }));
          scheduleOutboxFlush(500);
        });
    }, 40);
  }, [scheduleOutboxFlush]);

  async function clearConfirmedOrphanedPackets() {
    if (audience) return;
    const packetIds = [...outboxOrphanedRef.current.keys()];
    if (!packetIds.length) return;
    const confirmed = window.confirm(
      `确定清理 ${packetIds.length} 个已由服务器判定为孤儿的断网缓存包吗？\n\n该操作不会删除尚未确认或可以正常补传的数据，但删除后这些孤儿记录无法恢复。`,
    );
    if (!confirmed) return;
    try {
      await deleteCachedLivePacket(packetIds);
      for (const packetId of packetIds) {
        outboxInFlightRef.current.delete(packetId);
        outboxRetryAfterRef.current.delete(packetId);
        outboxOrphanedRef.current.delete(packetId);
      }
      setLiveRelayState((current) => ({
        ...current,
        outboxOrphaned: 0,
        outboxOrphanReason: "",
        outboxPending: Math.max(0, Number(current.outboxPending || 0) - packetIds.length),
      }));
      pushStatus(`已清理 ${packetIds.length} 个确认无归属的断网缓存包`);
      scheduleOutboxFlush(0);
    } catch (error) {
      const outboxError = `孤儿缓存清理失败：${error.message || "IndexedDB 删除失败"}`;
      setLiveRelayState((current) => ({ ...current, outboxError }));
      pushStatus(outboxError);
    }
  }

  const publishLivePacket = useCallback((packet, capturedAt = Date.now()) => {
    if (audience) return;
    const now = performance.now();
    const minIntervalMs = 30;
    liveRelayRef.current.minIntervalMs = minIntervalMs;
    liveRelayRef.current.lastSentAt = now;
    const batch = stripLocalSerialTelemetry(packet);
    const configuredActiveEventId = eventsRef.current.find((event) => event.active)?.id || "";
    // Once the server has confirmed that an event no longer exists, never let
    // stale React/event state keep creating new IndexedDB records for it.
    const activeEventId = outboxDiscardedEventIdsRef.current.has(configuredActiveEventId)
      ? ""
      : configuredActiveEventId;
    const persistenceSample = persistenceSampleRef.current;
    const shouldSendDurableFrame = Boolean(activeEventId) && (
      persistenceSample.eventId !== activeEventId
      || capturedAt - persistenceSample.capturedAt >= PERSISTENCE_SAMPLE_INTERVAL_MS
    );
    if (!activeEventId) {
      persistenceSample.eventId = "";
      persistenceSample.capturedAt = 0;
    }

    if (!shouldSendDurableFrame) {
      const socket = liveSocketRef.current;
      if (socket?.readyState === 1 && socket.bufferedAmount <= 256 * 1024) {
        socket.send(JSON.stringify({
          type: "live_batch",
          room: LIVE_ROOM_ID,
          batch,
          clientTime: capturedAt,
          liveOnly: true,
        }));
      }
    } else {
      const previousPersistenceAt = persistenceSample.eventId === activeEventId
        ? Number(persistenceSample.capturedAt || 0)
        : Math.max(0, capturedAt - PERSISTENCE_SAMPLE_INTERVAL_MS);
      persistenceSample.eventId = activeEventId;
      persistenceSample.capturedAt = capturedAt;
      liveClientSequenceRef.current += 1;
      const clientSequence = liveClientSequenceRef.current;
      try {
        window.localStorage.setItem(LIVE_SEQUENCE_STORAGE_KEY, String(clientSequence));
      } catch {
        // IndexedDB remains the source of truth for queued packet identifiers.
      }
      const packetId = `${liveSessionIdRef.current}:${clientSequence}`;
      // Persist a per-receiver latest-value snapshot. The hardware protocol is
      // allowed to emit partial batches, so sampling the current serial packet
      // alone can starve receivers when several are connected.
      const persistenceBatch = buildPersistenceSerialSnapshot(
        serialLatestRef.current,
        capturedAt,
        undefined,
        serialSamplesRef.current,
        previousPersistenceAt,
      ) || batch;
      const outgoing = {
        type: "live_batch",
        room: LIVE_ROOM_ID,
        batch: persistenceBatch,
        clientTime: capturedAt,
        clientSequence,
        packetId,
        eventId: activeEventId,
        liveOnly: true,
        durable: true,
      };
      outboxWriteChainRef.current = outboxWriteChainRef.current
        .catch(() => undefined)
        .then(async () => {
          // This task may have been queued before the event_not_found ACK. Test
          // again at execution time so an old write cannot land after cleanup.
          if (outboxDiscardedEventIdsRef.current.has(activeEventId)) return "discarded";
          try {
            await cacheLivePacket({ packetId, eventId: activeEventId, clientSequence, capturedAt, batch: persistenceBatch });
            setLiveRelayState((current) => (
              current.outboxError ? { ...current, outboxError: "" } : current
            ));
            return "cached";
          } catch (error) {
            const outboxError = `断网缓存写入失败：${error.message || "IndexedDB 不可用"}`;
            setLiveRelayState((current) => ({ ...current, outboxError }));
            pushStatus(outboxError);
            return "failed";
          }
        })
        .then((cacheStatus) => {
          if (cacheStatus === "discarded") return;
          const persistenceSocket = liveSocketRef.current;
          if (cacheStatus !== "cached") {
            // Online persistence can still succeed, but explicitly avoid
            // claiming offline safety when the durable browser copy failed.
            if (persistenceSocket?.readyState === 1 && persistenceSocket.bufferedAmount <= 256 * 1024) {
              persistenceSocket.send(JSON.stringify(outgoing));
            }
            return;
          }
          if (!shouldSendCurrentPersistence(persistenceSocket?.readyState, outboxRecoveringRef.current)) {
            outboxRecoveringRef.current = true;
            outboxRecoveryCutoffSequenceRef.current = Math.max(
              Number(outboxRecoveryCutoffSequenceRef.current) || 0,
              clientSequence,
            );
            outboxRecoveryCutoffCapturedAtRef.current = Math.max(
              Number(outboxRecoveryCutoffCapturedAtRef.current) || 0,
              capturedAt,
            );
            scheduleOutboxFlush(100);
            return;
          }
          // This is the selected 30 Hz live frame itself, upgraded with durable
          // metadata after it has reached IndexedDB. Recovery never holds this
          // current frame behind an old backlog; old records drain separately
          // as backfill + persistOnly packets.
          outboxInFlightRef.current.set(packetId, Date.now());
          persistenceSocket.send(JSON.stringify(outgoing));
          // If the TCP/WebSocket stack stays OPEN across a short network loss,
          // there may be no close event to clear this entry. The watchdog scan
          // retries any packet that has no server ACK after three seconds.
          scheduleOutboxFlush(OUTBOX_ACK_TIMEOUT_MS);
        });
    }
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
  }, [audience, scheduleOutboxFlush]);

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
        setLiveSyncVersion((value) => value + 1);
        const mode = audience ? "subscribe_live" : "publish_live";
        socket.send(JSON.stringify({
          type: mode,
          room: LIVE_ROOM_ID,
          afterSequence: audience ? audienceSequenceRef.current : 0,
        }));
        if (!audience) {
          outboxRecoveringRef.current = true;
          // Freeze the recovery generation at reconnect time. New 5 Hz packets
          // created after the socket reopens use larger client sequences and
          // must not keep the historical generation from ever becoming empty.
          outboxRecoveryCutoffSequenceRef.current = liveClientSequenceRef.current;
          outboxRecoveryCutoffCapturedAtRef.current = Date.now();
          outboxRecoveryWriteFenceRef.current = outboxWriteChainRef.current;
          outboxEmptyPassesRef.current = 0;
          outboxRecoveryHadRecordsRef.current = false;
          outboxBackfillAtByEventRef.current = new Map();
          scheduleOutboxFlush(0);
        }
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
        if (audience && message.streamId && message.streamId !== audienceStreamIdRef.current) {
          const streamChanged = Boolean(audienceStreamIdRef.current);
          audienceStreamIdRef.current = message.streamId;
          audienceSequenceRef.current = 0;
          if (streamChanged) setLiveSyncVersion((value) => value + 1);
        }
        if (!audience && message.type === "live_packet_ack" && message.packetId) {
          if (shouldDeleteOutboxPacketForAck(message)) {
            // Protect ACKed records immediately, then commit burst ACKs in one
            // IndexedDB transaction. Per-packet delete transactions throttled
            // recovery and could outlive the three-second watchdog.
            queueAcknowledgedOutboxDelete(message.packetId);
          } else {
            outboxInFlightRef.current.delete(message.packetId);
            if (shouldDiscardOrphanedOutboxPacket(message)) {
              const missingEventId = message.reason === "event_not_found"
                ? String(message.requestedEventId || "")
                : "";
              if (missingEventId) {
                outboxDiscardedEventIdsRef.current.add(missingEventId);
                if (!outboxDiscardCleanupInFlightRef.current.has(missingEventId)) {
                  outboxDiscardCleanupInFlightRef.current.add(missingEventId);
                  const writeFence = outboxWriteChainRef.current;
                  void writeFence.catch(() => undefined)
                    .then(() => deleteCachedLivePacketsByEventId(missingEventId))
                    .then((deleted) => {
                      for (const [packetId, orphan] of outboxOrphanedRef.current) {
                        if (orphan.requestedEventId !== missingEventId) continue;
                        outboxOrphanedRef.current.delete(packetId);
                        outboxRetryAfterRef.current.delete(packetId);
                      }
                      if (deleted > 0) pushStatus(`已自动清理已删除事件 ${missingEventId} 的 ${deleted} 个断网缓存包`);
                    })
                    .catch((error) => {
                      const retryDelay = outboxAckRetryDelay(message);
                      outboxRetryAfterRef.current.set(message.packetId, Date.now() + retryDelay);
                      outboxOrphanedRef.current.set(message.packetId, {
                        reason: message.reason || "event_not_found",
                        requestedEventId: missingEventId,
                        capturedAt: message.capturedAt || null,
                      });
                      const outboxError = `已删除事件缓存批量清理失败：${error.message || "IndexedDB 删除失败"}`;
                      setLiveRelayState((current) => ({ ...current, outboxError }));
                      scheduleOutboxFlush(Math.min(5000, retryDelay));
                    })
                    .finally(() => {
                      outboxDiscardCleanupInFlightRef.current.delete(missingEventId);
                      scheduleOutboxFlush(0);
                    });
                }
                return;
              }
              void deleteCachedLivePacket(message.packetId)
                .then(() => {
                  outboxRetryAfterRef.current.delete(message.packetId);
                  outboxOrphanedRef.current.delete(message.packetId);
                  scheduleOutboxFlush(50);
                })
                .catch((error) => {
                  const retryDelay = outboxAckRetryDelay(message);
                  outboxRetryAfterRef.current.set(message.packetId, Date.now() + retryDelay);
                  outboxOrphanedRef.current.set(message.packetId, {
                    reason: message.reason || "event_not_found",
                    requestedEventId: message.requestedEventId || "",
                    capturedAt: message.capturedAt || null,
                  });
                  const outboxError = `孤儿缓存自动清理失败：${error.message || "IndexedDB 删除失败"}`;
                  setLiveRelayState((current) => ({ ...current, outboxError }));
                  scheduleOutboxFlush(Math.min(5000, retryDelay));
                });
              return;
            }
            outboxRecoveringRef.current = true;
            outboxRecoveryCutoffSequenceRef.current = Math.max(
              Number(outboxRecoveryCutoffSequenceRef.current) || 0,
              Number(message.clientSequence) || 0,
            );
            outboxRecoveryCutoffCapturedAtRef.current = Math.max(
              Number(outboxRecoveryCutoffCapturedAtRef.current) || 0,
              Number(message.capturedAt) || 0,
            );
            const retryDelay = outboxAckRetryDelay(message);
            outboxRetryAfterRef.current.set(message.packetId, Date.now() + retryDelay);
            scheduleOutboxFlush(Math.min(5000, retryDelay));
          }
        }
        if (audience && message.type === "live_resync_required") {
          audienceSequenceRef.current = Math.max(audienceSequenceRef.current, Number(message.latestSequence) || 0);
          setLiveSyncVersion((value) => value + 1);
        }
        if (message.type === "live_timeline_patch" && message.eventId) {
          setLiveStateSeed((current) => {
            const currentEventId = current?.event?.id || current?.eventId || "";
            if (!current || (currentEventId && currentEventId !== message.eventId)) return current;
            return {
              ...current,
              eventId: message.eventId,
              updatedAt: Number(message.generatedAt || message.serverTime) || Date.now(),
              receivedAt: Date.now(),
              bandsByPilot: replaceLiveBandMapRange(
                current.bandsByPilot || {},
                message.bandsByPilot || {},
                message.replaceFrom,
                message.replaceTo,
              ),
              // The patch is applied to the complete join/REST baseline kept in
              // memory, so the resulting map is again a complete authoritative
              // view even if an earlier final-resync temporarily cleared the
              // completeness marker.
              bandsComplete: true,
            };
          });
        }
        if (message.type === "live_timeline_resync") {
          setLiveStateSeed((current) => {
            const currentEventId = current?.event?.id || current?.eventId || "";
            if (message.eventId && currentEventId && message.eventId !== currentEventId) return current;
            // The full snapshot received when this socket joined may predate
            // the just-finished backfill. Keep it on screen until REST/full
            // state arrives, but stop treating it as a newer authoritative
            // baseline that can overwrite the rebuilt historical gap.
            return current ? { ...current, bandsComplete: false } : current;
          });
          setLiveSyncVersion((value) => value + 1);
        }
        if (audience && message.type === "live_batch" && message.batch) {
          const sequence = Number(message.sequence) || 0;
          const previousSequence = audienceSequenceRef.current;
          if (sequence && sequence <= previousSequence) return;
          if (sequence) audienceSequenceRef.current = sequence;
          const sampleTime = Number(message.sampleTime || message.serverTime) || Date.now();
          // TCP/WebSocket can deliver buffered frames in a burst after a brief
          // outage. They belong in SQLite history, never in the current-stick
          // display. Keep only a fresh latest frame for the next paint.
          if (Date.now() - sampleTime > AUDIENCE_LIVE_STALE_MS) return;
          audiencePendingBatchRef.current = { batch: message.batch, sampleTime };
          if (!audienceBatchFrameRef.current) {
            audienceBatchFrameRef.current = window.requestAnimationFrame(() => {
              audienceBatchFrameRef.current = 0;
              const pending = audiencePendingBatchRef.current;
              audiencePendingBatchRef.current = null;
              if (!pending || Date.now() - pending.sampleTime > AUDIENCE_LIVE_STALE_MS) return;
              updateSerialFromPacket(pending.batch, JSON.stringify(pending.batch), pending.sampleTime);
            });
          }
        }
        if (!audience && message.type === "live_batch" && message.source === "virtual_receiver" && message.batch) {
          const capturedAt = message.sampleTime || message.serverTime || Date.now();
          setSerialState((current) => ({
            ...current,
            supported: true,
            connected: true,
            connecting: false,
            portName: "虚拟测试阵列",
            baudRate: 115200,
            error: "",
          }));
          updateSerialFromPacket(message.batch, JSON.stringify(message.batch), capturedAt);
        }
        if (message.type === "live_state" && message.state) {
          const latest = message.state.latestSamplesByReceiver || {};
          const now = Date.now();
          const hasAuthoritativeStats = Boolean(message.state.serverManaged || message.state.summaries || message.state.bandsByPilot);
          if (hasAuthoritativeStats) {
            setLiveStateSeed((current) => {
              const next = { ...message.state, receivedAt: now };
              const currentEventId = current?.event?.id || current?.eventId || "";
              const nextEventId = next.event?.id || next.eventId || "";
              const sameEvent = Boolean(currentEventId && currentEventId === nextEventId);
              const receivedCompleteTimeline = Boolean(next.bandsByPilot);
              // Normal server heartbeats contain only the recent SQLite suffix.
              // Accumulate each suffix into the last complete join/reconnect
              // timeline. Merely preserving the original full snapshot made
              // older suffixes fall out of the rolling window and briefly
              // disappear from the rendered history.
              const baselineBands = next.bandsByPilot || (sameEvent ? current?.bandsByPilot : null) || {};
              next.bandsByPilot = mergeLiveBandMaps(baselineBands, next.bandUpdatesByPilot || {});
              next.bandsComplete = receivedCompleteTimeline || Boolean(sameEvent && current?.bandsComplete);
              return next;
            });
          }
          if (audience && !serialStateRef.current?.lastDataAt && Object.keys(latest).length) {
            serialLatestRef.current = latest;
            requestSerialRender();
          }
          if (audience && Array.isArray(message.state.events)) {
            setEvents((current) => (sameEvents(current, message.state.events) ? current : message.state.events));
          } else if (audience && message.state.event?.id) {
            setEvents((current) => {
              const liveEvent = { ...message.state.event, active: Boolean(message.state.event.active) };
              const next = current.map((eventItem) => (
                eventItem.id === liveEvent.id ? liveEvent : { ...eventItem, active: false }
              ));
              const merged = next.some((eventItem) => eventItem.id === liveEvent.id) ? next : [liveEvent, ...next];
              return sameEvents(current, merged) ? current : merged;
            });
          } else if (audience) {
            setEvents((current) => {
              const next = current.map((eventItem) => ({ ...eventItem, active: false }));
              return sameEvents(current, next) ? current : next;
            });
          }
          const relayReceiverState = message.state.receiverState || {};
          if (audience && Object.keys(relayReceiverState).length) {
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
          } else if (audience) {
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
        if (!audience) {
          outboxRecoveringRef.current = true;
          outboxRecoveryCutoffSequenceRef.current = Math.max(
            Number(outboxRecoveryCutoffSequenceRef.current) || 0,
            liveClientSequenceRef.current,
          );
          outboxRecoveryCutoffCapturedAtRef.current = Math.max(
            Number(outboxRecoveryCutoffCapturedAtRef.current) || 0,
            Date.now(),
          );
          outboxRecoveryWriteFenceRef.current = outboxWriteChainRef.current;
          outboxInFlightRef.current.clear();
        }
        pushStatus("实时中继连接异常");
        setLiveRelayState((current) => ({ ...current, error: "实时中继连接异常" }));
      });

      socket.addEventListener("close", () => {
        if (liveSocketRef.current === socket) liveSocketRef.current = null;
        outboxInFlightRef.current.clear();
        outboxBackfillAtByEventRef.current = new Map();
        setLiveRelayState((current) => ({ ...current, connected: false }));
        if (!stopped) reconnectTimer = window.setTimeout(connectLiveSocket, 2000);
      });
    }

    connectLiveSocket();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (outboxFlushTimerRef.current) window.clearTimeout(outboxFlushTimerRef.current);
      if (outboxAcknowledgedDeleteTimerRef.current) window.clearTimeout(outboxAcknowledgedDeleteTimerRef.current);
      if (audienceBatchFrameRef.current) window.cancelAnimationFrame(audienceBatchFrameRef.current);
      outboxFlushTimerRef.current = 0;
      outboxFlushDueAtRef.current = 0;
      outboxAcknowledgedDeleteTimerRef.current = 0;
      audienceBatchFrameRef.current = 0;
      audiencePendingBatchRef.current = null;
      liveSocketRef.current?.close();
      liveSocketRef.current = null;
    };
  }, [audience, queueAcknowledgedOutboxDelete, requestSerialRender, scheduleOutboxFlush, updateSerialFromPacket]);

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

    function handleSerialConnect() {
      if (manualSerialDisconnectRef.current) return;
      // A flight controller can re-enumerate with the same 0483:5740 VID/PID
      // as TRAINING_HUB. Never replace a healthy receiver-array connection just
      // because another STM32 serial device appeared; run the normal claimed /
      // preferred-port selection only when the array is actually disconnected.
      if (portRef.current || serialConnectInFlightRef.current) return;
      scheduleAutoConnect(300);
    }

    function handleSerialDisconnect(event) {
      if (event.target !== portRef.current) return;
      void releaseSerialResources({ clear: true, error: "Serial disconnected", preserveSamples: true });
      scheduleAutoConnect(800);
    }

    function handlePageHide() {
      void releaseSerialResources({ clear: false });
    }

    navigator.serial.addEventListener("connect", handleSerialConnect);
    navigator.serial.addEventListener("disconnect", handleSerialDisconnect);
    window.addEventListener("pagehide", handlePageHide);
    scheduleAutoConnect(0);
    const retryInterval = window.setInterval(() => {
      if (!stopped) void autoConnectSerialArray();
    }, 2000);

    return () => {
      stopped = true;
      if (serialReconnectTimerRef.current) window.clearTimeout(serialReconnectTimerRef.current);
      window.clearInterval(retryInterval);
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
    let jsonBuffer = "";
    serialLoopRef.current = true;
    while (serialLoopRef.current && port.readable) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        while (serialLoopRef.current) {
          const { value, done } = await reader.read();
          if (done) break;
          const decoded = decoder.decode(value, { stream: true });
          const consumed = consumeSerialJsonStream(jsonBuffer, decoded);
          jsonBuffer = consumed.buffer;
          for (const parsed of consumed.frames) {
            const capturedAt = Date.now();
            updateSerialFromPacket(parsed.packet, parsed.line, capturedAt);
            publishLivePacket(parsed.packet, capturedAt);
          }
          // A leading tail after USB reconnect is discarded silently. Only a
          // complete, balanced object that is still invalid JSON is an actual
          // protocol error worth surfacing.
          for (const failedFrame of consumed.failures.slice(-1)) {
            const preview = failedFrame.replace(/\s+/g, " ").slice(0, 80);
            pushStatus(`串口 JSON 解析失败：${preview}`);
            setSerialState((current) => ({ ...current, error: `串口 JSON 解析失败：${preview}` }));
          }
        }
      } catch (error) {
        if (serialLoopRef.current) {
          try {
            reader.releaseLock();
          } catch {
            // The stream may already have released its lock after a USB drop.
          }
          if (readerRef.current === reader) readerRef.current = null;
          await releaseSerialResources({
            clear: true,
            error: `串口读取失败，正在自动重连：${error.message}`,
            preserveSamples: true,
          });
          return;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The error path above may already have released the lock.
        }
        if (readerRef.current === reader) readerRef.current = null;
      }
      if (!serialLoopRef.current) break;
    }
    if (portRef.current === port) {
      await releaseSerialResources({ clear: true, error: "串口已断开，正在自动重连", preserveSamples: true });
    }
  }

  async function connectSerialArray() {
    if (!navigator.serial) {
      pushStatus("当前浏览器不支持 Web Serial，请使用 Edge/Chrome 的 localhost 或 HTTPS 页面");
      setSerialState((current) => ({ ...current, supported: false, error: "当前浏览器不支持 Web Serial，请使用 Edge/Chrome 的 localhost 或 HTTPS 页面" }));
      return;
    }
    try {
      manualSerialDisconnectRef.current = false;
      // Manual selection deliberately shows all ports so a com0com test pair can
      // be selected. Automatic reconnection remains restricted to TRAINING_HUB.
      const port = await navigator.serial.requestPort();
      if (await isBetaflightSerialPortClaimed(port)) {
        throw new Error("所选串口正在被内置 BF 使用，请选择 TRAINING_HUB 或先断开 BF");
      }
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
    if (serialStateRef.current?.portName === "虚拟测试阵列") {
      setSerialState((current) => ({ ...current, error: "", lastCommand: `BIND:${receiverId}（测试模拟）` }));
      return;
    }
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
    ["skill-tree", "技能树管理"],
    ["pilots", "飞手档案"],
    ["events", "事件和系统"],
    ["tracks", "赛道管理"],
    ["monitor", "实时监测"],
    ["coach", "AI助教"],
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

  function updateAnnouncerSetting(key, value) {
    setAnnouncerSettings((current) => ({ ...current, [key]: value }));
  }

  function settingCheckbox(key, label) {
    return (
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155", fontWeight: 800 }}>
        <input
          type="checkbox"
          checked={Boolean(announcerSettings[key])}
          onChange={(event) => updateAnnouncerSetting(key, event.target.checked)}
        />
        {label}
      </label>
    );
  }

  function settingNumber(key, label, suffix = "分钟", min = 1) {
    return (
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b", minWidth: 0 }}>
        <span>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="number"
            min={min}
            value={announcerSettings[key]}
            onChange={(event) => updateAnnouncerSetting(key, Number(event.target.value) || min)}
            style={{ width: 66, height: 28, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 8px" }}
          />
          <span>{suffix}</span>
        </span>
      </label>
    );
  }

  function settingRange(key, label, min, max, step) {
    return (
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b", minWidth: 130 }}>
        <span>{label}: {Number(announcerSettings[key]).toFixed(step < 1 ? 1 : 0)}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={announcerSettings[key]}
          onChange={(event) => updateAnnouncerSetting(key, Number(event.target.value))}
        />
      </label>
    );
  }

  function speakTestAnnouncement() {
    const now = Date.now();
    const message = "语音播报测试，当前音色已应用";
    setAnnouncements((current) => [{ time: now, message }, ...current].slice(0, 30));
    speakAnnouncementText(message, { force: true });
  }

  function renderAnnouncementPanel() {
    const latestAnnouncement = announcements[0]?.message || coachSuggestedMessages[0]?.message || "暂无事件";
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
        <input
          readOnly
          value={latestAnnouncement}
          title={latestAnnouncement}
          style={{
            height: 36,
            borderRadius: 10,
            border: "1px solid #d4d4d8",
            padding: "0 10px",
            background: "#fff",
            color: latestAnnouncement.includes("丢失") || latestAnnouncement.includes("偏慢") ? "#b91c1c" : "#334155",
            boxSizing: "border-box",
            width: "100%",
            minWidth: 0,
          }}
        />
        <details style={{ position: "relative", flex: "0 0 auto" }}>
          <summary style={{ ...buttonStyle, height: 36, display: "inline-flex", alignItems: "center", listStyle: "none" }}>
            播报
          </summary>
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 42,
              width: "min(520px, calc(100vw - 36px))",
              maxHeight: 460,
              overflow: "auto",
              border: "1px solid #d4d4d8",
              borderRadius: 12,
              background: "#fff",
              boxShadow: "0 12px 28px rgba(15,23,42,.14)",
              padding: 10,
              zIndex: 20,
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <strong style={{ fontSize: 13, color: "#0f172a" }}>事件播报</strong>
              <span style={{ fontSize: 12, color: announcements.length ? "#047857" : "#64748b", fontWeight: 800 }}>{announcerSettings.enabled ? "已启用" : "已关闭"}</span>
            </div>
            <div style={{ display: "grid", gap: 6, maxHeight: 130, overflow: "auto" }}>
              {announcements.length === 0 && <div style={{ color: "#64748b", fontSize: 13 }}>暂无事件</div>}
              {announcements.map((item) => (
                <div key={`${item.time}-${item.message}`} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 8, padding: "7px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                  <span style={{ color: "#64748b" }}>{formatStatusLogTime(item.time)}</span>
                  <span style={{ color: item.message.includes("丢失") || item.message.includes("偏慢") ? "#b91c1c" : "#334155" }}>{item.message}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gap: 6, marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10, maxHeight: 160, overflow: "auto" }}>
              <strong style={{ fontSize: 13, color: "#0f172a" }}>AI 建议</strong>
              {coachSuggestedMessages.length === 0 && <div style={{ color: "#64748b", fontSize: 13 }}>暂无 AI 建议</div>}
              {coachSuggestedMessages.map((item) => (
                <div key={`${item.generatedAt}-${item.pilotId}-${item.message}`} style={{ display: "grid", gridTemplateColumns: "76px 1fr auto", gap: 8, alignItems: "center", padding: "7px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                  <span style={{ color: "#64748b" }}>{formatStatusLogTime(item.generatedAt)}</span>
                  <span style={{ color: item.priority === "high" ? "#b91c1c" : item.priority === "medium" ? "#b45309" : "#334155" }}>
                    {item.pilotName ? `${item.pilotName}：` : ""}{item.message}
                  </span>
                  <button
                    type="button"
                    disabled={!item.speakable}
                    onClick={() => speakAnnouncementText(item.message, { force: true })}
                    style={{ ...buttonStyle, height: 28, minHeight: 28, padding: "0 8px", opacity: item.speakable ? 1 : 0.5 }}
                  >
                    播放
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gap: 10, marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {settingCheckbox("enabled", "事件播报")}
                {settingCheckbox("ttsEnabled", "TTS 语音")}
                {settingCheckbox("aiTtsEnabled", "AI建议自动播报")}
                {settingNumber("aiTtsMinIntervalMs", "AI播报间隔", "ms", 1000)}
                <button type="button" style={{ ...buttonStyle, minHeight: 30, padding: "4px 10px" }} onClick={speakTestAnnouncement}>
                  试听
                </button>
              </div>
              <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
                <span>语音音色</span>
                <select
                  value={announcerSettings.ttsVoiceURI || announcerSettings.ttsVoiceName}
                  onChange={(event) => {
                    const selected = ttsVoices.find((voice) => voiceValue(voice) === event.target.value || voice.name === event.target.value);
                    setAnnouncerSettings((current) => ({
                      ...current,
                      ttsVoiceName: selected?.name || "",
                      ttsVoiceURI: selected ? voiceValue(selected) : "",
                    }));
                  }}
                  style={{ height: 32, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 8px", maxWidth: "100%" }}
                >
                  <option value="">浏览器默认</option>
                  {ttsVoices.map((voice) => (
                    <option key={`${voiceValue(voice)}-${voice.lang}`} value={voiceValue(voice)}>
                      {voice.name} ({voice.lang})
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {settingRange("ttsRate", "语速", 0.6, 1.4, 0.1)}
                {settingRange("ttsPitch", "音调", 0.7, 1.5, 0.1)}
                {settingRange("ttsVolume", "音量", 0.2, 1, 0.1)}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                {settingCheckbox("ttsWarmupEnabled", "蓝牙预热")}
                {settingNumber("ttsWarmupIdleMs", "空闲超过", "ms", 0)}
                {settingNumber("ttsWarmupMs", "预热时长", "ms", 0)}
              </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {settingCheckbox("longIdleEnabled", "长时间未起飞")}
              {settingNumber("longIdleMinutes", "阈值")}
              {settingNumber("longIdleCooldownMinutes", "冷却")}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {settingCheckbox("turtleEnabled", "连续 Turtle")}
              {settingNumber("turtleCountThreshold", "次数", "次", 1)}
              {settingNumber("turtleWindowMinutes", "窗口")}
              {settingNumber("turtleCooldownMinutes", "冷却")}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {settingCheckbox("longFlightEnabled", "长时间飞行")}
              {settingNumber("longFlightMinutes", "阈值")}
              {settingNumber("longFlightCooldownMinutes", "冷却")}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {settingCheckbox("receiverOfflineEnabled", "接收机离线")}
              {settingNumber("receiverOfflineCooldownMinutes", "冷却")}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {settingCheckbox("slowPaceEnabled", "节奏提醒")}
              {settingNumber("slowPaceMinutes", "观察")}
              {settingNumber("slowPaceUtilizationPct", "利用率低于", "%", 1)}
              {settingNumber("slowPaceCooldownMinutes", "冷却")}
            </div>
          </div>
          </div>
        </details>
      </div>
    );
  }

  function renderStatusLogBar() {
    const ingest = csvWriteStatus?.ingest || null;
    const ingestHistoryLagMs = ingest?.lastPersistedSampleTime
      ? Math.max(0, Number(ingest.lastProcessedAt || Date.now()) - Number(ingest.lastPersistedSampleTime))
      : 0;
    const ingestHasPersistenceMetrics = ingest && Object.hasOwn(ingest, "lastPacketPersistedSamples");
    const ingestNoActiveEvent = Boolean(ingest?.lastPacketNoActiveEvent);
    const ingestUnassignedReceiverIds = Array.isArray(ingest?.lastPacketUnassignedReceiverIds)
      ? ingest.lastPacketUnassignedReceiverIds
      : [];
    const ingestMissingPilotIds = Array.isArray(ingest?.lastPacketMissingPilotIds)
      ? ingest.lastPacketMissingPilotIds
      : [];
    const ingestHasNoMapping = Boolean(
      !ingestNoActiveEvent
      && ingest?.lastPacketRawSamples > 0
      && ingest?.lastPacketMappedSamples === 0,
    );
    const ingestIsStalled = Boolean(
      ingestHasPersistenceMetrics
      && ingest?.lastPacketMappedSamples > 0
      && ingestHistoryLagMs > 3000,
    );
    const ingestIsBacklogged = Boolean(ingest?.oldestQueuedMs > 1000 || ingestIsStalled);
    const ingestStatusText = ingestIsBacklogged
      ? `历史尾部落后 ${formatHistoryLag(ingestHistoryLagMs)}`
      : ingestNoActiveEvent
        ? "尚未开始事件，实时显示正常，历史暂停"
      : ingestHasNoMapping
        ? ingestUnassignedReceiverIds.length
          ? `接收机未加入当前事件：${ingestUnassignedReceiverIds.join("、")}`
          : ingestMissingPilotIds.length
            ? "事件中的飞手档案不存在"
            : "当前事件没有可映射的飞手"
        : ingest?.backfillQueuedPackets
          ? `当前入库正常，后台补传 ${ingest.backfillQueuedPackets} 包`
          : "正常";
    const ingestStatusColor = ingestIsBacklogged || ingestHasNoMapping
      ? "#b91c1c"
      : ingestNoActiveEvent || ingest?.backfillQueuedPackets
        ? "#b45309"
        : "#15803d";
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 10, alignItems: "start", marginTop: 10, width: "100%", maxWidth: 920, marginLeft: "auto", marginRight: "auto" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", minWidth: 0 }}>
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
              width: "100%",
              minWidth: 0,
            }}
          />
          <details style={{ position: "relative", flex: "0 0 auto" }}>
            <summary style={{ ...buttonStyle, height: 36, display: "inline-flex", alignItems: "center", listStyle: "none" }}>
              日志
            </summary>
            <div
              style={{
                position: "absolute",
                right: 0,
                top: 42,
                width: "min(420px, calc(100vw - 36px))",
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
              {csvWriteStatus && (
                <div style={{ display: "grid", gap: 7, marginBottom: 8, borderBottom: "1px solid #e5e7eb", paddingBottom: 8, fontSize: 12, color: "#475569" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ color: ingestStatusColor }}>历史入库：{ingestStatusText}</strong>
                    <span>当前 {ingest?.lastPacketPersistedSamples ?? "-"}/{ingest?.lastPacketMappedSamples || 0} 路 · 队列 {ingest?.currentQueuedPackets || 0}/{ingest?.backfillQueuedPackets || 0}</span>
                  </div>
                  {!audience && (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ color: liveRelayState.outboxError ? "#b91c1c" : liveRelayState.outboxRecovering ? "#b45309" : "#15803d" }}>
                        本地缓存：{liveRelayState.outboxError
                          || (liveRelayState.outboxRecovering
                            ? `${liveRelayState.outboxOldestEventId
                              && liveRelayState.outboxNewestEventId
                              && liveRelayState.outboxOldestEventId !== liveRelayState.outboxActiveEventId
                              && liveRelayState.outboxNewestEventId !== liveRelayState.outboxActiveEventId
                              ? "清理旧事件缓存"
                              : "恢复中"} ${liveRelayState.outboxPendingMore ? "至少 " : ""}${liveRelayState.outboxPending || 0} 包`
                            : "正常")}
                      </strong>
                      <span>累计恢复 {ingest?.backfillProcessedPackets || 0} 包 · 渐进 {ingest?.backfillProgressPublishCount || 0} 次 · 校准 {ingest?.backfillFinalizedCount || 0} 次</span>
                    </div>
                  )}
                  {csvWriteStatus.audienceDownload && (
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ color: audiencePressureColor(csvWriteStatus.audienceDownload.pressureLevel) }}>
                        观众压力：{audiencePressureText(csvWriteStatus.audienceDownload.pressureLevel)} · {csvWriteStatus.audienceDownload.audienceCount || 0} 人
                      </strong>
                      <span>{formatBitRate(csvWriteStatus.audienceDownload.bitsPerSecond)} · 积压 {formatBytes(csvWriteStatus.audienceDownload.bufferedBytes)}</span>
                    </div>
                  )}
                  {liveRelayState.outboxOrphaned > 0 && !audience && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", color: "#b91c1c" }}>
                      <span>孤儿缓存清理失败 {liveRelayState.outboxOrphaned} 包</span>
                      <button type="button" onClick={() => { void clearConfirmedOrphanedPackets(); }} style={{ ...buttonStyle, minHeight: 28, padding: "4px 10px", color: "#b91c1c", borderColor: "#fecaca" }}>
                        手动清理
                      </button>
                    </div>
                  )}
                  {csvWriteStatus.lastError && <span style={{ color: "#b91c1c" }}>{csvWriteStatus.lastError}</span>}
                  <details style={{ borderTop: "1px dashed #cbd5e1", paddingTop: 6 }}>
                    <summary style={{ cursor: "pointer", color: "#475569", fontWeight: 800 }}>数据链路详情</summary>
                    <div style={{ display: "grid", gap: 4, marginTop: 7, overflowWrap: "anywhere" }}>
                      <span>CSV：队列 {csvWriteStatus.queuedRows || 0} 行 / {formatBytes(csvWriteStatus.queuedBytes)}；文件 {formatBytes(csvWriteStatus.fileSizeBytes)}；已写 {csvWriteStatus.writtenRows || 0} 行；最近 {csvWriteStatus.lastFlushMs || 0} ms</span>
                      <span>入库：队列最老 {ingest?.oldestQueuedMs || 0} ms；实时合并 {ingest?.compactedCurrentPackets ?? ingest?.supersededPackets ?? 0} 包；处理 {ingest?.lastProcessMs || 0}/{ingest?.maxProcessMs || 0} ms</span>
                      <span>恢复：落库 {ingest?.backfillPersistedSamples || 0} 路；重复 {ingest?.backfillDuplicatePackets || 0}；孤儿 {ingest?.backfillOrphanedPackets || 0}；渐进计算 {ingest?.lastBackfillProgressMs || 0}/{ingest?.maxBackfillProgressMs || 0} ms；最终校准 {ingest?.lastBackfillFinalizeMs || 0}/{ingest?.maxBackfillFinalizeMs || 0} ms</span>
                      <span style={{ color: Number(ingest?.lastTimelineGapCount || 0) > 0 ? "#b91c1c" : "#475569" }}>最终样本：{ingest?.lastTimelineSampleCount || 0} 路；超过1秒缺口 {ingest?.lastTimelineGapCount || 0} 个；最大间隔 {ingest?.lastTimelineMaxGapMs || 0} ms</span>
                      <span>最近恢复：{ingest?.lastBackfillProcessedAt ? formatStatusLogTime(ingest.lastBackfillProcessedAt) : "无"}；ACK {ingest?.lastBackfillAckStatus || "-"}；采集 {ingest?.lastBackfillCapturedAt ? formatStatusLogTime(ingest.lastBackfillCapturedAt) : "-"}；原因 {ingest?.lastBackfillRejectReason || "无"}</span>
                      <span>事件：请求 {ingest?.lastBackfillRequestedEventId || "-"}；活动 {ingest?.lastBackfillActiveEventId || "-"}；解析 {ingest?.lastBackfillEventId || "-"}（{ingest?.lastBackfillResolvedBy || "未解析"}）</span>
                      {!audience && <span>缓存事件：{liveRelayState.outboxEventGroups || "无"}；3秒未收到ACK自动重发。</span>}
                      {csvWriteStatus.audienceDownload && <span>观众：上限 {csvWriteStatus.audienceDownload.targetLiveFps || 30} Hz/人；丢弃旧帧 {csvWriteStatus.audienceDownload.skippedMessages || 0} 包；容量 {Number(csvWriteStatus.audienceDownload.capacityMbps || 3).toFixed(1)} Mbps。</span>}
                    </div>
                  </details>
                </div>
              )}
              {statusLog.map((item) => (
                <div key={`${item.time}-${item.message}`} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 8, padding: "7px 4px", borderBottom: "1px solid #f1f5f9", fontSize: 13 }}>
                  <span style={{ color: "#64748b" }}>{formatStatusLogTime(item.time)}</span>
                  <span style={{ color: item.message.includes("失败") || item.message.includes("异常") ? "#b91c1c" : "#334155" }}>{item.message}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
        {renderAnnouncementPanel()}
      </div>
    );
  }

  if (audience) {
    return (
      <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", background: "#f5f7fb", padding: "clamp(10px, 4vw, 20px)", fontFamily: "'Microsoft YaHei',Arial,sans-serif", letterSpacing: 0, color: "#111827" }}>
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
            {bracketLive && onOpenBracket && (
              <button type="button" className="live-jump-button" style={buttonStyle} onClick={onOpenBracket} title="查看正在进行的双败淘汰赛">
                <span className="live-status-dot" aria-hidden="true" />
                比赛进行中
              </button>
            )}
          </div>
        </header>
        <div style={{ display: "grid", gap: 14 }}>
          <MonitorPage pilots={pilots} events={events} latestSamplesRef={serialLatestRef} sampleQueuesRef={serialSamplesRef} renderTick={serialRenderTick} inputFps={serialInputFps} stateSeed={liveStateSeed} resyncToken={liveSyncVersion} audience={audience} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", width: "100%", maxWidth: "100%", overflowX: "hidden", boxSizing: "border-box", background: "#f5f7fb", padding: "clamp(10px, 4vw, 20px)", fontFamily: "'Microsoft YaHei',Arial,sans-serif", letterSpacing: 0, color: "#111827" }}>
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

      {tab === "skill-tree" && <SkillTreePage />}
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
      {tab === "tracks" && <TrackManagementPage />}
      <div style={{ display: tab === "monitor" ? "block" : "none" }}>
        <MonitorPage pilots={pilots} events={events} latestSamplesRef={serialLatestRef} sampleQueuesRef={serialSamplesRef} renderTick={serialRenderTick} inputFps={serialInputFps} stateSeed={liveStateSeed} resyncToken={liveSyncVersion} />
      </div>
      {tab === "coach" && <CoachPage />}
      {tab === "history" && <HistoryPage events={events} onEventUpdated={(updatedEvent) => {
        if (!updatedEvent?.id) return;
        setEvents((current) => {
          const nextEvents = current.map((event) => (event.id === updatedEvent.id ? updatedEvent : event));
          eventsRef.current = nextEvents;
          publishTrainingState(nextEvents);
          return nextEvents;
        });
      }} onDeleteEvent={async (eventId) => {
        outboxDiscardedEventIdsRef.current.add(String(eventId || ""));
        setEvents((current) => {
          const nextEvents = current.filter((event) => event.id !== eventId);
          eventsRef.current = nextEvents;
          publishTrainingState(nextEvents);
          return nextEvents;
        });
        try {
          // The server delete has already succeeded. Wait for every local write
          // that was queued before the click, then remove this event in one
          // IndexedDB transaction so no stale packet survives into the next
          // training event.
          await outboxWriteChainRef.current.catch(() => undefined);
          const deleted = await deleteCachedLivePacketsByEventId(eventId);
          for (const [packetId, orphan] of outboxOrphanedRef.current) {
            if (String(orphan?.requestedEventId || "") !== String(eventId || "")) continue;
            outboxInFlightRef.current.delete(packetId);
            outboxRetryAfterRef.current.delete(packetId);
            outboxOrphanedRef.current.delete(packetId);
          }
          scheduleOutboxFlush(0);
          pushStatus(`历史事件已删除，本地缓存同步清理 ${deleted} 包`);
        } catch (error) {
          const outboxError = `历史事件已删除，但本地缓存清理失败：${error.message || "IndexedDB 删除失败"}`;
          setLiveRelayState((current) => ({ ...current, outboxError }));
          pushStatus(outboxError);
        }
      }} />}
    </div>
  );
}
