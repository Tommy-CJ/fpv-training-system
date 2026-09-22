import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiDelete, apiGet, apiPost, formatClock, formatDuration, inputStyle, isValueInRanges, panelStyle, primaryButtonStyle } from "../trainingShared.js";
import { getCoachPassword, setCoachPassword, validateCoachPassword } from "../authConfig.js";

const CHANNEL_MIN = 1000;
const CHANNEL_MID = 1500;
const CHANNEL_MAX = 2000;
const HOUR_MS = 60 * 60 * 1000;
const TIME_WINDOW_OPTIONS = [15 * 60000, 30 * 60000, HOUR_MS, 2 * HOUR_MS];
const STATS_INTERVAL_MS = 1000;
const BAND_RENDER_INTERVAL_MS = 200;
const MAX_SAMPLE_GAP_MS = 1000;
const INITIAL_NOW = Date.now();
const MAX_RENDER_SAMPLES = 1800;
const RECENT_SAMPLE_WINDOW_MS = 6000;

const monitorPanelStyle = {
  ...panelStyle,
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  borderRadius: 22,
  padding: 18,
  border: "1px solid rgba(226,232,240,.9)",
  background: "rgba(255,255,255,.92)",
  boxShadow: "none",
  backdropFilter: "blur(12px)",
};

const controlGridStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(52px,.65fr) minmax(118px,1.8fr) minmax(52px,.65fr)",
  gap: 8,
  alignItems: "center",
  justifyContent: "end",
  width: "100%",
  minWidth: 0,
};

const controlDisplayStyle = {
  ...inputStyle,
  height: 46,
  minWidth: 0,
  padding: "0 12px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  whiteSpace: "nowrap",
  borderRadius: 14,
  background: "#f8fafc",
  color: "#334155",
  fontSize: "clamp(11px, 3.2vw, 13px)",
  boxSizing: "border-box",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const monitorButtonStyle = {
  ...primaryButtonStyle,
  height: 46,
  minWidth: 0,
  border: "none",
  borderRadius: 14,
  padding: "0 10px",
  fontSize: "clamp(12px, 3.2vw, 14px)",
  background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
  boxShadow: "0 8px 20px rgba(37,99,235,.22)",
};

function normalizeStick(value) {
  return Math.max(-1, Math.min(1, (value - CHANNEL_MID) / (CHANNEL_MAX - CHANNEL_MID)));
}

function normalizeThrottle(value) {
  return Math.max(0, Math.min(1, (value - CHANNEL_MIN) / (CHANNEL_MAX - CHANNEL_MIN)));
}

const StickBox = memo(function StickBox({ title, x, y }) {
  const size = 92;
  const dotSize = 15;
  const px = size / 2 + x * (size / 2 - 13);
  const py = size / 2 - y * (size / 2 - 13);

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontWeight: 900, marginBottom: 7, fontSize: 13, color: "#334155" }}>{title}</div>
      <div style={{ width: size, height: size, borderRadius: 18, border: "1px solid #d4d4d8", background: "radial-gradient(circle at center,#fff 0%,#f8fafc 72%)", position: "relative", boxShadow: "inset 0 1px 8px rgba(15,23,42,.08)" }}>
        <div style={{ position: "absolute", left: size / 2, top: 9, bottom: 9, width: 1, background: "#d4d4d8" }} />
        <div style={{ position: "absolute", top: size / 2, left: 9, right: 9, height: 1, background: "#d4d4d8" }} />
        <div style={{ position: "absolute", left: px - dotSize / 2, top: py - dotSize / 2, width: dotSize, height: dotSize, borderRadius: "50%", background: "#2563eb", boxShadow: "0 0 0 5px rgba(37,99,235,.16), 0 8px 18px rgba(37,99,235,.25)" }} />
      </div>
    </div>
  );
});

function getRanges(config, type) {
  const entries = [];
  Object.entries(config || {}).forEach(([channelKey, ranges]) => {
    (ranges || []).forEach((range) => {
      if (range.type === type) entries.push({ ...range, channelKey });
    });
  });
  return entries;
}

function getModeName(pilot, sample) {
  const channels = sample?.channels || {};
  const modeRanges = getRanges(pilot.channelConfig || {}, "mode");
  return modeRanges.find((range) => isValueInRanges(channels[range.channelKey], [range]))?.name || "Acro";
}

function getPilotState(pilot, sample, recentSamples) {
  const channels = sample?.channels || {};
  const config = pilot.channelConfig || {};
  const armRanges = getRanges(config, "arm");
  const turtleRanges = getRanges(config, "turtle");
  const armed = armRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const turtleSwitch = turtleRanges.some((range) => isValueInRanges(channels[range.channelKey], [range]));
  const throttleValues = recentSamples.map((item) => item.channels?.ch3).filter((value) => Number.isFinite(value));
  const throttleSpread = throttleValues.length ? Math.max(...throttleValues) - Math.min(...throttleValues) : 0;
  return { armed, turtleSwitch, turtle: armed && turtleSwitch, flying: armed && throttleSpread > 80, throttleSpread };
}

function stateFromSample(sample) {
  if (!sample) return null;
  return sample?.turtle ? "turtle" : sample?.flying ? "flying" : "idle";
}

function segmentTypeFromState(state) {
  if (state === "flying") return "flight";
  if (state === "turtle") return "turtle";
  return "idle";
}

function bandStateFromSegmentType(type) {
  if (type === "flight") return "flying";
  if (type === "turtle") return "turtle";
  return "idle";
}

function appendBand(bands, state, start, end) {
  if (!state || end <= start) return bands;
  const previous = bands[bands.length - 1];
  if (previous && previous.state === state && start - previous.end <= MAX_SAMPLE_GAP_MS) {
    previous.end = Math.max(previous.end, end);
    return bands;
  }
  bands.push({ state, start, end });
  return bands;
}

function bandsFromSegments(segments = []) {
  return segments
    .map((segment) => ({
      state: bandStateFromSegmentType(segment.type),
      start: segment.started_at ?? segment.startedAt,
      end: segment.ended_at ?? segment.endedAt,
    }))
    .filter((band) => Number.isFinite(band.start) && Number.isFinite(band.end) && band.end > band.start)
    .sort((a, b) => a.start - b.start);
}

function sampleFromBand(band, time, pilotId, receiverId, latestSample) {
  return {
    ...(latestSample || {}),
    time,
    pilotId,
    receiverId,
    armed: band.state === "flying" || band.state === "turtle",
    flying: band.state === "flying",
    turtle: band.state === "turtle",
  };
}

function optionalTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getParticipantTrainingWindow(eventStart, participant, now = Date.now()) {
  const start = Math.max(eventStart, optionalTimestamp(participant?.trainingStartAt) || eventStart);
  const end = Math.max(start, optionalTimestamp(participant?.trainingEndAt) || now);
  return { start, end };
}

function samplesFromLiveState(seed, pilotId, receiverId) {
  const storedSamples = seed?.samplesByPilot?.[pilotId];
  if (storedSamples?.length) {
    return storedSamples
      .filter((sample) => Number(sample.receiverId) === Number(receiverId))
      .map((sample) => ({ ...sample, pilotId, receiverId }))
      .sort((a, b) => a.time - b.time);
  }
  const latestSample = seed?.latestSamplesByReceiver?.[receiverId] || null;
  if (!latestSample) return [];
  const bands = seed?.bandsByPilot?.[pilotId] || [];
  const restored = [];
  for (const band of bands) {
    for (let time = band.start; time < band.end; time += MAX_SAMPLE_GAP_MS) {
      restored.push(sampleFromBand(band, time, pilotId, receiverId, latestSample));
    }
    restored.push(sampleFromBand(band, band.end, pilotId, receiverId, latestSample));
  }
  if (latestSample) restored.push({ ...latestSample, pilotId, receiverId });
  return restored.sort((a, b) => a.time - b.time);
}

function getRenderableBands(bands, windowStart, windowMs) {
  const windowEnd = windowStart + windowMs;
  const visible = bands
    .filter((band) => band.end >= windowStart && band.start <= windowEnd)
    .map((band) => ({
      ...band,
      start: Math.max(windowStart, band.start),
      end: Math.min(windowEnd, band.end),
    }))
    .filter((band) => band.end > band.start)
    .sort((left, right) => left.start - right.start);

  // Normalize first. The old renderer dropped every Nth whole band after the
  // limit, which literally painted white holes inside a continuous flight.
  // Adjacent equal states now become one interval before any visual reduction.
  const normalized = [];
  for (const band of visible) appendBand(normalized, band.state, band.start, band.end);
  if (normalized.length <= MAX_RENDER_SAMPLES) return normalized;

  // More intervals than screen pixels cannot be represented faithfully as
  // individual SVG rectangles. Aggregate by pixel occupancy instead of
  // deleting intervals, preserving continuous coverage without fake gaps.
  const bucketCount = 960;
  const bucketMs = windowMs / bucketCount;
  const states = ["idle", "flying", "turtle"];
  const coverage = Object.fromEntries(states.map((state) => [state, new Float64Array(bucketCount)]));
  for (const band of normalized) {
    const stateCoverage = coverage[band.state];
    if (!stateCoverage) continue;
    const firstBucket = Math.max(0, Math.min(bucketCount - 1, Math.floor((band.start - windowStart) / bucketMs)));
    const lastBucket = Math.max(0, Math.min(bucketCount - 1, Math.floor((Math.max(band.start, band.end - 0.001) - windowStart) / bucketMs)));
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const bucketStart = windowStart + bucket * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      stateCoverage[bucket] += Math.max(0, Math.min(band.end, bucketEnd) - Math.max(band.start, bucketStart));
    }
  }

  const rendered = [];
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    let state = null;
    let duration = 0;
    for (const candidate of states) {
      if (coverage[candidate][bucket] > duration) {
        duration = coverage[candidate][bucket];
        state = candidate;
      }
    }
    if (!state || duration <= 0) continue;
    appendBand(
      rendered,
      state,
      windowStart + bucket * bucketMs,
      windowStart + (bucket + 1) * bucketMs,
    );
  }
  return rendered;
}

function getRecentSamples(samples, since) {
  let index = samples.length - 1;
  while (index >= 0 && samples[index].time >= since) index -= 1;
  return samples.slice(index + 1);
}

