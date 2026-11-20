import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut, buttonStyle, dangerButtonStyle, formatDuration, inputStyle, panelStyle, primaryButtonStyle, textareaStyle } from "../trainingShared.js";

const defaultAiConfig = {
  includeTasks: true,
  includeReviews: true,
  systemPrompt: "你是 FPV 训练课后总结助手。请只基于本次训练数据、教练评语和小测情况生成总结，不要判断学生进步或退步。",
};

function formatDateTime(ms) {
  if (!ms) return "未记录";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function formatTime(ms) {
  if (!ms) return "--:--:--";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTimeLocal(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function parseDateTimeLocal(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function getEventDuration(event) {
  if (!event?.startedAt) return 0;
  return (event.endedAt || Date.now()) - event.startedAt;
}

function taskCompletion(tasks = []) {
  if (!tasks.length) return { done: 0, total: 0, pct: 0 };
  const done = tasks.filter((task) => task.completedAt).length;
  return { done, total: tasks.length, pct: Math.round((done / tasks.length) * 100) };
}

function reviewMapFromDetail(detail) {
  return new Map((detail?.reviews || []).map((review) => [review.pilot_id || review.pilotId, review]));
}

function MiniWaveform({ samples, segments, eventStart, eventEnd }) {
  const width = 780;
  const height = 86;
  if (!samples?.length && !segments?.length) return <div style={{ color: "#64748b", fontSize: 13 }}>暂无采样</div>;
  const start = eventStart || samples?.[0]?.time || segments?.[0]?.startedAt;
  const end = Math.max(start + 1, eventEnd || samples?.[samples.length - 1]?.time || segments?.[segments.length - 1]?.endedAt || start + 1);
  const bands = segments?.length ? segments.map((segment) => ({
    state: segment.type === "flight" ? "flying" : segment.type === "turtle" ? "turtle" : "idle",
    start: segment.startedAt,
    end: segment.endedAt,
  })) : [];
  const colorByState = { turtle: "#fed7aa", flying: "#bbf7d0", idle: "#f1f5f9" };

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="104" preserveAspectRatio="none" style={{ border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff" }}>
        {bands.map((band, index) => {
          const bandStart = Math.max(start, band.start);
          const bandEnd = Math.min(end, band.end);
          const x = ((bandStart - start) / Math.max(1, end - start)) * width;
          const bandWidth = Math.max(1, ((bandEnd - bandStart) / Math.max(1, end - start)) * width);
          return <rect key={`${band.state}-${index}`} x={x} y="0" width={bandWidth} height={height} fill={colorByState[band.state]} />;
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 12, marginTop: 6 }}>
        <span>{formatTime(start)}</span>
        <span>{formatTime(start + (end - start) / 2)}</span>
        <span>{formatTime(end)}</span>
      </div>
    </div>
  );
}

function OverviewStrip({ segments, eventStart, eventEnd }) {
  const width = 760;
  const height = 44;
  const start = eventStart || segments?.[0]?.startedAt || eventEnd || 0;
  const end = Math.max(start + 1, eventEnd || segments?.[segments.length - 1]?.endedAt || start + 1);
  const colorByState = { turtle: "#fb923c", flight: "#34d399", idle: "#e2e8f0" };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="44"
      preserveAspectRatio="none"
      aria-label="训练状态条带"
      style={{ display: "block", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0" }}
    >
      {(segments || []).map((segment, index) => {
        const segmentStart = Math.max(start, segment.startedAt);
        const segmentEnd = Math.min(end, segment.endedAt);
        if (segmentEnd <= segmentStart) return null;
        const x = ((segmentStart - start) / Math.max(1, end - start)) * width;
        const segmentWidth = Math.max(1, ((segmentEnd - segmentStart) / Math.max(1, end - start)) * width);
        return <rect key={`${segment.type}-${index}`} x={x} y="0" width={segmentWidth} height={height} fill={colorByState[segment.type] || colorByState.idle} />;
      })}
    </svg>
  );
}

function ParentOverviewCard({ detail, onClose }) {
  const event = detail?.event || {};
  const rankedParticipants = [...(detail?.participants || [])].sort((left, right) => (
    Number(right.totalFlightMs || 0) - Number(left.totalFlightMs || 0)
    || Number(right.utilization || 0) - Number(left.utilization || 0)
    || String(left.pilotName || "").localeCompare(String(right.pilotName || ""), "zh-CN")
  ));
  const eventStart = event.startedAt || event.createdAt;
  const eventEnd = event.endedAt || detail?.generatedAt;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 50, padding: 16, background: "rgba(15, 23, 42, .62)", display: "grid", placeItems: "center" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="parent-overview-title"
        style={{ width: "min(1180px, 100%)", maxHeight: "calc(100vh - 32px)", overflow: "auto", borderRadius: 22, background: "#f8fafc", boxShadow: "0 24px 70px rgba(15, 23, 42, .28)", padding: "clamp(18px, 3vw, 34px)", color: "#0f172a" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 20 }}>
          <div>
            <div style={{ color: "#2563eb", fontWeight: 900, letterSpacing: ".08em", fontSize: 12 }}>FPV TRAINING</div>
            <h2 id="parent-overview-title" style={{ margin: "5px 0 7px", fontSize: "clamp(24px, 4vw, 34px)", lineHeight: 1.15 }}>训练总览</h2>
            <div style={{ color: "#475569", fontSize: 14 }}>{event.name || "训练事件"} · {formatDateTime(eventStart)}</div>
          </div>
          <button type="button" aria-label="关闭家长展示总览" style={{ ...buttonStyle, flex: "0 0 auto" }} onClick={onClose}>关闭</button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "12px 14px", borderRadius: 14, background: "#e0f2fe", color: "#0c4a6e", marginBottom: 20 }}>
          <strong>{rankedParticipants.length} 位飞手</strong>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
            <span><i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 99, background: "#34d399", marginRight: 4 }} />飞行</span>
            <span><i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 99, background: "#fb923c", marginRight: 4 }} />反乌龟</span>
            <span><i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 99, background: "#cbd5e1", marginRight: 4 }} />待机</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(460px, 1fr))", gap: 14 }}>
          {rankedParticipants.map((participant, index) => (
            <article key={`${participant.pilotId}-${participant.receiverId}`} style={{ border: "1px solid #dbeafe", borderRadius: 16, padding: 15, background: "#fff", display: "grid", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                <strong style={{ fontSize: 18, overflowWrap: "anywhere" }}>{participant.pilotName || "未命名飞手"}</strong>
                <span style={{ flex: "0 0 auto", color: "#2563eb", fontWeight: 900, fontSize: 13 }}>第 {index + 1} 名</span>
              </div>
              <OverviewStrip segments={participant.segments} eventStart={eventStart} eventEnd={eventEnd} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <div style={{ flex: "1 1 180px" }}><div style={{ color: "#64748b", fontSize: 12 }}>飞行时长</div><strong style={{ whiteSpace: "nowrap" }}>{formatDuration(participant.totalFlightMs || 0)}</strong></div>
                <div style={{ flex: "1 1 102px" }}><div style={{ color: "#64748b", fontSize: 12 }}>利用率</div><strong style={{ whiteSpace: "nowrap" }}>{Math.round(Number(participant.utilization || 0) * 100)}%</strong></div>
                <div style={{ flex: "1 1 140px" }}><div style={{ color: "#64748b", fontSize: 12 }}>反乌龟</div><strong style={{ whiteSpace: "nowrap" }}>{formatDuration(participant.totalTurtleMs || 0)}</strong></div>
              </div>
            </article>
          ))}
        </div>
        {!rankedParticipants.length && <div style={{ padding: 24, color: "#64748b", textAlign: "center" }}>本次训练暂无飞手统计。</div>}
      </section>
    </div>
  );
}

