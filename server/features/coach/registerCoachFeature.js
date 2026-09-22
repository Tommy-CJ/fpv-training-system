export function registerCoachFeature({
  activeEventQuery, allPilotsQuery, app, coachLlmConfigKey, coachLlmRuntime, coachSnapshotIntervalMs,
  coachSnapshotStore, coachStaleAfterMs, coachWindowMs, db, defaultCoachLlmConfig,
  eventFromRow, getParticipantTrainingWindow, optionalTimestamp, pilotFromRow,
  readCachedEventOverview, safeJsonParse, teaching,
}) {
const COACH_LLM_CONFIG_KEY = coachLlmConfigKey;
const COACH_SNAPSHOT_INTERVAL_MS = coachSnapshotIntervalMs;
const COACH_STALE_AFTER_MS = coachStaleAfterMs;
const COACH_WINDOW_MS = coachWindowMs;
const DEFAULT_COACH_LLM_CONFIG = defaultCoachLlmConfig;
const getEventParticipantStat = (...args) => teaching.getEventParticipantStat(...args);
const comparePilotProgress = (...args) => teaching.comparePilotProgress(...args);
const getTeachingEvent = (...args) => teaching.getTeachingEvent(...args);
const lessonReviewsForEvent = (...args) => teaching.lessonReviewsForEvent(...args);
function clipSegmentToWindow(segment, start, end) {
  const segmentStart = Math.max(start, Number(segment.started_at || 0));
  const segmentEnd = Math.min(end, Number(segment.ended_at || 0));
  if (segmentEnd <= segmentStart) return null;
  return {
    type: segment.type,
    startedAt: segmentStart,
    endedAt: segmentEnd,
    durationMs: segmentEnd - segmentStart,
  };
}

function summarizeCoachWindow(segments, start, end) {
  const durationMs = Math.max(1, end - start);
  const clipped = segments
    .map((segment) => clipSegmentToWindow(segment, start, end))
    .filter(Boolean);
  const flightSegments = clipped.filter((segment) => segment.type === "flight");
  const turtleSegments = clipped.filter((segment) => segment.type === "turtle");
  const idleSegments = clipped.filter((segment) => segment.type === "idle");
  const totalFlightMs = flightSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const totalTurtleMs = turtleSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const totalIdleMs = idleSegments.reduce((total, segment) => total + segment.durationMs, 0);
  const lastFlightEnd = flightSegments.reduce((latest, segment) => Math.max(latest, segment.endedAt), 0);
  const activeMs = totalFlightMs + totalTurtleMs;
  return {
    start,
    end,
    durationMs,
    segmentCount: clipped.length,
    flightCount: flightSegments.length,
    turtleCount: turtleSegments.length,
    idleCount: idleSegments.length,
    totalFlightMs,
    totalTurtleMs,
    totalIdleMs,
    activeMs,
    utilization: totalFlightMs / durationMs,
    avgIdleMs: idleSegments.length ? totalIdleMs / idleSegments.length : totalFlightMs > 0 ? 0 : durationMs,
    flightTimePer10MinMs: totalFlightMs / Math.max(1, durationMs / (10 * 60 * 1000)),
    avgFlightDurationMs: flightSegments.length ? totalFlightMs / flightSegments.length : 0,
    turtleTimeRatio: totalTurtleMs / Math.max(1, activeMs),
    interruptionRatio: totalIdleMs / durationMs,
    lastFlightEnd: lastFlightEnd || null,
  };
}

function coachWindowScore(summary) {
  const utilizationScore = Math.min(1, summary.utilization / 0.45);
  const flightTimeScore = Math.min(1, summary.flightTimePer10MinMs / (4 * 60 * 1000));
  const activeScore = Math.min(1, summary.totalFlightMs / (5 * 60 * 1000));
  const idlePenalty = Math.min(1, summary.avgIdleMs / (6 * 60 * 1000));
  const turtlePenalty = Math.min(1, summary.turtleTimeRatio * 2);
  return (
    utilizationScore * 0.28 +
    flightTimeScore * 0.22 +
    activeScore * 0.18 -
    idlePenalty * 0.12 -
    turtlePenalty * 0.16
  );
}

function trendFromDelta(delta, deadband = 0.08) {
  if (delta > deadband) return "improving";
  if (delta < -deadband) return "degrading";
  return "stable";
}

function buildCoachReasons(features, recent, idleSinceLastFlightMs) {
  const reasons = [];
  if (idleSinceLastFlightMs >= 6 * 60 * 1000) reasons.push({ code: "long_idle", label: "距离上次飞行时间偏长" });
  if (features.totalFlightMs > 0 && features.totalFlightMs < 60 * 1000) reasons.push({ code: "low_flight_time", label: "\u6700\u8fd1\u98de\u884c\u65f6\u95f4\u504f\u5c11" });
  if (features.totalTurtleMs >= 30 * 1000 && features.turtleTimeRatio >= 0.2) reasons.push({ code: "turtle_time_high", label: "\u53cd\u4e4c\u9f9f\u65f6\u95f4\u5360\u6bd4\u504f\u9ad8" });
  if (features.utilization >= 0.35 && features.turtleTimeRatio < 0.15) reasons.push({ code: "pace_stable", label: "飞行时间和反乌龟时间保持正常" });
  return reasons;
}

function decideCoachState({ features, recent, trend, idleSinceLastFlightMs }) {
  if (recent.totalFlightMs <= 0 && idleSinceLastFlightMs >= 6 * 60 * 1000) return "inactive";
  if (trend.overall === "improving" && recent.totalFlightMs > 0) return "improving";
  if (
    (features.totalTurtleMs >= 30 * 1000 && features.turtleTimeRatio >= 0.2) ||
    (features.totalFlightMs > 0 && features.totalFlightMs < 60 * 1000 && idleSinceLastFlightMs >= 2 * 60 * 1000)
  ) {
    return "unstable";
  }
  return "stable";
}

function suggestionForCoachState(state, pilotName, reasons) {
  if (state === "inactive") return `${pilotName} 已经一段时间没有有效飞行，可以提醒他准备下一轮。`;
  if (state === "improving") return `${pilotName} 最近节奏在变好，保持当前强度，不要急着加难度。`;
  if (state === "unstable") {
    const hasTurtle = reasons.some((reason) => reason.code === "turtle_time_high");
    if (hasTurtle) return `${pilotName} 反乌龟偏多，建议先降低强度，做一轮稳定飞行。`;
    return `${pilotName} 最近有效飞行时间偏少，建议先完成一轮稳定飞行。`;
  }
  return `${pilotName} 当前状态稳定，继续观察即可。`;
}

function getCoachLlmConfig({ includeSecret = false } = {}) {
  const row = db.prepare("SELECT value_json FROM training_settings WHERE key = ?").get(COACH_LLM_CONFIG_KEY);
  const stored = safeJsonParse(row?.value_json, {});
  const config = {
    ...DEFAULT_COACH_LLM_CONFIG,
    ...(stored && typeof stored === "object" ? stored : {}),
  };
  config.enabled = Boolean(config.enabled);
  config.provider = String(config.provider || DEFAULT_COACH_LLM_CONFIG.provider).slice(0, 80);
  config.baseURL = String(config.baseURL || DEFAULT_COACH_LLM_CONFIG.baseURL).replace(/\/+$/, "").slice(0, 500);
  config.endpoint = String(config.endpoint || DEFAULT_COACH_LLM_CONFIG.endpoint).slice(0, 500);
  config.model = String(config.model || DEFAULT_COACH_LLM_CONFIG.model).slice(0, 120);
  config.apiKey = String(config.apiKey || "");
  config.systemPrompt = String(config.systemPrompt || DEFAULT_COACH_LLM_CONFIG.systemPrompt).slice(0, 4000);
  config.temperature = Math.max(0, Math.min(1, Number(config.temperature ?? 0.2)));
  config.maxTokens = Math.max(256, Math.min(8000, Math.floor(Number(config.maxTokens || 2500))));
  config.topP = Math.max(0.1, Math.min(1, Number(config.topP ?? 1)));
  config.stream = Boolean(config.stream);
  config.thinkingEnabled = config.thinkingEnabled !== false;
  config.timeoutMs = Math.max(3000, Math.min(30000, Number(config.timeoutMs || 12000)));
  config.autoIntervalMinutes = Math.max(1, Math.min(60, Number(config.autoIntervalMinutes || 5)));
  if (includeSecret) return config;
  return {
    ...config,
    apiKey: "",
    hasApiKey: Boolean(config.apiKey),
    lastError: coachLlmRuntime.lastError,
  };
}

function saveCoachLlmConfig(input) {
  const current = getCoachLlmConfig({ includeSecret: true });
  const next = {
    ...current,
    enabled: Boolean(input?.enabled),
    endpoint: String(input?.endpoint || current.endpoint).trim().slice(0, 500),
    provider: String(input?.provider || current.provider).trim().slice(0, 80),
    baseURL: String(input?.baseURL || current.baseURL).trim().replace(/\/+$/, "").slice(0, 500),
    model: String(input?.model || current.model).trim().slice(0, 120),
    apiKey: input?.apiKey === undefined ? current.apiKey : String(input.apiKey || "").trim(),
    systemPrompt: String(input?.systemPrompt || current.systemPrompt).slice(0, 4000),
    temperature: Math.max(0, Math.min(1, Number(input?.temperature ?? current.temperature))),
    maxTokens: Math.max(256, Math.min(8000, Math.floor(Number(input?.maxTokens || current.maxTokens || 2500)))),
    topP: Math.max(0.1, Math.min(1, Number(input?.topP ?? current.topP ?? 1))),
    stream: Boolean(input?.stream),
    thinkingEnabled: input?.thinkingEnabled === undefined ? current.thinkingEnabled : Boolean(input.thinkingEnabled),
    timeoutMs: Math.max(3000, Math.min(30000, Number(input?.timeoutMs || current.timeoutMs))),
    autoIntervalMinutes: Math.max(1, Math.min(60, Number(input?.autoIntervalMinutes || current.autoIntervalMinutes || 5))),
  };
  db.prepare(`
    INSERT INTO training_settings (key, value_json)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `).run(COACH_LLM_CONFIG_KEY, JSON.stringify(next));
  coachLlmRuntime.signatures.clear();
  coachLlmRuntime.autoCursor = 0;
  coachLlmRuntime.lastError = "";
  return getCoachLlmConfig();
}

function applyThinkingMode(body, config) {
  return {
    ...body,
    thinking: { type: config.thinkingEnabled ? "enabled" : "disabled" },
  };
}

function coachLlmSuggestionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "priority", "speakable", "reason"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 80 },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      speakable: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: 80 },
    },
  };
}

function coachEventSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["overallEvaluation", "atmosphere", "strongPilots", "attentionPilots", "nextRoundAdvice"],
    properties: {
      overallEvaluation: { type: "string", minLength: 1, maxLength: 160 },
      atmosphere: "\u8bad\u7ec3\u6c1b\u56f4\u5224\u65ad",
      strongPilots: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pilotName", "reason"],
          properties: {
            pilotName: { type: "string", minLength: 1, maxLength: 40 },
            reason: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
      attentionPilots: {
        type: "array",
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pilotName", "reason"],
          properties: {
            pilotName: { type: "string", minLength: 1, maxLength: 40 },
            reason: { type: "string", minLength: 1, maxLength: 80 },
          },
        },
      },
      nextRoundAdvice: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 80 } },
    },
  };
}

function sanitizeCoachLlmSuggestion(value) {
  if (!value || typeof value !== "object") return null;
  const priority = ["low", "medium", "high"].includes(value.priority) ? value.priority : "low";
  const message = String(value.message || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const reason = String(value.reason || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!message || !reason) return null;
  return {
    message,
    priority,
    speakable: Boolean(value.speakable),
    reason,
  };
}

function sanitizeCoachEventSummary(value) {
  if (!value || typeof value !== "object") return null;
  const text = (input, max = 120) => String(input || "").replace(/\s+/g, " ").trim().slice(0, max);
  const pilotList = (items) => (Array.isArray(items) ? items : [])
    .map((item) => ({ pilotName: text(item?.pilotName, 40), reason: text(item?.reason, 80) }))
    .filter((item) => item.pilotName && item.reason)
    .slice(0, 4);
  const nextRoundAdvice = (Array.isArray(value.nextRoundAdvice) ? value.nextRoundAdvice : [])
    .map((item) => text(item, 80))
    .filter(Boolean)
    .slice(0, 5);
  const summary = {
    overallEvaluation: text(value.overallEvaluation, 160),
      atmosphere: "\u8bad\u7ec3\u6c1b\u56f4\u5224\u65ad",
    strongPilots: pilotList(value.strongPilots),
    attentionPilots: pilotList(value.attentionPilots),
    nextRoundAdvice,
  };
  if (!summary.overallEvaluation || !summary.atmosphere || summary.nextRoundAdvice.length === 0) return null;
  return summary;
}

function parseCoachLlmJson(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = safeJsonParse(trimmed, null);
  if (parsed) return parsed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return safeJsonParse(trimmed.slice(start, end + 1), null);
  return null;
}

function coachLlmSignature(pilotSnapshot) {
  const features = pilotSnapshot.features || {};
  return JSON.stringify({
    state: pilotSnapshot.coachState,
    reasons: (pilotSnapshot.reasons || []).map((reason) => reason.code).sort(),
    trends: pilotSnapshot.trends || {},
    totalFlightMinute: Math.round(Number(features.totalFlightMs || 0) / 60000),
    totalTurtleSecond: Math.round(Number(features.totalTurtleMs || 0) / 10000) * 10,
    idleMinute: Math.round(Number(features.idleSinceLastFlightMs || 0) / 60000),
    turtleRatioPct: Math.round(Number(features.turtleTimeRatio || 0) * 100),
  });
}

function coachLlmPromptPayload(event, pilotSnapshot) {
  return {
    event: event ? { id: event.id, name: event.name, active: event.active, startedAt: event.startedAt } : null,
    pilot: {
      pilotId: pilotSnapshot.pilotId,
      pilotName: pilotSnapshot.pilotName,
      receiverId: pilotSnapshot.receiverId,
      coachState: pilotSnapshot.coachState,
      reasons: pilotSnapshot.reasons,
      trends: pilotSnapshot.trends,
      features: pilotSnapshot.features,
      ruleSuggestion: pilotSnapshot.suggestion,
    },
    outputContract: {
      message: "\u4e00\u53e5\u73b0\u573a\u52a9\u6559\u5efa\u8bae\uff0c\u9002\u5408\u76f4\u63a5\u5c55\u793a\u6216\u64ad\u62a5",
      priority: "low | medium | high",
      speakable: "是否适合人工点击后 TTS 播放",
      reason: "一句短原因",
    },
  };
}

function coachLlmRequestBody(config, event, pilotSnapshot, responseFormatType) {
  const schema = coachLlmSuggestionSchema();
  const body = applyThinkingMode({
    model: config.model,
    temperature: config.temperature,
    messages: [
      { role: "system", content: config.systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          coachSnapshot: coachLlmPromptPayload(event, pilotSnapshot),
          requiredJsonSchema: schema,
          instruction: "\u53ea\u8fd4\u56de\u4e00\u4e2a JSON \u5bf9\u8c61\uff0c\u4e0d\u8981 Markdown\uff0c\u4e0d\u8981\u591a\u4f59\u6587\u5b57\u3002",
        }),
      },
    ],
  }, config);
  if (responseFormatType === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "coach_suggested_message",
        strict: true,
        schema,
      },
    };
  } else if (responseFormatType === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

async function requestCoachLlmSuggestionWithFormat(config, event, pilotSnapshot, responseFormatType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(coachLlmRequestBody(config, event, pilotSnapshot, responseFormatType)),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 200)}`);
    const parsedBody = safeJsonParse(body, null);
    const content = parsedBody?.choices?.[0]?.message?.content;
    const parsedContent = parseCoachLlmJson(content);
    const suggestion = sanitizeCoachLlmSuggestion(parsedContent);
    if (!suggestion) throw new Error("LLM returned invalid suggestion JSON");
    return suggestion;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestCoachLlmSuggestion(config, event, pilotSnapshot) {
  const formats = ["json_schema", "json_object", null];
  let lastError = null;
  for (const format of formats) {
    try {
      return await requestCoachLlmSuggestionWithFormat(config, event, pilotSnapshot, format);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/response_format|unavailable|invalid_request|HTTP 400/i.test(message)) break;
    }
  }
  throw lastError || new Error("coach LLM request failed");
}

function coachEventSummaryPayload(event, pilotSnapshots, now = Date.now()) {
  const eventStart = optionalTimestamp(event?.startedAt) || optionalTimestamp(event?.createdAt) || now;
  const eventEnd = event?.active ? now : optionalTimestamp(event?.endedAt) || now;
  const durationMs = Math.max(1, eventEnd - eventStart);
  const totalFlightMs = pilotSnapshots.reduce((total, pilot) => total + Number(pilot.features?.totalFlightMs || 0), 0);
  const totalTurtleMs = pilotSnapshots.reduce((total, pilot) => total + Number(pilot.features?.totalTurtleMs || 0), 0);
  const states = pilotSnapshots.reduce((acc, pilot) => {
    acc[pilot.coachState] = (acc[pilot.coachState] || 0) + 1;
    return acc;
  }, {});
  const problemFlags = [];
  if (totalFlightMs / Math.max(1, durationMs * Math.max(1, pilotSnapshots.length)) < 0.2) problemFlags.push("\u8282\u594f\u6162");
  if (totalTurtleMs / Math.max(1, totalFlightMs + totalTurtleMs) >= 0.2) problemFlags.push("\u53cd\u4e4c\u9f9f\u504f\u591a");
  if ((states.improving || 0) > 0) problemFlags.push("\u6709\u8fdb\u6b65");
  if ((states.unstable || 0) === 0 && (states.inactive || 0) === 0) problemFlags.push("整体稳定");
  return {
    event: {
      id: event.id,
      name: event.name,
      startedAt: event.startedAt,
      durationMs,
      participantCount: pilotSnapshots.length,
      totalFlightMs,
      totalTurtleMs,
      overallUtilization: totalFlightMs / Math.max(1, durationMs * Math.max(1, pilotSnapshots.length)),
      problemFlags,
    },
    pilots: pilotSnapshots.map((pilot) => ({
      pilotId: pilot.pilotId,
      pilotName: pilot.pilotName,
      receiverId: pilot.receiverId,
      state: pilot.coachState,
      reasons: pilot.reasons,
      trends: pilot.trends,
      flightMs: pilot.features?.totalFlightMs || 0,
      utilization: pilot.features?.utilization || 0,
      avgIdleMs: pilot.features?.avgIdleMs || 0,
      turtleMs: pilot.features?.totalTurtleMs || 0,
      turtleTimeRatio: pilot.features?.turtleTimeRatio || 0,
    })),
    outputContract: {
      overallEvaluation: "本场整体评价",
      atmosphere: "\u8bad\u7ec3\u6c1b\u56f4\u5224\u65ad",
      strongPilots: "\u8868\u73b0\u8f83\u597d\u7684\u98de\u624b\u5217\u8868",
      attentionPilots: "需要关注的飞手列表",
      nextRoundAdvice: "\u4e0b\u4e00\u8f6e\u8bad\u7ec3\u5efa\u8bae\u6570\u7ec4",
    },
  };
}

async function requestCoachEventSummary(config, event, pilotSnapshots, now = Date.now()) {
  const schema = coachEventSummarySchema();
  const promptPayload = {
    coachEventSummaryInput: coachEventSummaryPayload(event, pilotSnapshots, now),
    requiredJsonSchema: schema,
    instruction: "\u53ea\u8fd4\u56de\u4e00\u4e2a JSON \u5bf9\u8c61\uff0c\u4e0d\u8981 Markdown\uff0c\u4e0d\u8981\u591a\u4f59\u6587\u5b57\u3002",
  };
  const formats = ["json_schema", "json_object", null];
  let lastError = null;
  for (const responseFormatType of formats) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const body = applyThinkingMode({
        model: config.model,
        temperature: config.temperature,
        messages: [
          { role: "system", content: `${config.systemPrompt}\n你现在要生成整场训练总结，不是单个飞手建议。` },
          { role: "user", content: JSON.stringify(promptPayload) },
        ],
      }, config);
      if (responseFormatType === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "coach_event_summary", strict: true, schema },
        };
      } else if (responseFormatType === "json_object") {
        body.response_format = { type: "json_object" };
      }
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${responseText.slice(0, 200)}`);
      const parsedBody = safeJsonParse(responseText, null);
      const parsedContent = parseCoachLlmJson(parsedBody?.choices?.[0]?.message?.content);
      const summary = sanitizeCoachEventSummary(parsedContent);
      if (!summary) throw new Error("LLM returned invalid event summary JSON");
      return summary;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/response_format|unavailable|invalid_request|HTTP 400/i.test(message)) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("coach event summary failed");
}

function historyStudentSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["studentSummary", "highlights", "problems", "nextAdvice", "parentMessage"],
    properties: {
      studentSummary: { type: "string", minLength: 1, maxLength: 160 },
      highlights: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 80 } },
      problems: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 80 } },
      nextAdvice: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 80 } },
      parentMessage: { type: "string", minLength: 1, maxLength: 160 },
    },
  };
}

function sanitizeHistoryStudentSummary(value) {
  if (!value || typeof value !== "object") return null;
  const text = (input, max = 120) => String(input || "").replace(/\s+/g, " ").trim().slice(0, max);
  const list = (items, maxItems = 4) => (Array.isArray(items) ? items : []).map((item) => text(item, 80)).filter(Boolean).slice(0, maxItems);
  const summary = {
    studentSummary: text(value.studentSummary, 160),
    highlights: list(value.highlights, 4),
    problems: list(value.problems, 4),
    nextAdvice: list(value.nextAdvice, 5),
    parentMessage: text(value.parentMessage, 160),
  };
  if (!summary.studentSummary || !summary.parentMessage || !summary.nextAdvice.length) return null;
  return summary;
}

function historyStudentAiInput(event, pilotSnapshot) {
  return {
    event: {
      id: event.id,
      name: event.name,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
    },
    student: {
      pilotId: pilotSnapshot.pilotId,
      pilotName: pilotSnapshot.pilotName,
      receiverId: pilotSnapshot.receiverId,
      training: {
        totalFlightMs: pilotSnapshot.features.totalFlightMs,
        utilization: pilotSnapshot.features.utilization,
        totalTurtleMs: pilotSnapshot.features.totalTurtleMs,
        sampleCount: pilotSnapshot.features.sampleCount,
      },
      coachNote: pilotSnapshot.review?.coach_note || "",
      quizResult: pilotSnapshot.review?.quiz_result || "",
    },
  };
}