function mergeAuthoritativeBandsWithLiveTail(authoritativeBands = [], liveBands = []) {
  if (!authoritativeBands.length) return liveBands;
  if (!liveBands.length) return authoritativeBands;

  const authoritative = authoritativeBands
    .filter((band) => Number(band?.end) > Number(band?.start))
    .map((band) => ({ ...band }))
    .sort((left, right) => left.start - right.start);
  const coverage = [];
  for (const band of authoritative) {
    const previous = coverage[coverage.length - 1];
    if (previous && band.start <= previous.end) previous.end = Math.max(previous.end, band.end);
    else coverage.push({ start: band.start, end: band.end });
  }

  // Server bands are authoritative wherever they exist. The local 30 Hz tail
  // is still allowed to fill any uncovered interval, including a temporary
  // hole *before* the latest server end. The old implementation discarded all
  // local bands ending before the maximum server timestamp, which made a
  // rolling server-update gap flash white until the next heartbeat repaired it.
  const uncoveredLive = [];
  let coverageIndex = 0;
  const sortedLive = liveBands
    .filter((band) => Number(band?.end) > Number(band?.start))
    .sort((left, right) => left.start - right.start);
  for (const band of sortedLive) {
    while (coverageIndex < coverage.length && coverage[coverageIndex].end <= band.start) coverageIndex += 1;
    let cursor = band.start;
    let index = coverageIndex;
    while (index < coverage.length && coverage[index].start < band.end) {
      const covered = coverage[index];
      if (covered.start > cursor) {
        uncoveredLive.push({ ...band, start: cursor, end: Math.min(covered.start, band.end) });
      }
      cursor = Math.max(cursor, covered.end);
      if (cursor >= band.end) break;
      index += 1;
    }
    if (cursor < band.end) uncoveredLive.push({ ...band, start: cursor, end: band.end });
  }

  const merged = [];
  for (const band of [...authoritative, ...uncoveredLive].sort((left, right) => left.start - right.start)) {
    appendBand(merged, band.state, band.start, band.end);
  }
  return merged;
}

function mergeAuthoritativeBandUpdates(existingBands = [], updates = []) {
  if (!updates.length) return existingBands;
  const sortedUpdates = [...updates].sort((left, right) => left.start - right.start);
  const replaceFrom = sortedUpdates[0].start;
  const merged = [];
  for (const band of existingBands) {
    if (band.end <= replaceFrom) {
      merged.push({ ...band });
    } else if (band.start < replaceFrom) {
      // An incremental update may start in the middle of a long existing
      // segment. Keep its untouched prefix instead of deleting the whole band.
      appendBand(merged, band.state, band.start, replaceFrom);
    }
  }
  for (const band of sortedUpdates) appendBand(merged, band.state, band.start, band.end);
  return merged;
}

function mergeAuthoritativeBandMaps(existingByPilot = {}, updatesByPilot = {}) {
  const merged = { ...existingByPilot };
  for (const [pilotId, updates] of Object.entries(updatesByPilot || {})) {
    if (!updates?.length) continue;
    merged[pilotId] = mergeAuthoritativeBandUpdates(merged[pilotId] || [], updates);
  }
  return merged;
}

function mergeSummaryMapsByFreshness(first = {}, second = {}) {
  const merged = { ...first };
  for (const [pilotId, summary] of Object.entries(second || {})) {
    const existing = merged[pilotId];
    if (!existing || Number(summary?.updatedAt || 0) >= Number(existing?.updatedAt || 0)) {
      merged[pilotId] = summary;
    }
  }
  return merged;
}