function TaskSummary({ tasks }) {
  const completion = taskCompletion(tasks);
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, background: "#f8fafc", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <strong>教练任务完成率</strong>
        <span style={{ color: "#2563eb", fontWeight: 900 }}>{completion.done}/{completion.total} · {completion.pct}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "#e2e8f0", overflow: "hidden" }}>
        <div style={{ width: `${completion.pct}%`, height: "100%", background: "#2563eb" }} />
      </div>
      <div style={{ display: "grid", gap: 6, maxHeight: 220, overflow: "auto" }}>
        {(tasks || []).map((task) => {
          const planned = Number(task.minute || task.relativeMinute || 0);
          const delta = task.completedAt && task.eventStartedAt ? Math.round((task.completedAt - task.eventStartedAt) / 60000) - planned : null;
          return (
            <div key={task.id || task.taskId} style={{ display: "grid", gridTemplateColumns: "52px 74px minmax(0,1fr) 78px", gap: 8, alignItems: "center", fontSize: 12, borderBottom: "1px solid #e2e8f0", paddingBottom: 6 }}>
              <strong>{planned}min</strong>
              <span style={{ color: task.completedAt ? "#047857" : "#64748b" }}>{task.completedAt ? "已处理" : "未处理"}</span>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{task.pilotName ? `${task.pilotName} · ` : ""}{task.action || "任务"}：{task.focus || task.content || ""}</span>
              <span style={{ color: delta == null ? "#94a3b8" : delta > 0 ? "#b45309" : "#047857" }}>{delta == null ? "无时间差" : `${delta >= 0 ? "+" : ""}${delta}min`}</span>
            </div>
          );
        })}
        {!tasks?.length && <div style={{ color: "#64748b", fontSize: 13 }}>本事件暂无教练任务。</div>}
      </div>
    </div>
  );
}