function historyClassAiInput(event, pilotSnapshots, tasks = []) {
  return {
    event: {
      id: event.id,
      name: event.name,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      participantCount: pilotSnapshots.length,
    },
    students: pilotSnapshots.map((pilot) => historyStudentAiInput(event, pilot).student),
    coachTasks: tasks.map((task) => ({
      minute: task.minute,
      action: task.action,
      pilotName: task.pilotName || "",
      focus: task.focus || task.content || "",
      completed: Boolean(task.completedAt || task.completed),
    })),
  };
}

function historyPilotSnapshot(event, participant, review = null) {
  const stat = getEventParticipantStat(event.id, participant.pilotId) || {
    totalFlightMs: 0,
    utilization: 0,
    totalTurtleMs: 0,
    sampleCount: 0,
  };
  const comparison = comparePilotProgress(event, participant.pilotId, stat, review);
  const turtleTimeRatio = stat.totalTurtleMs / Math.max(1, stat.totalFlightMs + stat.totalTurtleMs);
  return {
    pilotId: participant.pilotId,
    pilotName: participant.pilotName || participant.pilotId,
    receiverId: participant.receiverId,
    coachState: comparison.direction === "improved" ? "improving" : comparison.direction === "declined" ? "unstable" : "stable",
    reasons: comparison.reasons.map((reason) => ({ code: reason, label: reason })),
    trends: { overall: comparison.direction },
    comparison,
    review: review || null,
    features: {
      totalFlightMs: stat.totalFlightMs,
      utilization: stat.utilization,
      avgIdleMs: 0,
      totalTurtleMs: stat.totalTurtleMs,
      turtleTimeRatio,
      sampleCount: stat.sampleCount,
    },
  };
}

