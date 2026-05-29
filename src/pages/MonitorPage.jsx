import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, formatClock, formatDuration, inputStyle, isValueInRanges, panelStyle, primaryButtonStyle } from "../trainingShared.js";

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
  boxShadow: "0 16px 42px rgba(15,23,42,.08)",
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
    }));
  if (visible.length <= MAX_RENDER_SAMPLES) return visible;
  const stride = Math.ceil(visible.length / MAX_RENDER_SAMPLES);
  return visible.filter((_, index) => index % stride === 0 || index === visible.length - 1);
}

function getRecentSamples(samples, since) {
  let index = samples.length - 1;
  while (index >= 0 && samples[index].time >= since) index -= 1;
  return samples.slice(index + 1);
}

function mergeAuthoritativeBandsWithLiveTail(authoritativeBands = [], liveBands = []) {
  if (!authoritativeBands.length) return liveBands;
  if (!liveBands.length) return authoritativeBands;
  const lastAuthoritativeEnd = Math.max(...authoritativeBands.map((band) => band.end));
  const merged = authoritativeBands.map((band) => ({ ...band }));
  for (const band of liveBands) {
    if (band.end <= lastAuthoritativeEnd) continue;
    appendBand(merged, band.state, Math.max(band.start, lastAuthoritativeEnd), band.end);
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

function MetricBadge({ label, value, tone = "#334155" }) {
  return (
    <span style={{ flex: "1 1 118px", minWidth: 0, padding: "10px 12px", borderRadius: 999, background: "#f8fafc", border: "1px solid #e2e8f0", color: tone, fontWeight: 900, fontSize: "clamp(13px, 3.4vw, 15px)", lineHeight: 1.2, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, whiteSpace: "nowrap", boxSizing: "border-box" }}>
      {label}: {value}
    </span>
  );
}

function makeEmptySummary(pilotId) {
  return { pilotId, totalFlightMs: 0, utilization: 0, idleMs: null, totalTurtleMs: 0, segments: [] };
}

const PilotMonitorCard = memo(function PilotMonitorCard({ index, pilot, participant, eventStart, windowStart, windowMs, latestSamplesRef, renderTick, stateSeed }) {
  const samplesRef = useRef([]);
  const bandsRef = useRef([]);
  const authoritativeBandsRef = useRef([]);
  const summaryRef = useRef({ totalFlightMs: 0, totalTurtleMs: 0, lastFlightEndedAt: null });
  const lastSerialTimeRef = useRef(0);
  const lastSummaryAtRef = useRef(0);
  const lastBandRenderAtRef = useRef(0);
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

  useEffect(() => {
    let frameId = 0;
    const seededBands = stateSeed?.bandsByPilot?.[pilot.id] || [];
    const seededSummary = stateSeed?.summaries?.[pilot.id] || null;
    const latestLocalSample = samplesRef.current[samplesRef.current.length - 1];

    let nextSummaryRef = summaryRef.current;
    let nextSummary = null;
    if (seededSummary) {
      nextSummaryRef = {
        totalFlightMs: seededSummary.totalFlightMs || 0,
        totalTurtleMs: seededSummary.totalTurtleMs || 0,
        lastFlightEndedAt: seededSummary.lastFlightEndedAt ?? (seededSummary.idleMs === null ? null : (seededSummary.updatedAt || Date.now()) - seededSummary.idleMs),
      };
      nextSummary = {
        pilotId: pilot.id,
        totalFlightMs: seededSummary.totalFlightMs || 0,
        utilization: seededSummary.utilization || 0,
        idleMs: seededSummary.idleMs ?? null,
        totalTurtleMs: seededSummary.totalTurtleMs || 0,
        updatedAt: seededSummary.updatedAt || Date.now(),
        segments: seededBands
          .map((band) => ({ pilotId: pilot.id, type: segmentTypeFromState(band.state), startedAt: band.start, endedAt: band.end, durationMs: band.end - band.start }))
          .filter((segment) => segment.durationMs > 0),
      };
    }

    if (latestLocalSample && Date.now() - latestLocalSample.time < 2000) {
      if (!seededBands.length) return undefined;
      frameId = window.requestAnimationFrame(() => {
        authoritativeBandsRef.current = [...seededBands];
        setView((current) => ({
          ...current,
          bands: mergeAuthoritativeBandsWithLiveTail(seededBands, bandsRef.current),
        }));
      });
      return () => {
        if (frameId) window.cancelAnimationFrame(frameId);
      };
    }

    const seedSamples = samplesFromLiveState(stateSeed, pilot.id, participant.receiverId);
    const restored = [];
    const restoredBands = seededBands.length ? [...seededBands] : [...authoritativeBandsRef.current];
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
      appendBand(restoredBands, stateFromSample(sample), sample.time, Math.min(next.time, sample.time + MAX_SAMPLE_GAP_MS));
    }

    frameId = window.requestAnimationFrame(() => {
      samplesRef.current = restored.length ? getRecentSamples(restored, Date.now() - RECENT_SAMPLE_WINDOW_MS) : [];
      if (seededBands.length) authoritativeBandsRef.current = seededBands;
      bandsRef.current = restoredBands;
      summaryRef.current = nextSummaryRef;
      lastSerialTimeRef.current = restored[restored.length - 1]?.time || 0;
      const nowTime = Date.now();
      setView((current) => ({
        ...current,
        bands: seededBands.length
          ? mergeAuthoritativeBandsWithLiveTail(seededBands, restoredBands)
          : current.bands,
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
    const liveDuration = latestSample ? Math.max(0, Math.min(nowTime, latestSample.time + MAX_SAMPLE_GAP_MS) - Math.max(trainingStart, latestSample.time)) : 0;
    const totalFlightMs = summaryRef.current.totalFlightMs + (currentState === "flying" ? liveDuration : 0);
    const totalTurtleMs = summaryRef.current.totalTurtleMs + (currentState === "turtle" ? liveDuration : 0);
    const lastFlightEndedAt = currentState === "flying" && latestSample ? Math.min(nowTime, latestSample.time + MAX_SAMPLE_GAP_MS) : summaryRef.current.lastFlightEndedAt;
    const segments = bandsRef.current
      .map((band) => ({ pilotId: pilot.id, type: segmentTypeFromState(band.state), startedAt: band.start, endedAt: band.end, durationMs: band.end - band.start }))
      .filter((segment) => segment.durationMs > 0);
    return {
      pilotId: pilot.id,
      totalFlightMs,
      totalTurtleMs,
      utilization: totalFlightMs / Math.max(1, nowTime - trainingStart),
      idleMs: lastFlightEndedAt === null ? null : Math.max(0, nowTime - lastFlightEndedAt),
      segments,
    };
  }, [pilot.id, trainingStart]);

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
    if (previousSample && previousSample.time >= trainingStart) {
      const intervalStart = Math.max(trainingStart, previousSample.time);
      const sampleGap = sampleTime - previousSample.time;
      if (sampleGap <= MAX_SAMPLE_GAP_MS) {
        const intervalEnd = Math.min(sampleTime, previousSample.time + MAX_SAMPLE_GAP_MS);
        const previousState = stateFromSample(previousSample);
        appendBand(bandsRef.current, previousState, intervalStart, intervalEnd);
        const durationMs = Math.max(0, intervalEnd - intervalStart);
        if (previousState === "flying") {
          summaryRef.current.totalFlightMs += durationMs;
          summaryRef.current.lastFlightEndedAt = intervalEnd;
        }
        if (previousState === "turtle") summaryRef.current.totalTurtleMs += durationMs;
      }
    }
    samplesRef.current = [...samplesRef.current, sample].filter((item) => item.time >= sampleTime - RECENT_SAMPLE_WINDOW_MS);
    return { changed: true, stateChanged };
  }, [participant.receiverId, pilot, trainingStart]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const nowTime = Date.now();
      const externalSample = latestSamplesRef?.current?.[participant.receiverId] || null;
      const { changed, stateChanged } = processExternalSample(externalSample, nowTime);
      const shouldRefreshSummary = changed || nowTime - lastSummaryAtRef.current >= STATS_INTERVAL_MS;
      const shouldRefreshBands = changed && (stateChanged || nowTime - lastBandRenderAtRef.current >= BAND_RENDER_INTERVAL_MS);
      const summary = shouldRefreshSummary ? buildSummary(nowTime) : null;
      if (shouldRefreshSummary) lastSummaryAtRef.current = nowTime;
      if (shouldRefreshBands) lastBandRenderAtRef.current = nowTime;
      setView((current) => ({
        bands: shouldRefreshBands ? mergeAuthoritativeBandsWithLiveTail(authoritativeBandsRef.current, bandsRef.current) : current.bands,
        latest: samplesRef.current[samplesRef.current.length - 1] || current.latest,
        recent: getRecentSamples(samplesRef.current, nowTime - 5000),
        now: changed ? Number(externalSample?.time) || nowTime : nowTime,
        waveNow: shouldRefreshBands ? Number(externalSample?.time) || nowTime : current.waveNow,
        summary: summary || current.summary,
      }));
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [buildSummary, latestSamplesRef, participant.receiverId, processExternalSample, renderTick, windowStart, windowMs]);

  const latest = view.latest || {};
  const recent = view.recent || [];
  const state = getPilotState(pilot, latest, recent);
  const receiverOnline = Boolean(latest.time && view.now - latest.time < 1500);
  const paired = Boolean(receiverOnline && (latest.lq > 0 || latest.rssi > -127));
  const authoritativeSummary = stateSeed?.summaries?.[pilot.id] || null;
  const summaryNow = view.now || INITIAL_NOW;
  const authoritativeUpdatedAt = Number(authoritativeSummary?.updatedAt || summaryNow);
  const authoritativeIdleMs = authoritativeSummary?.idleMs === null || authoritativeSummary?.idleMs === undefined
    ? null
    : Math.max(0, Number(authoritativeSummary.idleMs || 0) + Math.max(0, summaryNow - authoritativeUpdatedAt));
  const summary = authoritativeSummary ? {
    pilotId: pilot.id,
    totalFlightMs: authoritativeSummary.totalFlightMs || 0,
    utilization: (authoritativeSummary.totalFlightMs || 0) / Math.max(1, summaryNow - trainingStart),
    idleMs: authoritativeIdleMs,
    totalTurtleMs: authoritativeSummary.totalTurtleMs || 0,
  } : view.summary || makeEmptySummary(pilot.id);
  const channels = latest.channels || {};
  const modeName = getModeName(pilot, latest);
  const roll = normalizeStick(channels.ch1 ?? CHANNEL_MID);
  const pitch = normalizeStick(channels.ch2 ?? CHANNEL_MID);
  const throttle = normalizeThrottle(channels.ch3 ?? CHANNEL_MIN);
  const yaw = normalizeStick(channels.ch4 ?? CHANNEL_MID);

  return (
    <section style={monitorPanelStyle}>
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
        <MetricBadge label="距上次" value={summary.idleMs === null ? "暂无" : formatDuration(summary.idleMs)} />
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

export default function MonitorPage({ pilots, events, latestSamplesRef, renderTick = 0, inputFps = 0, stateSeed = null }) {
  const activeEvent = events.find((event) => event.active);
  const [windowOffset, setWindowOffset] = useState(0);
  const [windowMs, setWindowMs] = useState(HOUR_MS);
  const [clock, setClock] = useState(INITIAL_NOW);
  const [storedStateSeed, setStoredStateSeed] = useState(null);
  const [frameRate, setFrameRate] = useState(0);
  const frameCounterRef = useRef({ count: 0, startedAt: 0, lastTick: 0 });
  const eventStart = activeEvent?.startedAt || activeEvent?.createdAt || INITIAL_NOW - HOUR_MS;
  const windowStart = Math.floor((clock + windowOffset * windowMs) / windowMs) * windowMs;
  const participants = useMemo(() => activeEvent?.participants || [], [activeEvent]);
  const pilotById = useMemo(() => new Map(pilots.map((pilot) => [pilot.id, pilot])), [pilots]);
  const activeEventId = activeEvent?.id || "";
  const matchingLiveSeed = stateSeed?.event?.id === activeEventId || stateSeed?.eventId === activeEventId ? stateSeed : null;
  const matchingStoredSeed = storedStateSeed?.eventId === activeEventId ? storedStateSeed : null;
  const effectiveStateSeed = useMemo(() => {
    if (!matchingLiveSeed) return matchingStoredSeed;
    if (!matchingStoredSeed) return matchingLiveSeed;
    const bandsByPilot = { ...(matchingLiveSeed.bandsByPilot || {}) };
    for (const [pilotId, storedBands] of Object.entries(matchingStoredSeed.bandsByPilot || {})) {
      if (storedBands?.length) bandsByPilot[pilotId] = storedBands;
    }
    return {
      ...matchingStoredSeed,
      ...matchingLiveSeed,
      summaries: { ...(matchingStoredSeed.summaries || {}), ...(matchingLiveSeed.summaries || {}) },
      bandsByPilot,
    };
  }, [matchingLiveSeed, matchingStoredSeed]);
  const zoomIndex = TIME_WINDOW_OPTIONS.indexOf(windowMs);

  useEffect(() => {
    const timer = window.setTimeout(() => setStoredStateSeed(null), 0);
    return () => window.clearTimeout(timer);
  }, [activeEventId]);

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
      const overview = await apiGet(`/api/training-events/${activeEventId}/stats?cached=1`, { stats: [], segments: [] });
      if (stopped) return;
      const summaries = {};
      const segmentsByPilot = {};
      for (const stat of overview.stats || []) {
        summaries[stat.pilot_id] = {
          pilotId: stat.pilot_id,
          totalFlightMs: stat.total_flight_ms || 0,
          utilization: stat.utilization || 0,
          idleMs: stat.idle_ms ?? null,
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
      setStoredStateSeed({ eventId: activeEventId, version: Date.now(), summaries, bandsByPilot });
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
  }, [activeEventId]);

  if (!activeEvent) {
    return (
      <section style={monitorPanelStyle}>
        <h2 style={{ marginTop: 0 }}>实时监测</h2>
        <div style={{ color: "#64748b" }}>还没有进行中的训练事件。</div>
      </section>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14, width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box", overflowX: "hidden" }}>
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
            renderTick={renderTick || clock}
            stateSeed={effectiveStateSeed}
          />
        );
      })}
    </div>
  );
}