function ClassAiSummary({ summary }) {
  if (!summary) return null;
  return (
    <div style={{ border: "1px solid #bfdbfe", borderRadius: 12, padding: 12, background: "#eff6ff", display: "grid", gap: 8 }}>
      <strong style={{ color: "#0f172a" }}>班级 AI 总结</strong>
      <div>{summary.overallEvaluation}</div>
      <div style={{ color: "#334155" }}>氛围：{summary.atmosphere}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
        <div><strong>表现较好</strong>{(summary.strongPilots || []).map((item) => <div key={`${item.pilotName}-${item.reason}`} style={{ fontSize: 13 }}>{item.pilotName}：{item.reason}</div>)}</div>
        <div><strong>需要关注</strong>{(summary.attentionPilots || []).map((item) => <div key={`${item.pilotName}-${item.reason}`} style={{ fontSize: 13 }}>{item.pilotName}：{item.reason}</div>)}</div>
      </div>
      <div><strong>下次建议</strong>{(summary.nextRoundAdvice || []).map((item) => <div key={item} style={{ fontSize: 13 }}>- {item}</div>)}</div>
    </div>
  );
}

function StudentAiSummary({ summary }) {
  if (!summary) return null;
  return (
    <details style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#f8fafc" }}>
      <summary style={{ cursor: "pointer", fontWeight: 800 }}>总结</summary>
      <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        <div>{summary.studentSummary}</div>
        <div style={{ color: "#334155", fontSize: 13 }}>家长话术：{summary.parentMessage}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8, fontSize: 13 }}>
          <div><strong>亮点</strong>{(summary.highlights || []).map((item) => <div key={item}>- {item}</div>)}</div>
          <div><strong>问题</strong>{(summary.problems || []).map((item) => <div key={item}>- {item}</div>)}</div>
          <div><strong>建议</strong>{(summary.nextAdvice || []).map((item) => <div key={item}>- {item}</div>)}</div>
        </div>
      </div>
    </details>
  );
}