const Waveform = memo(function Waveform({ bands, windowStart, windowMs, currentTime }) {
  const width = 960;
  const chartHeight = 120;
  const markerHeight = 34;
  const stateBands = getRenderableBands(bands || [], windowStart, windowMs);
  const cursorX = currentTime >= windowStart && currentTime <= windowStart + windowMs
    ? ((currentTime - windowStart) / windowMs) * width
    : null;

  const colorByState = { turtle: "#fed7aa", flying: "#bbf7d0", idle: "#f1f5f9" };
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index / tickCount);

  return (
    <div style={{ overflowX: "auto", paddingBottom: 2 }}>
      <div style={{ minWidth: "min(560px, 100%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 12, marginBottom: 8, whiteSpace: "nowrap" }}>
          {ticks.map((position) => (
            <span key={position}>{formatClock(windowStart + windowMs * position)}</span>
          ))}
        </div>
        <svg viewBox={`0 0 ${width} ${chartHeight + markerHeight}`} width="100%" height="132" preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
          <defs>
            <clipPath id="waveClip">
              <rect x="0" y="0" width={width} height={chartHeight} rx="16" ry="16" />
            </clipPath>
          </defs>
          <rect x="0" y="0" width={width} height={chartHeight} rx="16" ry="16" fill="#fff" stroke="#e5e7eb" strokeWidth="1" />
          {stateBands.map((band, index) => {
            const x = ((band.start - windowStart) / windowMs) * width;
            const bandWidth = Math.max(1, ((band.end - band.start) / windowMs) * width);
            return <rect key={`${band.state}-${index}`} x={x} y="0" width={bandWidth} height={chartHeight} fill={colorByState[band.state]} clipPath="url(#waveClip)" />;
          })}
          {ticks.map((position) => {
            const x = position * width;
            return (
              <g key={position}>
                <line x1={x} x2={x} y1={chartHeight - 12} y2={chartHeight} stroke="#475569" strokeWidth="1.5" />
                <line x1={x} x2={x} y1="0" y2="8" stroke="#94a3b8" strokeWidth="1" />
              </g>
            );
          })}
          {cursorX !== null && (
            <g>
              <line x1={cursorX} x2={cursorX} y1="0" y2={chartHeight} stroke="#facc15" strokeWidth="2" strokeDasharray="4 4" opacity="0.9" />
              <polygon
                points={`${cursorX},${chartHeight + 4} ${cursorX - 8},${chartHeight + 18} ${cursorX + 8},${chartHeight + 18}`}
                fill="#facc15"
                stroke="#a16207"
                strokeWidth="1.5"
              />
              <text x={Math.min(width - 46, Math.max(14, cursorX + 12))} y={chartHeight + 18} textAnchor="start" fill="#854d0e" fontSize="13" fontWeight="700">当前</text>
            </g>
          )}
        </svg>
      </div>
    </div>
  );
});

const MetricBadge = memo(function MetricBadge({ label, value, tone = "#334155" }) {
  return (
    <span style={{ flex: "1 1 118px", minWidth: 0, padding: "10px 12px", borderRadius: 999, background: "#f8fafc", border: "1px solid #e2e8f0", color: tone, fontWeight: 900, fontSize: "clamp(13px, 3.4vw, 15px)", lineHeight: 1.2, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, whiteSpace: "nowrap", boxSizing: "border-box" }}>
      <span>{label}:</span>
      <span>{value}</span>
    </span>
  );
});

function formatPhotoTimestamp(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "时间未知";
  const hours = date.getHours();
  const period = hours < 12 ? "AM" : "PM";
  const hour = String(hours % 12 || 12).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${period} ${hour}:${minute}`;
}

function formatMonitorDuration(ms, compact = false) {
  if (!ms || ms < 0) return "0秒";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (compact && minutes > 0) {
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
    return `${minutes}m`;
  }
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds ? `${seconds}s` : ""}`;
  return `${seconds}s`;
}

function makeEmptySummary(pilotId) {
  return { pilotId, totalFlightMs: 0, utilization: 0, idleMs: null, lastFlightEndedAt: null, totalTurtleMs: 0, segments: [] };
}

function pilotStateLabel(state) {
  if (state.turtle) return "反乌龟";
  if (state.flying) return "飞行中";
  if (state.armed) return "已解锁";
  return "待机";
}

function summaryFromSeedSummary(seedSummary, trainingStart, trainingEnd, now) {
  if (!seedSummary) return null;
  const updatedAt = Number(seedSummary.updatedAt || now);
  const lastFlightEndedAt = Number(seedSummary.lastFlightEndedAt || 0) || null;
  const idleMs = lastFlightEndedAt === null
    ? (seedSummary.idleMs ?? null)
    : Math.max(0, now - lastFlightEndedAt);
  const totalFlightMs = Number(seedSummary.totalFlightMs || 0);
  const utilizationWindowEnd = Math.min(trainingEnd || updatedAt, updatedAt);
  const inferredUtilizationFlightMs = Number(seedSummary.utilization || 0)
    * Math.max(1, utilizationWindowEnd - trainingStart);
  return {
    pilotId: seedSummary.pilotId,
    totalFlightMs,
    utilization: Number.isFinite(Number(seedSummary.utilization))
      ? Number(seedSummary.utilization)
      : totalFlightMs / Math.max(1, Math.min(now, trainingEnd || now) - trainingStart),
    utilizationFlightMs: Number.isFinite(Number(seedSummary.utilizationFlightMs))
      ? Number(seedSummary.utilizationFlightMs)
      : inferredUtilizationFlightMs,
    idleMs,
    lastFlightEndedAt,
    totalTurtleMs: Number(seedSummary.totalTurtleMs || 0),
    updatedAt,
  };
}

function buildCoachBoardItems({ participants, pilotById, latestSamplesRef, effectiveStateSeed, eventStart, now, pilotLiveState, eventId }) {
  return participants
    .map((participant) => {
      const pilot = pilotById.get(participant.pilotId);
      if (!pilot) return null;
      const latest = latestSamplesRef?.current?.[participant.receiverId] || {};
      const receiverOnline = Boolean(latest.time && now - Number(latest.time || 0) < 1500);
      const paired = Boolean(receiverOnline && (latest.lq > 0 || latest.rssi > -127));
      const state = getPilotState(pilot, latest, latest.time ? [latest] : []);
      const stateOverride = pilotLiveState?.[participant.pilotId]?.eventId === eventId ? pilotLiveState[participant.pilotId] : null;
      const displayState = stateOverride?.state || state;
      const trainingWindow = getParticipantTrainingWindow(eventStart, participant, now);
      const seededSummary = summaryFromSeedSummary(effectiveStateSeed?.summaries?.[participant.pilotId], trainingWindow.start, trainingWindow.end, now);
      const summary = stateOverride?.summary || seededSummary || makeEmptySummary(participant.pilotId);
      const flightSegments = (effectiveStateSeed?.bandsByPilot?.[participant.pilotId] || []).filter((band) => band.state === "flying");
      return {
        pilotId: participant.pilotId,
        pilotName: pilot.name || participant.pilotId,
        videoChannel: participant.videoChannel || "",
        receiverId: participant.receiverId,
        state: displayState,
        stateLabel: stateOverride?.stateLabel || pilotStateLabel(displayState),
        utilization: summary.utilization || 0,
        totalFlightMs: summary.totalFlightMs || 0,
        totalTurtleMs: summary.totalTurtleMs || 0,
        idleMs: summary.idleMs ?? null,
        flightCount: flightSegments.length,
        paired: stateOverride?.paired ?? paired,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.utilization - left.utilization || left.pilotName.localeCompare(right.pilotName, "zh-CN"));
}

async function trainingPhotoDataUrl(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("请选择图片文件");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("图片读取失败"));
      image.src = objectUrl;
    });
    const maxEdge = 1920;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function TrainingMediaGallery({ eventId, audience = false }) {
  const [media, setMedia] = useState([]);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [previewBounds, setPreviewBounds] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [canEdit, setCanEdit] = useState(() => !audience || Boolean(getCoachPassword()));
  const uploadInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const previewStageRef = useRef(null);

  const loadMedia = useCallback(async () => {
    if (!eventId) return;
    const payload = await apiGet(`/api/training-events/${encodeURIComponent(eventId)}/media`, { media: [] });
    setMedia(Array.isArray(payload?.media) ? payload.media : []);
  }, [eventId]);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (!stopped) await loadMedia();
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [loadMedia]);

  useEffect(() => {
    function updateAuth() {
      setCanEdit(!audience || Boolean(getCoachPassword()));
    }
    window.addEventListener("coach-auth-changed", updateAuth);
    updateAuth();
    return () => window.removeEventListener("coach-auth-changed", updateAuth);
  }, [audience]);

  useEffect(() => {
    if (cameraOpen && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
      void videoRef.current.play().catch(() => {});
    }
  }, [cameraOpen]);

  useEffect(() => {
    if (!previewMedia) return undefined;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event) {
      if (event.key === "Escape") setPreviewMedia(null);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [previewMedia]);

  useEffect(() => {
    if (!previewMedia || !previewStageRef.current) return undefined;
    const stage = previewStageRef.current;
    function updatePreviewBounds() {
      const nextBounds = {
        width: Math.max(1, stage.clientWidth - 2),
        height: Math.max(1, stage.clientHeight - 2),
      };
      setPreviewBounds((current) => (
        current.width === nextBounds.width && current.height === nextBounds.height
          ? current
          : nextBounds
      ));
    }
    updatePreviewBounds();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updatePreviewBounds) : null;
    observer?.observe(stage);
    window.addEventListener("resize", updatePreviewBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePreviewBounds);
    };
  }, [previewMedia]);

  function stopCamera() {
    cameraStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOpen(false);
  }

  useEffect(() => () => {
    cameraStreamRef.current?.getTracks?.().forEach((track) => track.stop());
  }, []);

  async function uploadDataUrl(dataUrl, caption = "", capturedAt = Date.now()) {
    setUploading(true);
    setStatus("正在上传训练实况...");
    try {
      const result = await apiPost(`/api/training-events/${encodeURIComponent(eventId)}/media`, {
        dataUrl,
        caption,
        capturedAt,
      });
      setMedia(Array.isArray(result?.media) ? result.media : []);
      setStatus("训练实况已更新");
    } catch (error) {
      setStatus(`上传失败：${error.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    try {
      const dataUrl = await trainingPhotoDataUrl(file);
      await uploadDataUrl(dataUrl, file.name || "训练实况", Number(file.lastModified) || Date.now());
    } catch (error) {
      setStatus(error.message || "图片读取失败");
    }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraInputRef.current?.click();
      return;
    }
    try {
      stopCamera();
      cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setCameraOpen(true);
      setStatus("");
    } catch (error) {
      setStatus(`无法打开相机：${error.message}`);
      cameraInputRef.current?.click();
    }
  }

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) return setStatus("相机画面尚未准备好");
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    const capturedAt = Date.now();
    stopCamera();
    await uploadDataUrl(dataUrl, "现场拍摄", capturedAt);
  }

  async function removeMedia(item) {
    if (!window.confirm("删除这张训练实况图片？")) return;
    try {
      const result = await apiDelete(`/api/training-events/${encodeURIComponent(eventId)}/media/${encodeURIComponent(item.id)}`);
      setMedia(Array.isArray(result?.media) ? result.media : []);
      setPreviewMedia((current) => current?.id === item.id ? null : current);
      setStatus("图片已删除");
    } catch (error) {
      setStatus(`删除失败：${error.message}`);
    }
  }

  return (
    <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 12, paddingTop: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <strong style={{ color: "#0f172a", fontSize: 15 }}>训练实况</strong>
          <span style={{ marginLeft: 8, color: "#64748b", fontSize: 11 }}>{media.length ? `${media.length} 张` : "暂无图片"}</span>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" style={{ ...monitorButtonStyle, height: 30, borderRadius: 8, padding: "0 10px", fontSize: 12 }} onClick={startCamera} disabled={uploading}>拍照</button>
            <button type="button" style={{ ...monitorButtonStyle, height: 30, borderRadius: 8, padding: "0 10px", fontSize: 12, background: "#475569" }} onClick={() => uploadInputRef.current?.click()} disabled={uploading}>上传</button>
            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={(event) => { void uploadFile(event.target.files?.[0]); event.target.value = ""; }} />
            <input ref={uploadInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(event) => { void uploadFile(event.target.files?.[0]); event.target.value = ""; }} />
          </div>
        )}
      </div>
      {cameraOpen && (
        <div style={{ display: "grid", gap: 8, border: "1px solid #bfdbfe", borderRadius: 10, padding: 8, background: "#eff6ff" }}>
          <video ref={videoRef} playsInline muted style={{ width: "100%", maxHeight: 360, objectFit: "contain", borderRadius: 8, background: "#0f172a" }} />
          <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
            <button type="button" style={{ ...monitorButtonStyle, height: 34 }} onClick={capturePhoto}>拍摄并上传</button>
            <button type="button" style={{ ...monitorButtonStyle, height: 34, background: "#64748b" }} onClick={stopCamera}>取消</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, overflowX: "auto", overscrollBehaviorX: "contain", scrollSnapType: "x proximity", paddingBottom: 4 }}>
        {media.map((item) => (
          <figure key={item.id} style={{ flex: "0 0 clamp(190px,30vw,300px)", margin: 0, position: "relative", scrollSnapAlign: "start", borderRadius: 10, overflow: "hidden", background: "#0f172a" }}>
            <button type="button" aria-label="预览训练实况图片" onClick={() => { setPreviewRotation(0); setPreviewBounds({ width: 0, height: 0 }); setPreviewMedia(item); }} style={{ display: "block", width: "100%", padding: 0, border: 0, background: "transparent", cursor: "zoom-in" }}>
              <img src={item.url} alt={item.caption || "训练实况"} loading="lazy" style={{ width: "100%", height: 145, display: "block", objectFit: "cover", background: "#e2e8f0" }} />
              <time style={{ position: "absolute", right: 7, bottom: 6, padding: "2px 6px", borderRadius: 999, color: "#fff", background: "rgba(15,23,42,.68)", fontSize: 11, lineHeight: 1.4, whiteSpace: "nowrap", pointerEvents: "none", textShadow: "0 1px 2px rgba(0,0,0,.5)" }}>{formatPhotoTimestamp(item.capturedAt)}</time>
            </button>
            {canEdit && <button type="button" aria-label="删除图片" onClick={() => removeMedia(item)} style={{ position: "absolute", top: 6, right: 6, width: 26, height: 26, border: 0, borderRadius: 999, background: "rgba(15,23,42,.72)", color: "#fff", cursor: "pointer", fontWeight: 900 }}>×</button>}
          </figure>
        ))}
      </div>
      {status && <div style={{ color: status.includes("失败") || status.includes("无法") ? "#b91c1c" : "#64748b", fontSize: 11 }}>{status}</div>}
      {previewMedia && createPortal(
        <div role="dialog" aria-modal="true" aria-label="训练实况图片预览" onClick={() => setPreviewMedia(null)} style={{ position: "fixed", inset: 0, zIndex: 1600, display: "grid", placeItems: "center", padding: 0, boxSizing: "border-box", background: "rgba(2,6,23,.88)", cursor: "zoom-out" }}>
          <div ref={previewStageRef} onClick={(event) => event.stopPropagation()} style={{ position: "relative", width: "100%", height: "100%", display: "grid", placeItems: "center", minWidth: 0, minHeight: 0, overflow: "hidden", cursor: "default" }}>
            <img
              src={previewMedia.url}
              alt={previewMedia.caption || "训练实况"}
              style={{
                display: "block",
                position: "absolute",
                left: "50%",
                top: "50%",
                width: "auto",
                height: "auto",
                maxWidth: previewRotation % 180 ? previewBounds.height : previewBounds.width,
                maxHeight: previewRotation % 180 ? previewBounds.width : previewBounds.height,
                objectFit: "contain",
                transform: `translate(-50%, -50%) rotate(${previewRotation}deg)`,
                transformOrigin: "50% 50%",
                transition: "transform .2s ease",
                willChange: "transform",
                visibility: previewBounds.width && previewBounds.height ? "visible" : "hidden",
              }}
            />
            <time style={{ position: "absolute", right: 10, bottom: 10, zIndex: 1, padding: "4px 8px", borderRadius: 999, color: "#fff", background: "rgba(15,23,42,.7)", fontSize: 12, whiteSpace: "nowrap", textShadow: "0 1px 2px rgba(0,0,0,.5)" }}>{formatPhotoTimestamp(previewMedia.capturedAt)}</time>
            <button type="button" aria-label="顺时针旋转图片" title="旋转图片" onClick={() => setPreviewRotation((rotation) => rotation + 90)} style={{ position: "absolute", top: 10, right: 52, zIndex: 1, width: 34, height: 34, padding: 0, border: 0, borderRadius: 999, display: "grid", placeItems: "center", background: "rgba(15,23,42,.72)", color: "#fff", cursor: "pointer", lineHeight: 1 }}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
            <button type="button" aria-label="关闭图片预览" onClick={() => setPreviewMedia(null)} style={{ position: "absolute", top: 10, right: 10, zIndex: 1, width: 34, height: 34, padding: 0, border: 0, borderRadius: 999, display: "grid", placeItems: "center", background: "rgba(15,23,42,.72)", color: "#fff", cursor: "pointer", lineHeight: 1 }}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function CoachBoard({ items, eventId, eventStart, clock, audience = false, onPilotSelect }) {
  return (
    <section style={{ ...monitorPanelStyle, boxShadow: "none", padding: 12, borderRadius: 14 }}>
      <style>
        {`
          .coach-board-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(max(116px, calc((100% - 32px) / 5)), 1fr));
            gap: 7px;
          }
          @media (max-width: 640px) {
            .coach-board-grid {
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 5px;
            }
            .coach-stat-label {
              font-size: 8px !important;
            }
            .coach-stat-value {
              font-size: 8px !important;
            }
          }
        `}
      </style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12}}>
        <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left",color: "#0f172a" }}>🏁 训练总览</h2>
      </div>
      <div className="coach-board-grid">
        {items.map((item, index) => {
          const tone = item.state.turtle ? "#ea580c" : item.state.flying ? "#059669" : item.state.armed ? "#2563eb" : "#94a3b8";
          const softTone = item.state.turtle ? "#fff7ed" : item.state.flying ? "#ecfdf5" : item.state.armed ? "#eff6ff" : "#f8fafc";
          const totalFlight = formatMonitorDuration(item.totalFlightMs);
          const totalFlightCompact = formatMonitorDuration(item.totalFlightMs, true);
          const lastGap = item.state.flying ? "飞行中" : item.idleMs === null || item.idleMs === undefined ? "暂无" : formatMonitorDuration(item.idleMs);
          const lastGapCompact = item.state.flying ? "飞行中" : item.idleMs === null || item.idleMs === undefined ? "暂无" : formatMonitorDuration(item.idleMs, true);
          const rankBg = item.paired ? "#dbeafe" : "#e5e7eb";
          const rankColor = item.paired ? "#1d4ed8" : "#64748b";
          return (
            <button type="button" key={item.pilotId} aria-label={`跳转到${item.pilotName}的实时监测`} title={`查看 ${item.pilotName}`} onClick={() => onPilotSelect?.(item.pilotId)} style={{ border: "1px solid #e2e8f0", borderRadius: 7, padding: 5, background: `linear-gradient(180deg, ${softTone}, #fff 62%)`, boxShadow: "none", minWidth: 0, width: "100%", color: "inherit", font: "inherit", textAlign: "initial", cursor: "pointer" }}>
              <div style={{ display: "grid", gridTemplateColumns: "16px minmax(0,1fr) auto", gap: 4, alignItems: "center", minWidth: 0 }}>
                <span style={{ width: 16, height: 16, borderRadius: 5, background: rankBg, color: rankColor, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 950, lineHeight: 1 }}>{index + 1}</span>
                <strong style={{ color: "#0f172a", fontSize: 11.5, lineHeight: 1.05, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{item.pilotName}</strong>
                <span style={{ color: "#2563eb", background: "#dbeafe", borderRadius: 5, padding: "1px 4px", fontSize: 9.5, fontWeight: 900, lineHeight: 1 }}>{item.videoChannel || "-"}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, marginTop: 1, color: tone, fontSize: 9.5, fontWeight: 900, minWidth: 0 }}>
                <span style={{ width: 5, height: 5, borderRadius: 999, background: tone, flex: "0 0 auto" }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.stateLabel}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 3, marginTop: 1 }}>
                {[
                  ["飞行", totalFlight, totalFlightCompact],
                  ["利用", `${Math.round(item.utilization * 100)}%`],
                  ["间隔", lastGap, lastGapCompact],
                ].map(([label, value, compactValue]) => (
                  <div key={label} style={{ border: "1px solid #e2e8f0", borderRadius: 5, background: "rgba(255,255,255,.82)", padding: "2px 1px", textAlign: "center", minWidth: 0 }}>
                    <div className="coach-stat-label" style={{ color: "#64748b", fontSize: 9.5, lineHeight: 1 }}>{label}</div>
                    <div className="coach-stat-value" title={value} data-compact={compactValue || value} style={{ color: "#0f172a", fontSize: 11, fontWeight: 950, lineHeight: 1.05, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: 0 }}>{compactValue || value}</div>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
      <TrainingMediaGallery eventId={eventId} audience={audience} />
      <CoachTaskList eventId={eventId} eventStart={eventStart} clock={clock} audience={audience} />
    </section>
  );
}

function WeatherAlert({ eventId }) {
  const [weather, setWeather] = useState(null);
  const [error, setError] = useState("");

  function submitBroadcastEvent(event) {
    window.dispatchEvent(new CustomEvent("training-broadcast-event", { detail: event }));
  }

  useEffect(() => {
    if (!eventId) return undefined;
    let stopped = false;
    async function loadWeather() {
      const configPayload = await apiGet(`/api/training-events/${encodeURIComponent(eventId)}/weather-config`, null);
      const config = configPayload?.config || {};
      if (!config.longitude || !config.latitude) {
        if (!stopped) {
          setWeather(null);
          setError("");
        }
        return;
      }
      const params = new URLSearchParams({
        lon: String(config.longitude),
        lat: String(config.latitude),
      });
      const result = await apiGet(`/api/weather/minutely?${params.toString()}`, null);
      if (stopped) return;
      if (!result) {
        setError("天气数据暂不可用");
        return;
      }
      setWeather(result);
      setError("");
      if (result.shouldBroadcast && result.broadcastText) {
        submitBroadcastEvent({ type: "weather_alert", text: result.broadcastText });
      }
    }
    loadWeather();
    const timer = window.setInterval(loadWeather, 180000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [eventId]);

  if (error) {
    return (
      <div style={{ border: "1px solid #fee2e2", borderRadius: 12, background: "#fff7ed", padding: "8px 10px", color: "#b91c1c", fontSize: 13, fontWeight: 800 }}>
        {error}
      </div>
    );
  }
  if (!weather) return null;
  const color = weather.riskLevel === "high" ? "#b91c1c" : weather.riskLevel === "watch" ? "#b45309" : "#047857";
  const bars = (weather.minutely || []).slice(0, 24);
  const maxPrecip = Math.max(0.1, ...bars.map((item) => Number(item.precip || 0)));
  const ticks = [maxPrecip, maxPrecip / 2, 0];
  const firstRainIndex = bars.findIndex((item) => Number(item.precip || 0) > 0);
  const stopRainIndex = firstRainIndex >= 0 ? bars.findIndex((item, index) => index > firstRainIndex && Number(item.precip || 0) <= 0) : -1;
  const rainStartsText = firstRainIndex >= 0 ? `${firstRainIndex * 5}分钟后` : "2小时内无降水";
  const rainStopsText = firstRainIndex < 0 ? "--" : stopRainIndex >= 0 ? `${stopRainIndex * 5}分钟后` : "2小时后仍可能";
  const statusText = weather.riskLevel === "high" ? "降水明显" : weather.riskLevel === "watch" ? "可能降雨" : "天气正常";
  const updateText = (() => {
    if (!weather.updateTime) return "--";
    const match = String(weather.updateTime).match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (match) return `${Number(match[1])}-${Number(match[2])} ${match[3]}:${match[4]}`;
    const date = new Date(weather.updateTime);
    if (Number.isNaN(date.getTime())) return String(weather.updateTime).slice(0, 16);
    return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  })();
  return (
    <div style={{ border: "1px solid #dbeafe", borderRadius: 12, background: "#eff6ff", padding: 9, color: "#0f172a", display: "grid", gap: 7, boxShadow: "none" }}>
      <style>
        {`
          @media (max-width: 640px) {
            .weather-alert-metrics {
              grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            }
          }
        `}
      </style>
      <div className="weather-alert-metrics" style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 6, alignItems: "center" }}>
        {[
          ["当前状态", statusText, color],
          ["开始下雨", rainStartsText, "#0f172a"],
          ["预计停雨", rainStopsText, "#0f172a"],
          ["更新时间", updateText, "#64748b"],
        ].map(([label, value, valueColor]) => (
          <div key={label} style={{ minWidth: 0, border: "1px solid #dbeafe", borderRadius: 8, background: "#fff", padding: "5px 6px" }}>
            <div style={{ color: "#64748b", fontSize: 10, lineHeight: 1.1 }}>{label}</div>
            <strong style={{ display: "block", color: valueColor, fontSize: 12, lineHeight: 1.2, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</strong>
          </div>
        ))}
      </div>
      <div style={{ border: "1px solid #dbeafe", borderRadius: 9, background: "#fff", padding: 7, display: "grid", gap: 5 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <strong style={{ fontSize: 12 }}>未来2小时降水</strong>
          <span style={{ color: "#64748b", fontSize: 11 }}>{weather.precip15}mm / 15min · {weather.precip30}mm / 30min</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "34px minmax(0,1fr)", gridTemplateRows: "86px 20px", gap: "4px 6px", minWidth: 0 }}>
          <div style={{ gridColumn: 1, gridRow: 1, position: "relative", color: "#64748b", fontSize: 10 }}>
            {ticks.map((tick, index) => (
              <span key={index} style={{ position: "absolute", right: 0, top: index === 0 ? 0 : index === 1 ? "calc(50% - 6px)" : "calc(100% - 12px)" }}>
                {index === 1 ? "" : tick.toFixed(tick >= 1 ? 1 : 2)}
              </span>
            ))}
          </div>
          <div style={{ gridColumn: 2, gridRow: 1, position: "relative", minWidth: 0, padding: "0 8px", boxSizing: "border-box" }}>
            {[0, 0.5, 1].map((ratio) => (
              <div key={ratio} style={{ position: "absolute", left: 8, right: 8, top: `${ratio * 100}%`, borderTop: "1px solid #e2e8f0" }} />
            ))}
            <div style={{ position: "relative", height: "100%", display: "flex", gap: 3, alignItems: "end", minWidth: 0 }}>
              {bars.map((item) => {
                const precip = Number(item.precip || 0);
                const height = Math.max(3, Math.round((precip / maxPrecip) * 78));
                return (
                  <div key={item.time} title={`${item.time ? item.time.slice(11, 16) : ""} ${precip}mm`} style={{ flex: "1 1 0", minWidth: 0, height: "100%", display: "flex", alignItems: "end", justifyContent: "center" }}>
                    <div style={{ width: "72%", maxWidth: 14, minWidth: 3, height, borderRadius: "4px 4px 0 0", background: precip > 0 ? "#2563eb" : "#cbd5e1" }} />
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ gridColumn: 2, gridRow: 2, display: "flex", gap: 3, minWidth: 0, padding: "0 8px", boxSizing: "border-box", alignItems: "start" }}>
            {bars.map((item, index) => {
              const label = `${index * 5}`;
              return (
                <div key={`${item.time}-${index}`} style={{ flex: "1 1 0", minWidth: 0, textAlign: index === bars.length - 1 ? "right" : index === 0 ? "left" : "center", color: "#64748b", fontSize: 10, overflow: "visible", lineHeight: 1.1 }}>
                  <span style={{ display: index % 6 === 0 || index === bars.length - 1 ? "inline" : "none" }}>{label}</span>
                </div>
              );
            })}
          </div>
          <div style={{ gridColumn: 1, gridRow: 2, color: "#64748b", fontSize: 9, textAlign: "right" }}>mm</div>
        </div>
      </div>
    </div>
  );
}

function taskRowTone(task) {
  if (task.completed) return { bg: "#f8fafc", border: "#e2e8f0", color: "#94a3b8" };
  if (task.source === "user_custom") return { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" };
  if (task.priority === "high") return { bg: "#fff7ed", border: "#fed7aa", color: "#c2410c" };
  return { bg: "#ffffff", border: "#e2e8f0", color: "#334155" };
}

function CoachTaskList({ eventId, eventStart, clock, audience = false }) {
  const [tasks, setTasks] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [trainingOnly, setTrainingOnly] = useState(false);
  const [error, setError] = useState("");
  const [unlocked, setUnlocked] = useState(() => !audience || Boolean(getCoachPassword()));
  const [audiencePanelOpen, setAudiencePanelOpen] = useState(() => !audience || Boolean(getCoachPassword()));
  const [password, setPasswordInput] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const elapsedMin = Math.max(0, Math.floor((clock - eventStart) / 60000));

  const loadTasks = useCallback(async () => {
    if (!eventId || !unlocked) return;
    const payload = await apiGet(`/api/training-events/${encodeURIComponent(eventId)}/coach-tasks`, { tasks: [], error: "" });
    setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
    setError(payload.error || "");
  }, [eventId, unlocked]);

  useEffect(() => {
    if (!unlocked) return undefined;
    const firstLoad = window.setTimeout(loadTasks, 0);
    const timer = window.setInterval(loadTasks, 2000);
    return () => {
      window.clearTimeout(firstLoad);
      window.clearInterval(timer);
    };
  }, [loadTasks, unlocked]);

  const visibleTasks = useMemo(() => {
    const filtered = tasks.filter((task) => !trainingOnly || task.trainingTask);
    const sorted = [...filtered].sort((left, right) => Number(left.minute || 0) - Number(right.minute || 0));
    if (expanded) return sorted;
    const currentIndex = sorted.reduce((lastIndex, task, index) => (
      Number(task.minute || 0) <= elapsedMin ? index : lastIndex
    ), -1);
    if (currentIndex < 0) return sorted.slice(0, 5);
    const maxStart = Math.max(0, sorted.length - 5);
    const start = Math.min(maxStart, Math.max(0, currentIndex - 2));
    return sorted.slice(start, start + 5);
  }, [elapsedMin, expanded, tasks, trainingOnly]);

  async function markDone(task) {
    if (!unlocked) {
      setUnlockError("请先输入教练密码解锁任务处理");
      return;
    }
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, completed: true, completedAt: Date.now() } : item));
    try {
      const payload = await apiPost(`/api/training-events/${encodeURIComponent(eventId)}/coach-tasks/${encodeURIComponent(task.id)}/complete`, { completed: true });
      setTasks(Array.isArray(payload.tasks) ? payload.tasks : []);
      setError("");
    } catch (err) {
      setError(err.message || "任务状态保存失败");
      loadTasks();
    }
  }

  async function unlockTasks() {
    const nextPassword = password.trim();
    if (!nextPassword) {
      setUnlockError("请输入教练密码");
      return;
    }
    try {
      await validateCoachPassword(nextPassword);
      setCoachPassword(nextPassword);
      setUnlocked(true);
      setAudiencePanelOpen(true);
      setPasswordInput("");
      setUnlockError("");
    } catch (err) {
      setUnlockError(err.message || "密码不正确");
    }
  }

  const taskContent = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, color: "#0f172a" }}>教练任务 📋</h3>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>当前 {elapsedMin} min / {tasks.filter((task) => task.completed).length}/{tasks.length} 已处理</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={{ ...monitorButtonStyle, height: 30, borderRadius: 8, padding: "0 8px", fontSize: 12, background: trainingOnly ? "#1646b7" : "#2563eb" }} onClick={() => setTrainingOnly((value) => !value)}>
            只显示训练任务
          </button>
          <button type="button" style={{ ...monitorButtonStyle, height: 30, borderRadius: 8, padding: "0 8px", fontSize: 12, background: expanded ? "#1646b7" : "#2563eb" }} onClick={() => setExpanded((value) => !value)}>
            展开全部
          </button>
        </div>
      </div>
      {error ? <div style={{ color: "#b91c1c", fontWeight: 800, marginBottom: 8 }}>{error}</div> : null}
      <div style={{ display: "grid", gap: 8 }}>
        {visibleTasks.length ? visibleTasks.map((task) => {
          const tone = taskRowTone(task);
          return (
            <div key={task.id} style={{ display: "grid", gridTemplateColumns: "52px minmax(54px,82px) minmax(0,1fr) 56px", gap: 5, alignItems: "center", border: `1px solid ${tone.border}`, borderRadius: 8, background: tone.bg, color: tone.color, padding: "6px 7px", minWidth: 0 }}>
              <strong style={{ color: task.completed ? "#94a3b8" : "#0f172a", fontSize: 12, whiteSpace: "nowrap" }}>{task.minute}m</strong>
              <span style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{task.pilotDisplayName || task.pilotName || "全体"}</span>
              <span style={{ overflowWrap: "anywhere", lineHeight: 1.25, fontSize: 12, minWidth: 0, whiteSpace: "normal" }}>
                <b>{task.action}</b>{task.focus ? `：${task.focus}` : task.detail ? `：${task.detail}` : ""}
              </span>
              {task.completed ? (
                <span style={{ justifySelf: "end", color: "#94a3b8", fontWeight: 900, fontSize: 11 }}>已处理</span>
              ) : (
                <button type="button" style={{ ...monitorButtonStyle, height: 28, borderRadius: 7, padding: "0 5px", fontSize: 11 }} onClick={() => markDone(task)}>
                  已处理
                </button>
              )}
            </div>
          );
        }) : (
          <div style={{ color: "#64748b" }}>暂无教练任务，请先在智能备课生成方案。</div>
        )}
      </div>
    </>
  );

  const lockedContent = (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ color: "#64748b", fontSize: 13 }}>输入教练密码后可查看并处理任务。</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 72px", gap: 8, alignItems: "center" }}>
        <input
          type="password"
          value={password}
          onChange={(event) => setPasswordInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") unlockTasks();
          }}
          placeholder="教练密码"
          style={{ height: 34, border: "1px solid #cbd5e1", borderRadius: 8, padding: "0 10px", minWidth: 0, boxSizing: "border-box" }}
        />
        <button type="button" style={{ ...monitorButtonStyle, height: 34, borderRadius: 8, padding: "0 10px", fontSize: 12 }} onClick={unlockTasks}>
          解锁
        </button>
      </div>
      {unlockError ? <div style={{ color: "#b91c1c", fontWeight: 800, fontSize: 12 }}>{unlockError}</div> : null}
    </div>
  );

  if (audience) {
    return (
      <details style={{ borderTop: "1px solid #e2e8f0", marginTop: 12, paddingTop: 8 }} open={audiencePanelOpen} onToggle={(event) => setAudiencePanelOpen(event.currentTarget.open)}>
        <summary style={{ cursor: "pointer", color: "#0f172a", fontWeight: 900, fontSize: 15, listStylePosition: "inside" }}>
          教练任务
        </summary>
        <div style={{ marginTop: 8 }}>
          {unlocked ? taskContent : lockedContent}
        </div>
      </details>
    );
  }

  return (
    <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 14, paddingTop: 12 }}>
      {taskContent}
    </div>
  );
}