function historyEventSnapshots(eventId) {
  const event = getTeachingEvent(eventId);
  if (!event) return null;
  const pilots = new Map(db.prepare("SELECT * FROM pilots").all().map((row) => {
    const pilot = pilotFromRow(row);
    return [pilot.id, pilot];
  }));
  const reviewMap = new Map(lessonReviewsForEvent(eventId).map((review) => [review.pilot_id, review]));
  return {
    event,
    reviews: reviewMap,
    pilotSnapshots: (event.participants || []).filter((participant) => participant.pilotId).map((participant) => {
      const pilot = pilots.get(participant.pilotId);
      return historyPilotSnapshot(event, { ...participant, pilotName: pilot?.name || participant.pilotId }, reviewMap.get(participant.pilotId) || null);
    }),
  };
}

async function requestHistoryJsonSummary({ config, schema, schemaName, systemPrompt, promptPayload, sanitize }) {
  const formats = ["json_schema", "json_object", null];
  let lastError = null;
  for (const responseFormatType of formats) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const body = applyThinkingMode({
        model: config.model,
        temperature: config.temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(promptPayload) },
        ],
      }, config);
      if (responseFormatType === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        };
      } else if (responseFormatType === "json_object") {
        body.response_format = { type: "json_object" };
      }
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${responseText.slice(0, 200)}`);
      const parsedBody = safeJsonParse(responseText, null);
      const rawOutput = parsedBody?.choices?.[0]?.message?.content || "";
      const parsedContent = parseCoachLlmJson(rawOutput);
      const summary = sanitize(parsedContent);
      if (!summary) throw new Error("LLM returned invalid summary JSON");
      return {
        summary,
        audit: {
          systemPrompt,
          input: promptPayload,
          rawOutput,
          parsedOutput: summary,
          responseFormat: responseFormatType || "none",
        },
      };
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      if (!/response_format|unavailable|invalid_request|HTTP 400/i.test(message)) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("history summary failed");
}

async function requestHistoryStudentSummary(config, event, pilotSnapshot, systemPrompt) {
  const schema = historyStudentSummarySchema();
  const promptPayload = {
    ...historyStudentAiInput(event, pilotSnapshot),
    outputContract: {
      studentSummary: "本次训练给家长/教练看的简短总结",
      highlights: "表现亮点数组",
      problems: "需要改进数组",
      nextAdvice: "下次训练建议数组",
      parentMessage: "适合发给家长的一段话",
    },
    requiredJsonSchema: schema,
    instruction: "只返回一个 JSON 对象，不要 Markdown，不要多余文字。",
  };
  return requestHistoryJsonSummary({
    config,
    schema,
    schemaName: "history_student_summary",
    systemPrompt,
    promptPayload,
    sanitize: sanitizeHistoryStudentSummary,
  });
}

async function requestHistoryClassSummary(config, event, pilotSnapshots, tasks, systemPrompt) {
  const schema = coachEventSummarySchema();
  const promptPayload = {
    ...historyClassAiInput(event, pilotSnapshots, tasks),
    outputContract: {
      overallEvaluation: "本场训练整体评价",
      atmosphere: "\u8bad\u7ec3\u6c1b\u56f4\u5224\u65ad",
      strongPilots: "表现较好的学生列表",
      attentionPilots: "需要关注的学生列表",
      nextRoundAdvice: "下一次训练建议数组",
    },
    requiredJsonSchema: schema,
    instruction: "只返回一个 JSON 对象，不要 Markdown，不要多余文字。只基于今天的学生训练情况、教练评语、小测，不要判断进步/退步。",
  };
  return requestHistoryJsonSummary({
    config,
    schema,
    schemaName: "history_class_summary",
    systemPrompt,
    promptPayload,
    sanitize: sanitizeCoachEventSummary,
  });
}

function attachCoachLlmSuggestions(event, pilotSnapshots) {
  return pilotSnapshots.map((pilotSnapshot) => {
    const key = `${event?.id || ""}:${pilotSnapshot.pilotId}:${pilotSnapshot.receiverId}`;
    return {
      ...pilotSnapshot,
      suggestedMessage: coachLlmRuntime.suggestions.get(key) || null,
    };
  });
}

function queueCoachLlmSuggestions(event, pilotSnapshots) {
  const config = getCoachLlmConfig({ includeSecret: true });
  if (!config.enabled || !config.apiKey || !config.endpoint || !config.model) return;
  if (coachLlmRuntime.inFlight.size > 0) return;
  const now = Date.now();
  const minIntervalMs = Math.max(1, Number(config.autoIntervalMinutes || 5)) * 60 * 1000;
  const candidates = pilotSnapshots.map((pilotSnapshot, index) => ({
    index,
    pilotSnapshot,
    key: `${event.id}:${pilotSnapshot.pilotId}:${pilotSnapshot.receiverId}`,
    signature: coachLlmSignature(pilotSnapshot),
  }));
  const startIndex = candidates.length ? coachLlmRuntime.autoCursor % candidates.length : 0;
  const orderedCandidates = [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];

  for (const { index, pilotSnapshot, key, signature } of orderedCandidates) {
    if (coachLlmRuntime.signatures.get(key) === signature || coachLlmRuntime.inFlight.has(key)) continue;
    if (now - (coachLlmRuntime.autoRequestedAt.get(key) || 0) < minIntervalMs) continue;
    coachLlmRuntime.autoCursor = index + 1;
    coachLlmRuntime.signatures.set(key, signature);
    coachLlmRuntime.autoRequestedAt.set(key, now);
    coachLlmRuntime.inFlight.add(key);
    void requestCoachLlmSuggestion(config, event, pilotSnapshot)
      .then((suggestion) => {
        coachLlmRuntime.suggestions.set(key, {
          ...suggestion,
          generatedAt: Date.now(),
          eventId: event.id,
          pilotId: pilotSnapshot.pilotId,
          pilotName: pilotSnapshot.pilotName,
          receiverId: pilotSnapshot.receiverId,
          signature,
        });
        coachLlmRuntime.lastError = "";
      })
      .catch((error) => {
        coachLlmRuntime.lastError = error.message || "coach LLM request failed";
        coachLlmRuntime.signatures.delete(key);
      })
      .finally(() => {
        coachLlmRuntime.inFlight.delete(key);
      });
    break;
  }
}

function buildCoachPilotSnapshot({ event, participant, pilot, stat, segments, now }) {
  const trainingWindow = getParticipantTrainingWindow(event, participant, now);
  const end = event.active ? now : trainingWindow.end;
  const start = trainingWindow.start;
  const recentStart = Math.max(start, end - COACH_WINDOW_MS);
  const previousStart = Math.max(start, recentStart - COACH_WINDOW_MS);
  const previousEnd = recentStart;
  const session = summarizeCoachWindow(segments, start, end);
  const recent = summarizeCoachWindow(segments, recentStart, end);
  const previous = previousEnd > previousStart
    ? summarizeCoachWindow(segments, previousStart, previousEnd)
    : summarizeCoachWindow([], previousStart, previousEnd);
  const recentScore = coachWindowScore(recent);
  const previousScore = coachWindowScore(previous);
  const idleSinceLastFlightMs = session.lastFlightEnd ? Math.max(0, end - session.lastFlightEnd) : Math.max(0, end - start);
  const features = {
    utilization: stat ? Number(stat.total_flight_ms || 0) / Math.max(1, end - start) : session.utilization,
    avgIdleMs: recent.avgIdleMs,
    flightTimePer10MinMs: recent.flightTimePer10MinMs,
    avgFlightDurationMs: recent.avgFlightDurationMs,
    totalFlightMs: recent.totalFlightMs,
    totalTurtleMs: recent.totalTurtleMs,
    turtleTimeRatio: recent.turtleTimeRatio,
    interruptionRatio: recent.interruptionRatio,
    idleSinceLastFlightMs,
  };
  const trends = {
    utilization: trendFromDelta(recent.utilization - previous.utilization, 0.05),
    stability: trendFromDelta(previous.turtleTimeRatio - recent.turtleTimeRatio, 0.08),
    overall: trendFromDelta(recentScore - previousScore),
  };
  const coachState = decideCoachState({ features, recent, trend: trends, idleSinceLastFlightMs });
  const reasons = buildCoachReasons(features, recent, idleSinceLastFlightMs);

  return {
    pilotId: participant.pilotId,
    pilotName: pilot?.name || participant.pilotId,
    receiverId: participant.receiverId,
    window: { start, end, recentStart, previousStart, previousEnd },
    features,
    trends,
    coachState,
    reasons,
    suggestion: suggestionForCoachState(coachState, pilot?.name || participant.pilotId, reasons),
    debug: {
      sessionSegments: session.segmentCount,
      recentSegments: recent.segmentCount,
      previousSegments: previous.segmentCount,
      recentScore,
      previousScore,
    },
  };
}

function refreshCoachSnapshot(now = Date.now()) {
  try {
    const eventRow = activeEventQuery.get();
    if (!eventRow) {
      coachSnapshotStore.activeEventId = null;
      coachSnapshotStore.generatedAt = now;
      coachSnapshotStore.stale = false;
      coachSnapshotStore.event = null;
      coachSnapshotStore.pilots = [];
      coachSnapshotStore.eventSummary = null;
      coachSnapshotStore.error = "";
      return coachSnapshotStore;
    }

    const event = eventFromRow(eventRow);
    const overview = readCachedEventOverview(event.id);
    const pilotsById = new Map(allPilotsQuery.all().map((row) => {
      const pilot = pilotFromRow(row);
      return [pilot.id, pilot];
    }));
    const statsByPilot = new Map((overview.stats || []).map((stat) => [stat.pilot_id, stat]));
    const segmentsByPilot = new Map();
    for (const segment of overview.segments || []) {
      const list = segmentsByPilot.get(segment.pilot_id) || [];
      list.push(segment);
      segmentsByPilot.set(segment.pilot_id, list);
    }

    const pilotSnapshots = (event.participants || []).map((participant) => buildCoachPilotSnapshot({
      event,
      participant,
      pilot: pilotsById.get(participant.pilotId),
      stat: statsByPilot.get(participant.pilotId),
      segments: segmentsByPilot.get(participant.pilotId) || [],
      now,
    }));
    queueCoachLlmSuggestions(event, pilotSnapshots);

    coachSnapshotStore.activeEventId = event.id;
    coachSnapshotStore.generatedAt = now;
    coachSnapshotStore.stale = false;
    coachSnapshotStore.event = event;
    coachSnapshotStore.pilots = attachCoachLlmSuggestions(event, pilotSnapshots);
    coachSnapshotStore.eventSummary = coachLlmRuntime.eventSummary?.eventId === event.id ? coachLlmRuntime.eventSummary : null;
    coachSnapshotStore.error = "";
    return coachSnapshotStore;
  } catch (error) {
    coachSnapshotStore.generatedAt = now;
    coachSnapshotStore.stale = true;
    coachSnapshotStore.error = error.message || "coach snapshot failed";
    return coachSnapshotStore;
  }
}

function getCoachSnapshot(now = Date.now()) {
  return {
    ...coachSnapshotStore,
    stale: Boolean(coachSnapshotStore.stale || !coachSnapshotStore.generatedAt || now - coachSnapshotStore.generatedAt > COACH_STALE_AFTER_MS),
    serverTime: now,
    refreshIntervalMs: COACH_SNAPSHOT_INTERVAL_MS,
    windowMs: COACH_WINDOW_MS,
  };
}

// Coach password authentication
const COACH_PASSWORD = String(process.env.COACH_PASSWORD || "");

function requireCoachPassword(req, res, next) {
  if (!COACH_PASSWORD) {
    return res.status(500).json({ error: "\u672a\u914d\u7f6e COACH_PASSWORD \u73af\u5883\u53d8\u91cf" });
  }
  const provided = String(req.headers["x-coach-password"] || req.query._password || "");
  if (provided !== COACH_PASSWORD) {
    return res.status(403).json({ error: "\u6559\u7ec3\u5bc6\u7801\u9519\u8bef" });
  }
  next();
}

app.post("/api/coach/auth", requireCoachPassword, (req, res) => {
  res.json({ ok: true });
});
return {
  applyThinkingMode, buildCoachPilotSnapshot, coachLlmSignature,
  getCoachLlmConfig, getCoachSnapshot,
  historyEventSnapshots, refreshCoachSnapshot,
  requestCoachEventSummary, requestCoachLlmSuggestion, requestHistoryClassSummary,
  requestHistoryStudentSummary, requireCoachPassword, saveCoachLlmConfig,
};
}