export default function HistoryPage({ events, onDeleteEvent, onEventUpdated }) {
  const finishedEvents = useMemo(
    () => [...events].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0)),
    [events],
  );
  const [selectedId, setSelectedId] = useState(finishedEvents[0]?.id || "");
  const [detail, setDetail] = useState(null);
  const [reviews, setReviews] = useState({});
  const [status, setStatus] = useState("");
  const [openPilotId, setOpenPilotId] = useState("");
  const [aiConfig, setAiConfig] = useState(defaultAiConfig);
  const [aiSummary, setAiSummary] = useState(null);
  const [trimEndText, setTrimEndText] = useState("");
  const [trimEditingId, setTrimEditingId] = useState("");
  const [parentOverviewOpen, setParentOverviewOpen] = useState(false);
  const activeSelectedId = selectedId || finishedEvents[0]?.id || "";

  const loadDetail = useCallback(async (eventId = activeSelectedId) => {
    if (!eventId) return;
    setStatus("正在读取详情...");
    const nextDetail = await apiGet(`/api/events/${eventId}/detail`, null);
    const reviewMap = reviewMapFromDetail(nextDetail);
    setDetail(nextDetail);
    setReviews(Object.fromEntries((nextDetail?.participants || []).map((participant) => [participant.pilotId, reviewMap.get(participant.pilotId) || {}])));
    setOpenPilotId(nextDetail?.participants?.[0]?.pilotId || "");
    setAiConfig({ ...defaultAiConfig, ...(nextDetail?.aiSummaryConfig || {}) });
    setAiSummary(nextDetail?.aiSummary || null);
    setTrimEndText(formatDateTimeLocal(nextDetail?.lastSampleAt || nextDetail?.event?.endedAt || Date.now()));
    setStatus(nextDetail ? "详情已读取" : "详情读取失败");
    return nextDetail;
  }, [activeSelectedId]);

  useEffect(() => {
    if (!activeSelectedId) return;
    let stopped = false;
    async function run() {
      await loadDetail(activeSelectedId);
      if (stopped) return;
    }
    run();
    return () => {
      stopped = true;
    };
  }, [activeSelectedId, loadDetail]);

  useEffect(() => {
    if (!parentOverviewOpen) return undefined;
    function closeOnEscape(event) {
      if (event.key === "Escape") setParentOverviewOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [parentOverviewOpen]);

  async function deleteEvent(eventId) {
    const event = finishedEvents.find((item) => item.id === eventId);
    if (!window.confirm(`确定永久删除训练“${event?.name || eventId}”及其全部数据吗？此操作不可恢复。`)) return;
    setStatus("正在删除事件...");
    try {
      await apiDelete(`/api/events/${eventId}`);
      await onDeleteEvent(eventId);
      setDetail(null);
      setSelectedId("");
      setTrimEditingId("");
      setStatus("事件已删除");
    } catch (error) {
      setStatus(`删除失败：${error.message}`);
    }
  }

  async function openTrimEditor(event) {
    setSelectedId(event.id);
    const nextDetail = detail?.event?.id === event.id ? detail : await loadDetail(event.id);
    setTrimEndText(formatDateTimeLocal(nextDetail?.lastSampleAt || event.endedAt || Date.now()));
    setTrimEditingId(event.id);
  }

  async function trimEvent(eventId = activeSelectedId) {
    if (!eventId) return;
    const endedAt = parseDateTimeLocal(trimEndText);
    if (!endedAt) {
      setStatus("请输入有效的裁剪结束时间");
      return;
    }
    if (!window.confirm(`确定把训练结束时间修剪到 ${formatDateTime(endedAt)}，并永久删除此后的无用采样吗？`)) return;
    setStatus("正在修剪训练记录...");
    try {
      const result = await apiPost(`/api/events/${eventId}/trim`, { endedAt });
      onEventUpdated?.(result.event);
      await loadDetail(eventId);
      setTrimEditingId("");
      setStatus(`修剪完成，删除了 ${result.deletedSamples || 0} 条截止时间后的采样`);
    } catch (error) {
      setStatus(`修剪失败：${error.message}`);
    }
  }

  async function recomputeEvent(eventId) {
    setStatus("正在重新计算已结束事件...");
    try {
      await apiPost(`/api/events/${eventId}/recompute`, {});
      if (activeSelectedId === eventId) await loadDetail(eventId);
      setStatus("已按当前参训人员与起止时间重新计算");
    } catch (error) {
      setStatus(`重新计算失败：${error.message}`);
    }
  }

  function updateReview(pilotId, patch) {
    setReviews((current) => ({ ...current, [pilotId]: { ...(current[pilotId] || {}), ...patch } }));
  }

  async function saveReview(pilotId) {
    if (!activeSelectedId) return;
    setStatus("正在保存总结并同步成长记录...");
    try {
      const result = await apiPut(`/api/teaching/events/${activeSelectedId}/review/${pilotId}`, reviews[pilotId] || {});
      updateReview(pilotId, result.review || {});
      await loadDetail(activeSelectedId);
      setStatus("已保存，并同步成长记录");
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  async function generateAiSummary(scope, pilotId = "") {
    if (!activeSelectedId) return;
    setStatus(scope === "student" ? "正在生成单个学生总结..." : "正在生成班级总结...");
    try {
      const savedConfig = await apiPost("/api/ai-summary-config", aiConfig);
      setAiConfig({ ...defaultAiConfig, ...(savedConfig || aiConfig) });
      const result = await apiPost(`/api/events/${activeSelectedId}/ai-summary`, { scope, pilotId, config: savedConfig || aiConfig });
      setAiSummary(result.aiSummary || aiSummary);
      setAiConfig({ ...defaultAiConfig, ...(result.config || aiConfig) });
      setStatus("AI 总结已生成");
    } catch (error) {
      setStatus(`AI 总结失败：${error.message}`);
    }
  }

  const completion = taskCompletion(detail?.coachTasks || []);
  const classSummary = aiSummary?.classSummary || null;
  const studentSummaries = aiSummary?.studentSummaries || {};

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <h2 style={{ marginTop: 0, color: "#0f172a", fontWeight: 900, textAlign: "left" }}>训练事件列表</h2>
        {finishedEvents.length === 0 && <div style={{ color: "#64748b" }}>还没有训练事件。</div>}
        <div style={{ display: "grid", gap: 8 }}>
          {finishedEvents.map((event) => (
            <div key={event.id} style={{ display: "grid", gridTemplateColumns: "minmax(150px,1.4fr) minmax(145px,1.1fr) minmax(145px,1.1fr) 90px minmax(290px,auto)", gap: 10, alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: activeSelectedId === event.id ? "#eff6ff" : "#fff" }}>
              <strong>{event.name}</strong>
              <span style={{ color: "#64748b", fontSize: 13 }}>开始：{formatDateTime(event.startedAt)}</span>
              <span style={{ color: "#64748b", fontSize: 13 }}>结束：{formatDateTime(event.endedAt)}</span>
              <span>{formatDuration(getEventDuration(event))}</span>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, flexWrap: "wrap" }}>
                <button type="button" style={activeSelectedId === event.id ? primaryButtonStyle : buttonStyle} onClick={() => setSelectedId(event.id)}>详情</button>
                {event.endedAt && <button type="button" style={buttonStyle} onClick={() => recomputeEvent(event.id)}>重算</button>}
                <button type="button" style={{ ...buttonStyle, border: "none", background: "transparent", color: "#475569", padding: "0 7px" }} onClick={() => (trimEditingId === event.id ? setTrimEditingId("") : openTrimEditor(event))}>调整结束</button>
                <button type="button" style={{ ...dangerButtonStyle, background: "transparent", color: "#b91c1c", border: "none", padding: "0 7px" }} onClick={() => deleteEvent(event.id)}>删除</button>
              </div>
              {trimEditingId === event.id && (
                <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap", borderTop: "1px solid #dbeafe", paddingTop: 9, color: "#64748b", fontSize: 12 }}>
                  <span>保留到</span>
                  <input type="datetime-local" value={trimEndText} onChange={(item) => setTrimEndText(item.target.value)} style={{ ...inputStyle, width: 205, height: 32 }} />
                  <button type="button" style={{ ...buttonStyle, height: 32 }} onClick={() => trimEvent(event.id)}>确认修剪</button>
                  <button type="button" style={{ ...buttonStyle, height: 32, border: "none", background: "transparent" }} onClick={() => setTrimEditingId("")}>取消</button>
                  <span>此时间之后的数据会删除并重算统计</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ marginTop: 0, color: "#0f172a", fontWeight: 900, textAlign: "left" }}>智能总结面板</h2>
          <span style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13 }}>{status}</span>
        </div>

        {!detail && <div style={{ color: "#64748b", marginTop: 12 }}>请选择一个训练事件。</div>}
        {detail && (
          <div style={{ marginTop: 12, display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 10 }}>
              <div><strong>事件名称</strong><div>{detail.event.name}</div></div>
              <div><strong>参与人数</strong><div>{detail.participants.length}</div></div>
              <div><strong>训练时长</strong><div>{formatDuration(getEventDuration(detail.event))}</div></div>
              <div><strong>任务完成</strong><div>{completion.done}/{completion.total} · {completion.pct}%</div></div>
            </div>

            <div style={{ border: "1px solid #bfdbfe", borderRadius: 12, padding: 12, background: "#eff6ff", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <strong style={{ color: "#0f172a" }}>家长展示总览</strong>
                <div style={{ color: "#475569", fontSize: 13, marginTop: 3 }}>集中展示每位飞手的条带、排名和客观训练数据，不含评语或 AI 总结。</div>
              </div>
              <button type="button" style={primaryButtonStyle} onClick={() => setParentOverviewOpen(true)}>打开总览卡片</button>
            </div>

            <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <strong>AI 总结配置</strong>
                <button type="button" style={primaryButtonStyle} onClick={() => generateAiSummary("class")}>生成班级总结</button>
              </div>
              <label style={{ display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 13 }}>系统提示词</strong>
                <textarea
                  value={aiConfig.systemPrompt || ""}
                  onChange={(event) => setAiConfig((current) => ({ ...current, systemPrompt: event.target.value }))}
                  style={{ ...textareaStyle, minHeight: 120, fontSize: 13 }}
                />
              </label>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", color: "#334155", fontSize: 13 }}>
                {[
                  ["includeTasks", "读取教练任务完成情况"],
                  ["includeReviews", "读取小测/教练评语"],
                ].map(([key, label]) => (
                  <label key={key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={Boolean(aiConfig[key])} onChange={(event) => setAiConfig((current) => ({ ...current, [key]: event.target.checked }))} />
                    {label}
                  </label>
                ))}
              </div>
              <ClassAiSummary summary={classSummary} />
            </div>

            <TaskSummary tasks={(detail.coachTasks || []).map((task) => ({ ...task, eventStartedAt: detail.event.startedAt || detail.event.createdAt }))} />

            <div style={{ display: "grid", gap: 10 }}>
              {detail.participants.map((participant) => {
                const review = reviews[participant.pilotId] || {};
                return (
                  <div key={`${participant.pilotId}-${participant.receiverId}`} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 10 }}>
                    <button type="button" style={{ ...buttonStyle, width: "100%", height: "auto", minHeight: 42, display: "grid", gridTemplateColumns: "1.1fr 92px 116px 92px 92px", gap: 10, alignItems: "center", textAlign: "left" }} onClick={() => setOpenPilotId(openPilotId === participant.pilotId ? "" : participant.pilotId)}>
                      <strong>{participant.pilotName}</strong>
                      <span>接收机 {(participant.receiverHistory || []).length
                        ? participant.receiverHistory.map((item) => item.receiverId).filter((value, index, values) => values.indexOf(value) === index).join(" → ")
                        : participant.receiverId}</span>
                      <span>总飞行 {formatDuration(participant.totalFlightMs)}</span>
                      <span>利用率 {Math.round(participant.utilization * 100)}%</span>
                      <span>反乌龟 {formatDuration(participant.totalTurtleMs)}</span>
                    </button>
                    {openPilotId === participant.pilotId && (
                      <MiniWaveform samples={participant.samples || []} segments={participant.segments} eventStart={detail.event.startedAt || detail.event.createdAt} eventEnd={detail.event.endedAt || detail.generatedAt} />
                    )}
                    <StudentAiSummary summary={studentSummaries[participant.pilotId]} />
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(160px,.8fr) minmax(220px,1.2fr) auto auto", gap: 8, alignItems: "start" }}>
                      <textarea value={review.quiz_result || ""} onChange={(event) => updateReview(participant.pilotId, { quiz_result: event.target.value })} placeholder="小测情况" style={{ ...textareaStyle, background: "#eff6ff", height: 38, minHeight: 38  }} />
                      <textarea value={review.coach_note || ""} onChange={(event) => updateReview(participant.pilotId, { coach_note: event.target.value })} placeholder="教练评语" style={{ ...textareaStyle, background: "#fff7ed", height: 38, minHeight: 38 }} />
                      <button type="button" style={buttonStyle} onClick={() => saveReview(participant.pilotId)}>保存并同步</button>
                      <button type="button" style={primaryButtonStyle} onClick={() => generateAiSummary("student", participant.pilotId)}>生成学生总结</button>

                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
      {parentOverviewOpen && detail && <ParentOverviewCard detail={detail} onClose={() => setParentOverviewOpen(false)} />}
    </div>
  );
}