const PilotMonitorCard = memo(function PilotMonitorCard({ index, pilot, participant, eventStart, windowStart, windowMs, latestSamplesRef, sampleQueuesRef, renderTick, stateSeed, onLiveStateChange, cardRef }) {
  const samplesRef = useRef([]);
  const bandsRef = useRef([]);
  const authoritativeBandsRef = useRef([]);
  const summaryRef = useRef({ totalFlightMs: 0, utilizationFlightMs: 0, totalTurtleMs: 0, lastFlightEndedAt: null });
  const lastSerialTimeRef = useRef(0);
  const lastSummaryAtRef = useRef(0);
  const lastBandRenderAtRef = useRef(0);
  const lastSeededBandsRef = useRef(null);
  const [view, setView] = useState(() => ({
    bands: [],
    latest: null,
    recent: [],
    now: INITIAL_NOW,
    waveNow: INITIAL_NOW,
    summary: makeEmptySummary(pilot.id),
  }));
  const trainingWindow = getParticipantTrainingWindow(eventStart, participant, view.now || INITIAL_NOW);
  const trainingStart = trainingWindow.start;
  const trainingEnd = trainingWindow.end;

  useEffect(() => {
    let frameId = 0;
    const seededBands = stateSeed?.bandsByPilot?.[pilot.id] || [];
    const seededBandsChanged = lastSeededBandsRef.current !== seededBands;
    const seededSummary = stateSeed?.summaries?.[pilot.id] || null;
    const latestLocalSample = samplesRef.current[samplesRef.current.length - 1];

    let nextSummaryRef = summaryRef.current;
    let nextSummary = null;
    if (seededSummary) {
      const seededLastFlightEndedAt = seededSummary.lastFlightEndedAt
        ?? (seededSummary.idleMs === null ? null : (seededSummary.updatedAt || Date.now()) - seededSummary.idleMs);
      nextSummaryRef = {
        totalFlightMs: Math.max(Number(summaryRef.current.totalFlightMs || 0), Number(seededSummary.totalFlightMs || 0)),
        utilizationFlightMs: Math.max(Number(summaryRef.current.utilizationFlightMs || 0), Number(seededSummary.utilizationFlightMs || 0)),
        totalTurtleMs: Math.max(Number(summaryRef.current.totalTurtleMs || 0), Number(seededSummary.totalTurtleMs || 0)),
        lastFlightEndedAt: Math.max(Number(summaryRef.current.lastFlightEndedAt || 0), Number(seededLastFlightEndedAt || 0)) || null,
      };
      nextSummary = {
        pilotId: pilot.id,
        totalFlightMs: nextSummaryRef.totalFlightMs,
        utilization: seededSummary.utilization || 0,
        idleMs: seededSummary.idleMs ?? null,
        lastFlightEndedAt: nextSummaryRef.lastFlightEndedAt,
        totalTurtleMs: nextSummaryRef.totalTurtleMs,
        updatedAt: seededSummary.updatedAt || Date.now(),
        segments: seededBands
          .map((band) => ({ pilotId: pilot.id, type: segmentTypeFromState(band.state), startedAt: band.start, endedAt: band.end, durationMs: band.end - band.start }))
          .filter((segment) => segment.durationMs > 0),
      };
    }

    if (latestLocalSample && Date.now() - latestLocalSample.time < 2000) {
      const shouldSeedBands = Boolean(seededBands.length && seededBandsChanged);
      const shouldSeedSummary = Boolean(seededSummary);
      if (!shouldSeedBands && !shouldSeedSummary) return undefined;
      if (shouldSeedBands) lastSeededBandsRef.current = seededBands;
      frameId = window.requestAnimationFrame(() => {
        if (shouldSeedSummary) summaryRef.current = nextSummaryRef;
        if (shouldSeedBands) authoritativeBandsRef.current = [...seededBands];
        setView((current) => ({
          ...current,
          bands: shouldSeedBands
            ? mergeAuthoritativeBandsWithLiveTail(seededBands, bandsRef.current)
            : current.bands,
          // With live samples already flowing, the server snapshot only
          // advances the accumulator baseline above. Replacing the rendered
          // summary here made idle/utilization flash back to an older value.
          summary: current.summary,
        }));
      });
      return () => {
        if (frameId) window.cancelAnimationFrame(frameId);
      };
    }

    const seedSamples = samplesFromLiveState(stateSeed, pilot.id, participant.receiverId);
    const restored = [];
    const authoritativeBands = seededBands.length ? seededBands : authoritativeBandsRef.current;
    const authoritativeEnd = authoritativeBands.length
      ? Math.max(...authoritativeBands.map((band) => Number(band.end) || 0))
      : 0;
    const restoredLiveTail = [];
    for (const rawSeed of seedSamples) {
      if (rawSeed.time < trainingStart) continue;
      const rawSample = { ...rawSeed, pilotId: pilot.id, receiverId: participant.receiverId };
      const recent = restored.filter((item) => item.time >= rawSample.time - 5000);
      const hasStoredState = typeof rawSample.armed === "boolean" || typeof rawSample.flying === "boolean" || typeof rawSample.turtle === "boolean";
      const state = hasStoredState
        ? { armed: Boolean(rawSample.armed), flying: Boolean(rawSample.flying), turtle: Boolean(rawSample.turtle) }
        : getPilotState(pilot, rawSample, [...recent, rawSample]);
      restored.push({ ...rawSample, armed: state.armed, flying: state.flying, turtle: state.turtle });
    }
    for (let index = 0; index < restored.length - 1; index += 1) {
      const sample = restored[index];
      const next = restored[index + 1];
      const intervalEnd = Math.min(next.time, sample.time + MAX_SAMPLE_GAP_MS);
      const intervalStart = Math.max(sample.time, authoritativeEnd);
      if (intervalEnd > intervalStart) {
        appendBand(restoredLiveTail, stateFromSample(sample), intervalStart, intervalEnd);
      }
    }

    frameId = window.requestAnimationFrame(() => {
      lastSeededBandsRef.current = seededBands;
      samplesRef.current = restored.length ? getRecentSamples(restored, Date.now() - RECENT_SAMPLE_WINDOW_MS) : [];
      if (seededBands.length) authoritativeBandsRef.current = seededBands;
      // Keep the persisted timeline and the unpersisted live tail separate.
      // This is the stable merge model and prevents refresh reconstruction
      // from duplicating/reordering nearby bands.
      bandsRef.current = restoredLiveTail;
      summaryRef.current = nextSummaryRef;
      lastSerialTimeRef.current = restored[restored.length - 1]?.time || 0;
      const nowTime = Date.now();
      setView((current) => ({
        ...current,
        bands: authoritativeBands.length
          ? mergeAuthoritativeBandsWithLiveTail(authoritativeBands, restoredLiveTail)
          : restoredLiveTail,
        latest: restored[restored.length - 1] || current.latest,
        recent: getRecentSamples(restored, nowTime - 5000),
        now: nowTime,
        waveNow: nowTime,
        summary: nextSummary || current.summary,
      }));
    });

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, [eventStart, stateSeed, participant.receiverId, pilot, trainingStart]);

  const buildSummary = useCallback((nowTime) => {
    const latestSample = samplesRef.current[samplesRef.current.length - 1] || null;
    const currentState = stateFromSample(latestSample);
    const liveDuration = latestSample ? Math.max(0, Math.min(nowTime, latestSample.time + MAX_SAMPLE_GAP_MS) - latestSample.time) : 0;
    const utilizationLiveDuration = latestSample ? Math.max(0, Math.min(nowTime, trainingEnd || nowTime, latestSample.time + MAX_SAMPLE_GAP_MS) - Math.max(trainingStart, latestSample.time)) : 0;
    const totalFlightMs = summaryRef.current.totalFlightMs + (currentState === "flying" ? liveDuration : 0);
    const utilizationFlightMs = summaryRef.current.utilizationFlightMs + (currentState === "flying" ? utilizationLiveDuration : 0);
    const totalTurtleMs = summaryRef.current.totalTurtleMs + (currentState === "turtle" ? liveDuration : 0);
    const lastFlightEndedAt = currentState === "flying" && latestSample ? Math.min(nowTime, latestSample.time + MAX_SAMPLE_GAP_MS) : summaryRef.current.lastFlightEndedAt;
    const segments = bandsRef.current
      .map((band) => ({ pilotId: pilot.id, type: segmentTypeFromState(band.state), startedAt: band.start, endedAt: band.end, durationMs: band.end - band.start }))
      .filter((segment) => segment.durationMs > 0);
    const statsNow = Math.min(nowTime, trainingEnd || nowTime);
    return {
      pilotId: pilot.id,
      totalFlightMs,
      totalTurtleMs,
      utilization: utilizationFlightMs / Math.max(1, statsNow - trainingStart),
      idleMs: lastFlightEndedAt === null ? null : Math.max(0, nowTime - lastFlightEndedAt),
      lastFlightEndedAt,
      segments,
    };
  }, [pilot.id, trainingEnd, trainingStart]);

  const processExternalSample = useCallback((externalSample, nowTime) => {
    if (!externalSample) return { changed: false, stateChanged: false };
    const sampleTime = Number(externalSample.time) || nowTime;
    if (sampleTime <= lastSerialTimeRef.current) return { changed: false, stateChanged: false };
    const rawSample = { ...externalSample, pilotId: pilot.id, receiverId: participant.receiverId, time: sampleTime };
    lastSerialTimeRef.current = sampleTime;
    const recentBefore = getRecentSamples(samplesRef.current, sampleTime - 5000);
    const state = getPilotState(pilot, rawSample, [...recentBefore, rawSample]);
    const sample = { ...rawSample, armed: state.armed, flying: state.flying, turtle: state.turtle };
    const previousSample = samplesRef.current[samplesRef.current.length - 1] || null;
    let stateChanged = !previousSample || stateFromSample(previousSample) !== stateFromSample(sample);
    if (previousSample) {
      const sampleGap = sampleTime - previousSample.time;
      if (sampleGap <= MAX_SAMPLE_GAP_MS) {
        const intervalStart = previousSample.time;
        const intervalEnd = Math.min(sampleTime, previousSample.time + MAX_SAMPLE_GAP_MS);
        const previousState = stateFromSample(previousSample);
        appendBand(bandsRef.current, previousState, intervalStart, intervalEnd);
        const statsStart = Math.max(trainingStart, intervalStart);
        const statsEnd = Math.min(trainingEnd || intervalEnd, intervalEnd);
        const durationMs = Math.max(0, statsEnd - statsStart);
        const actualDurationMs = Math.max(0, intervalEnd - intervalStart);
        if (previousState === "flying") {
          summaryRef.current.totalFlightMs += actualDurationMs;
          summaryRef.current.utilizationFlightMs += durationMs;
          summaryRef.current.lastFlightEndedAt = intervalEnd;
        }
        if (previousState === "turtle") summaryRef.current.totalTurtleMs += actualDurationMs;
      }
    }
    samplesRef.current = [...samplesRef.current, sample].filter((item) => item.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
    return { changed: true, stateChanged };
  }, [participant.receiverId, pilot, trainingEnd, trainingStart]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const nowTime = Date.now();
      const externalSample = latestSamplesRef?.current?.[participant.receiverId] || null;
      const queuedSamples = sampleQueuesRef?.current?.[participant.receiverId] || [];
      const pendingSamples = queuedSamples.filter((sample) => Number(sample?.time) > lastSerialTimeRef.current);
      if (externalSample && Number(externalSample.time) > lastSerialTimeRef.current && !pendingSamples.includes(externalSample)) {
        pendingSamples.push(externalSample);
      }
      pendingSamples.sort((left, right) => Number(left.time) - Number(right.time));
      let changed = false;
      let stateChanged = false;
      for (const sample of pendingSamples) {
        const result = processExternalSample(sample, nowTime);
        changed = changed || result.changed;
        stateChanged = stateChanged || result.stateChanged;
      }
      const latestProcessedSample = samplesRef.current[samplesRef.current.length - 1] || externalSample;
      const shouldRefreshSummary = changed || nowTime - lastSummaryAtRef.current >= STATS_INTERVAL_MS;
      const shouldRefreshBands = changed && (stateChanged || nowTime - lastBandRenderAtRef.current >= BAND_RENDER_INTERVAL_MS);
      const summary = shouldRefreshSummary ? buildSummary(nowTime) : null;
      if (shouldRefreshSummary) lastSummaryAtRef.current = nowTime;
      if (shouldRefreshBands) lastBandRenderAtRef.current = nowTime;
      setView((current) => ({
        bands: shouldRefreshBands ? mergeAuthoritativeBandsWithLiveTail(authoritativeBandsRef.current, bandsRef.current) : current.bands,
        latest: samplesRef.current[samplesRef.current.length - 1] || current.latest,
        recent: getRecentSamples(samplesRef.current, nowTime - 5000),
        // UI elapsed-time labels must follow one monotonic wall clock. Using a
        // newly arrived sample timestamp on one render and Date.now() on the
        // next can straddle a second boundary and make mobile Edge alternate
        // repeatedly between (for example) 1 s and 2 s.
        now: nowTime,
        waveNow: shouldRefreshBands ? Number(latestProcessedSample?.time) || nowTime : current.waveNow,
        summary: summary || current.summary,
      }));
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [buildSummary, latestSamplesRef, participant.receiverId, processExternalSample, renderTick, sampleQueuesRef, windowStart, windowMs]);

  const latest = view.latest || {};
  const recent = view.recent || [];
  const state = getPilotState(pilot, latest, recent);
  const receiverOnline = Boolean(latest.time && view.now - latest.time < 1500);
  const paired = Boolean(receiverOnline && (latest.lq > 0 || latest.rssi > -127));
  const authoritativeSummary = stateSeed?.summaries?.[pilot.id] || null;
  const summaryNow = view.now || INITIAL_NOW;
  const seededSummary = summaryFromSeedSummary(authoritativeSummary, trainingStart, trainingEnd, summaryNow);
  const liveSummary = view.summary || makeEmptySummary(pilot.id);
  const lastFlightEndedAt = Math.max(
    Number(seededSummary?.lastFlightEndedAt || 0),
    Number(liveSummary.lastFlightEndedAt || 0),
  ) || null;
  // One continuous summary for both coach and audience. The authoritative
  // snapshot is only a monotonic baseline; a short frame gap must never switch
  // the UI back to an older server idle/utilization value.
  const summary = {
    ...(seededSummary || {}),
    ...liveSummary,
    totalFlightMs: Math.max(Number(seededSummary?.totalFlightMs || 0), Number(liveSummary.totalFlightMs || 0)),
    totalTurtleMs: Math.max(Number(seededSummary?.totalTurtleMs || 0), Number(liveSummary.totalTurtleMs || 0)),
    lastFlightEndedAt,
    idleMs: lastFlightEndedAt === null ? null : Math.max(0, summaryNow - lastFlightEndedAt),
  };
  const stateLabel = pilotStateLabel(state);
  const summarySecond = Math.floor(Number(summary.totalFlightMs || 0) / 1000);
  const turtleSecond = Math.floor(Number(summary.totalTurtleMs || 0) / 1000);
  const idleSecond = summary.idleMs === null || summary.idleMs === undefined
    ? null
    : Math.floor(Number(summary.idleMs || 0) / 1000);
  const utilizationPermille = Math.round(Number(summary.utilization || 0) * 1000);
  const idleDisplay = state.flying
    ? "飞行中"
    : idleSecond === null
      ? "暂无"
      : formatDuration(idleSecond * 1000);

  useEffect(() => {
    if (!onLiveStateChange) return;
    onLiveStateChange(pilot.id, {
      state: {
        armed: state.armed,
        flying: state.flying,
        turtle: state.turtle,
        turtleSwitch: state.turtleSwitch,
        throttleSpread: state.throttleSpread,
      },
      stateLabel,
      paired,
      summary: {
        pilotId: pilot.id,
        totalFlightMs: summarySecond * 1000,
        utilization: utilizationPermille / 1000,
        idleMs: idleSecond === null ? null : idleSecond * 1000,
        totalTurtleMs: turtleSecond * 1000,
      },
    });
  }, [
    onLiveStateChange,
    paired,
    pilot.id,
    state.armed,
    state.flying,
    state.throttleSpread,
    state.turtle,
    state.turtleSwitch,
    stateLabel,
    idleSecond,
    summarySecond,
    turtleSecond,
    utilizationPermille,
  ]);
  const channels = latest.channels || {};
  const modeName = getModeName(pilot, latest);
  const roll = normalizeStick(channels.ch1 ?? CHANNEL_MID);
  const pitch = normalizeStick(channels.ch2 ?? CHANNEL_MID);
  const throttle = normalizeThrottle(channels.ch3 ?? CHANNEL_MIN);
  const yaw = normalizeStick(channels.ch4 ?? CHANNEL_MID);

  return (
    <section ref={cardRef} tabIndex={-1} style={{ ...monitorPanelStyle, scrollMarginTop: 14, outline: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 22, color: "#0f172a", letterSpacing: "-0.02em" }}>
            {index + 1} {pilot.name} <span style={{ fontSize: 22, fontWeight: 900, color: "#2563eb" }}>{participant.videoChannel}</span>
          </h3>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            接收机 {participant.receiverId} <span style={{ marginLeft: 8, color: paired ? "#047857" : "#b91c1c", fontWeight: 900 }}>{paired ? "已对频" : "未对频"}</span>
          </div>
        </div>
        <div style={{ color: state.flying ? "#047857" : state.turtle ? "#c2410c" : "#64748b", fontWeight: 900, fontSize: 14, alignSelf: "center" }}>
          {state.turtle ? "反乌龟中" : state.flying ? "飞行中" : state.armed ? "已解锁" : "待机"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8, marginBottom: 12 }}>
        <MetricBadge label="总飞行" value={formatDuration(summary.totalFlightMs)} />
        <MetricBadge label="利用率" value={`${Math.round(summary.utilization * 100)}%`} tone="#047857" />
        <MetricBadge label="距上次" value={idleDisplay} />
        <MetricBadge label="反乌龟" value={formatDuration(summary.totalTurtleMs)} tone="#c2410c" />
      </div>
      <Waveform bands={view.bands} windowStart={windowStart} windowMs={windowMs} currentTime={view.waveNow} />

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", justifyContent: "center", marginTop: 16, maxWidth: "100%", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", justifyContent: "center", maxWidth: "100%", minWidth: 0 }}>
          <StickBox title="左摇杆" x={yaw} y={throttle * 2 - 1} />
          <StickBox title="右摇杆" x={roll} y={pitch} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(118px,1fr))", gap: 8, alignItems: "center", width: "100%", maxWidth: 520 }}>
          <MetricBadge label="解锁" value={state.armed ? "ON" : "OFF"} tone={state.armed ? "#047857" : "#64748b"} />
          <MetricBadge label="模式" value={modeName} />
          <MetricBadge label="反乌龟" value={state.turtleSwitch ? "ON" : "OFF"} tone={state.turtleSwitch ? "#c2410c" : "#64748b"} />
        </div>
      </div>
    </section>
  );
});

export default function MonitorPage({ pilots, events, latestSamplesRef, sampleQueuesRef, renderTick = 0, inputFps = 0, stateSeed = null, resyncToken = 0, audience = false }) {
  const activeEvent = events.find((event) => event.active);
  const [windowOffset, setWindowOffset] = useState(0);
  const [windowMs, setWindowMs] = useState(HOUR_MS);
  const [clock, setClock] = useState(INITIAL_NOW);
  const [storedStateSeed, setStoredStateSeed] = useState(null);
  const [pilotLiveState, setPilotLiveState] = useState({});
  const [frameRate, setFrameRate] = useState(0);
  const overviewRequestRef = useRef(0);
  const frameCounterRef = useRef({ count: 0, startedAt: 0, lastTick: 0 });
  const pilotCardNodesRef = useRef(new Map());
  const eventStart = activeEvent?.startedAt || activeEvent?.createdAt || INITIAL_NOW - HOUR_MS;
  const windowStart = Math.floor((clock + windowOffset * windowMs) / windowMs) * windowMs;
  const participants = useMemo(() => activeEvent?.participants || [], [activeEvent]);
  const pilotById = useMemo(() => new Map(pilots.map((pilot) => [pilot.id, pilot])), [pilots]);
  const activeEventId = activeEvent?.id || "";
  const matchingLiveSeed = stateSeed?.event?.id === activeEventId || stateSeed?.eventId === activeEventId ? stateSeed : null;
  const matchingStoredSeed = storedStateSeed?.eventId === activeEventId ? storedStateSeed : null;
  const effectiveStateSeed = useMemo(() => {
    if (!matchingLiveSeed) return matchingStoredSeed;
    const liveFullBands = matchingLiveSeed.bandsByPilot || null;
    const liveBandUpdates = matchingLiveSeed.bandUpdatesByPilot || {};
    if (!matchingStoredSeed) {
      return {
        ...matchingLiveSeed,
        bandsByPilot: mergeAuthoritativeBandMaps(liveFullBands || {}, liveBandUpdates),
      };
    }

    // Restore the V1/V2 refresh contract: the REST response is the complete,
    // persisted timeline and therefore wins over the WebSocket join snapshot.
    // The join snapshot can be a few persistence ticks older than the REST
    // request. Using it as the base made a refresh erase the newest persisted
    // bands even though /stats had already returned them. Keep WebSocket full
    // bands only as a fallback for pilots that have no persisted timeline yet,
    // then append the small real-time update suffix.
    const liveBaselineIsNewer = Boolean(
      liveFullBands
      && matchingLiveSeed.bandsComplete
      && (Number(matchingLiveSeed.updatedAt) || 0) >= (Number(matchingStoredSeed.version) || 0),
    );
    const authoritativeBase = liveBaselineIsNewer ? { ...liveFullBands } : {};
    const storedBandsByPilot = matchingStoredSeed.bandsByPilot || {};
    const storedPilotIds = new Set([
      ...Object.keys(matchingStoredSeed.summaries || {}),
      ...Object.keys(storedBandsByPilot),
    ]);
    for (const pilotId of storedPilotIds) {
      // A successful REST response is authoritative even when the rebuilt
      // result is empty. Keeping an older WebSocket full band in that case
      // would make coach/audience disagree with SQLite after resync.
      if (!liveBaselineIsNewer || !Object.hasOwn(authoritativeBase, pilotId)) {
        authoritativeBase[pilotId] = storedBandsByPilot[pilotId] || [];
      }
    }
    const bandsByPilot = mergeAuthoritativeBandMaps(authoritativeBase, liveBandUpdates);
    return {
      ...matchingStoredSeed,
      ...matchingLiveSeed,
      summaries: mergeSummaryMapsByFreshness(
        matchingLiveSeed.summaries || {},
        matchingStoredSeed.summaries || {},
      ),
      bandsByPilot,
    };
  }, [matchingLiveSeed, matchingStoredSeed]);
  const zoomIndex = TIME_WINDOW_OPTIONS.indexOf(windowMs);
  const coachBoardItems = useMemo(() => buildCoachBoardItems({
    participants,
    pilotById,
    latestSamplesRef,
    effectiveStateSeed,
    eventStart,
    now: clock,
    pilotLiveState,
    eventId: activeEventId,
  }), [participants, pilotById, latestSamplesRef, effectiveStateSeed, eventStart, clock, pilotLiveState, activeEventId]);
  const handlePilotLiveStateChange = useCallback((pilotId, liveState) => {
    setPilotLiveState((current) => {
      const nextState = { ...liveState, eventId: activeEventId };
      const previous = current[pilotId];
      if (
        previous &&
        previous.eventId === nextState.eventId &&
        previous.stateLabel === nextState.stateLabel &&
        previous.paired === nextState.paired &&
        previous.state?.armed === nextState.state?.armed &&
        previous.state?.flying === nextState.state?.flying &&
        previous.state?.turtle === nextState.state?.turtle &&
        previous.state?.turtleSwitch === nextState.state?.turtleSwitch &&
        previous.state?.throttleSpread === nextState.state?.throttleSpread &&
        previous.summary?.totalFlightMs === nextState.summary?.totalFlightMs &&
        previous.summary?.utilization === nextState.summary?.utilization &&
        previous.summary?.idleMs === nextState.summary?.idleMs &&
        previous.summary?.totalTurtleMs === nextState.summary?.totalTurtleMs
      ) {
        return current;
      }
      return { ...current, [pilotId]: nextState };
    });
  }, [activeEventId]);

  const registerPilotCard = useCallback((pilotId, node) => {
    if (node) pilotCardNodesRef.current.set(pilotId, node);
    else pilotCardNodesRef.current.delete(pilotId);
  }, []);

  const scrollToPilotCard = useCallback((pilotId) => {
    const node = pilotCardNodesRef.current.get(pilotId);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => node.focus({ preventScroll: true }), 350);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!renderTick || renderTick === frameCounterRef.current.lastTick) return;
    const now = Date.now();
    const counter = frameCounterRef.current;
    if (!counter.startedAt) {
      frameCounterRef.current = { count: 1, startedAt: now, lastTick: renderTick };
      return;
    }
    counter.count += 1;
    counter.lastTick = renderTick;
    const elapsed = now - counter.startedAt;
    if (elapsed >= 1000) {
      setFrameRate((counter.count * 1000) / elapsed);
      frameCounterRef.current = { count: 0, startedAt: now, lastTick: renderTick };
    }
  }, [renderTick]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (frameCounterRef.current.lastTick && Date.now() - frameCounterRef.current.lastTick > 1500) {
        setFrameRate(0);
        frameCounterRef.current = { count: 0, startedAt: 0, lastTick: 0 };
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeEventId) return;
    let stopped = false;
    async function loadStoredOverview() {
      const requestId = overviewRequestRef.current + 1;
      overviewRequestRef.current = requestId;
      // null distinguishes a failed request from a valid empty timeline. A
      // transient HTTP failure must never replace the last good REST seed.
      const overview = await apiGet(`/api/training-events/${activeEventId}/stats?cached=1`, null);
      if (stopped || requestId !== overviewRequestRef.current || !overview) return;
      const summaries = {};
      const segmentsByPilot = {};
      for (const stat of overview.stats || []) {
        summaries[stat.pilot_id] = {
          pilotId: stat.pilot_id,
          totalFlightMs: stat.total_flight_ms || 0,
          utilization: stat.utilization || 0,
          idleMs: stat.idle_ms ?? null,
          lastFlightEndedAt: stat.last_flight_end_at ?? null,
          totalTurtleMs: stat.total_turtle_ms || 0,
          updatedAt: stat.updated_at || Date.now(),
        };
      }
      for (const segment of overview.segments || []) {
        const pilotId = segment.pilot_id;
        if (!segmentsByPilot[pilotId]) segmentsByPilot[pilotId] = [];
        segmentsByPilot[pilotId].push(segment);
      }
      const bandsByPilot = {};
      for (const [pilotId, segments] of Object.entries(segmentsByPilot)) {
        bandsByPilot[pilotId] = bandsFromSegments(segments);
      }
      setStoredStateSeed({
        eventId: activeEventId,
        version: Number(overview.timeline?.generatedAt) || Date.now(),
        timeline: overview.timeline || null,
        summaries,
        bandsByPilot,
      });
    }
    loadStoredOverview();
    function handleVisible() {
      if (document.visibilityState === "visible") loadStoredOverview();
    }
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [activeEventId, resyncToken]);

  if (!activeEvent) {
    return (
      <section style={monitorPanelStyle}>
        <h2 style={{ marginTop: 0 }}>实时监测</h2>
        <div style={{ color: "#64748b" }}>还没有进行中的训练事件。</div>
      </section>
    );
  }

  return (
    <>
    <div style={{ display: "grid", gap: 14, width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box", overflowX: "hidden" }}>
      <CoachBoard items={coachBoardItems} eventId={activeEvent.id} eventStart={eventStart} clock={clock} audience={audience} onPilotSelect={scrollToPilotCard} />
      <WeatherAlert eventId={activeEvent.id} />

      <section style={{ ...monitorPanelStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: "clamp(24px, 7vw, 30px)", fontWeight: 950, color: "#0f172a", letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>{activeEvent.name}</h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
            已记录 {formatDuration(clock - eventStart)}
          </div>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            输入 {inputFps ? inputFps.toFixed(1) : "0.0"} fps / 页面 {frameRate ? frameRate.toFixed(1) : "0.0"} fps
          </div>
        </div>
        <div style={{ display: "grid", gap: 8, justifyItems: "stretch", width: "100%", maxWidth: 470, minWidth: 0, boxSizing: "border-box" }}>
          <div style={controlGridStyle}>
            <button type="button" style={{ ...monitorButtonStyle, width: "100%" }} onClick={() => setWindowOffset((value) => value - 1)}>上一段</button>
            <div style={controlDisplayStyle}>
              {formatClock(windowStart)} - {formatClock(windowStart + windowMs)}
            </div>
            <button type="button" style={{ ...monitorButtonStyle, width: "100%" }} onClick={() => setWindowOffset((value) => value + 1)}>下一段</button>
          </div>
          <div style={controlGridStyle}>
            <button
              type="button"
              style={{ ...monitorButtonStyle, width: "100%", opacity: zoomIndex <= 0 ? 0.45 : 1, cursor: zoomIndex <= 0 ? "not-allowed" : "pointer" }}
              onClick={() => setWindowMs((value) => TIME_WINDOW_OPTIONS[Math.max(0, TIME_WINDOW_OPTIONS.indexOf(value) - 1)] || value)}
              disabled={zoomIndex <= 0}
            >
              +
            </button>
            <div style={controlDisplayStyle}>
              {Math.round(windowMs / 60000)} 分钟
            </div>
            <button
              type="button"
              style={{ ...monitorButtonStyle, width: "100%", opacity: zoomIndex >= TIME_WINDOW_OPTIONS.length - 1 ? 0.45 : 1, cursor: zoomIndex >= TIME_WINDOW_OPTIONS.length - 1 ? "not-allowed" : "pointer" }}
              onClick={() => setWindowMs((value) => TIME_WINDOW_OPTIONS[Math.min(TIME_WINDOW_OPTIONS.length - 1, TIME_WINDOW_OPTIONS.indexOf(value) + 1)] || value)}
              disabled={zoomIndex >= TIME_WINDOW_OPTIONS.length - 1}
            >
              -
            </button>
          </div>
        </div>
      </section>

      {participants.map((participant, index) => {
        const pilot = pilotById.get(participant.pilotId);
        if (!pilot) return null;
        return (
          <PilotMonitorCard
            key={`${activeEvent.id}-${participant.pilotId}-${participant.receiverId}`}
            index={index}
            pilot={pilot}
            participant={participant}
            eventStart={eventStart}
            windowStart={windowStart}
            windowMs={windowMs}
            latestSamplesRef={latestSamplesRef}
            sampleQueuesRef={sampleQueuesRef}
            renderTick={renderTick || clock}
            stateSeed={effectiveStateSeed}
            onLiveStateChange={handlePilotLiveStateChange}
            cardRef={(node) => registerPilotCard(participant.pilotId, node)}
          />
        );
      })}
    </div>
    {createPortal(
      <button type="button" aria-label="回到实时监测顶部" title="回到顶部" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} style={{ position: "fixed", right: "clamp(14px, 3vw, 24px)", bottom: "calc(clamp(14px, 3vw, 24px) + env(safe-area-inset-bottom))", zIndex: 1200, width: 44, height: 44, border: "1px solid rgba(255,255,255,.72)", borderRadius: 999, display: "grid", placeItems: "center", padding: 0, background: "rgba(37,99,235,.92)", color: "#fff", boxShadow: "0 10px 28px rgba(15,23,42,.28)", backdropFilter: "blur(8px)", cursor: "pointer", lineHeight: 1 }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 4h14" />
          <path d="m7 11 5-5 5 5" />
          <path d="M12 6v14" />
        </svg>
      </button>,
      document.body,
    )}
    </>
  );
}
