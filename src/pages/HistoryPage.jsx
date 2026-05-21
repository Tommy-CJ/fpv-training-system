import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, buttonStyle, dangerButtonStyle, formatDuration, panelStyle, primaryButtonStyle } from "../trainingShared.js";

function formatDateTime(ms) {
  if (!ms) return "未记录";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function formatTime(ms) {
  if (!ms) return "--:--:--";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function getEventDuration(event) {
  if (!event.startedAt) return 0;
  return (event.endedAt || Date.now()) - event.startedAt;
}

function MiniWaveform({ samples, segments, eventStart, eventEnd }) {
  const width = 780;
  const height = 90;
  if (!samples?.length && !segments?.length) return <div style={{ color: "#64748b", fontSize: 13 }}>暂无采样</div>;
  const start = eventStart || samples?.[0]?.time || segments?.[0]?.startedAt;
  const end = Math.max(start + 1, eventEnd || samples?.[samples.length - 1]?.time || segments?.[segments.length - 1]?.endedAt || start + 1);
  const bands = segments?.length ? segments.map((segment) => ({
    state: segment.type === "flight" ? "flying" : segment.type === "turtle" ? "turtle" : "idle",
    start: segment.startedAt,
    end: segment.endedAt,
  })) : samples.reduce((items, sample, index) => {
    const nextSample = samples[index + 1];
    const nextTime = Math.min(end, nextSample?.time || sample.time + 1000);
    const state = sample.turtle ? "turtle" : sample.flying ? "flying" : "idle";
    const prev = items[items.length - 1];
    if (prev && prev.state === state && sample.time - prev.end <= 2500) {
      prev.end = nextTime;
    } else {
      items.push({ state, start: sample.time, end: nextTime });
    }
    return items;
  }, []);
  const colorByState = { turtle: "#fed7aa", flying: "#bbf7d0", idle: "#f1f5f9" };

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="110" preserveAspectRatio="none" style={{ border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff" }}>
        {bands.map((band, index) => {
          const bandStart = Math.max(start, band.start);
          const bandEnd = Math.min(end, band.end);
          const x = ((bandStart - start) / Math.max(1, end - start)) * width;
          const bandWidth = Math.max(1, ((bandEnd - bandStart) / Math.max(1, end - start)) * width);
          return <rect key={`${band.state}-${index}`} x={x} y="0" width={bandWidth} height={height} fill={colorByState[band.state]} />;
        })}
        {[0, 0.5, 1].map((ratio) => (
          <g key={ratio}>
            <line x1={ratio * width} x2={ratio * width} y1={height - 10} y2={height} stroke="#475569" strokeWidth="1.5" />
            <line x1={ratio * width} x2={ratio * width} y1="0" y2="8" stroke="#94a3b8" strokeWidth="1" />
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 12, marginTop: 6 }}>
        <span>{formatTime(start)}</span>
        <span>{formatTime(start + (end - start) / 2)}</span>
        <span>{formatTime(end)}</span>
      </div>
    </div>
  );
}

export default function HistoryPage({ events, onDeleteEvent }) {
  const finishedEvents = useMemo(
    () => [...events].sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0)),
    [events],
  );
  const [selectedId, setSelectedId] = useState(finishedEvents[0]?.id || "");
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState("");
  const [openPilotId, setOpenPilotId] = useState("");
  const activeSelectedId = selectedId || finishedEvents[0]?.id || "";

  useEffect(() => {
    if (!activeSelectedId) return;
    let stopped = false;
    async function loadDetail() {
      setStatus("正在读取详情...");
      const nextDetail = await apiGet(`/api/events/${activeSelectedId}/detail`, null);
      if (stopped) return;
      setDetail(nextDetail);
      setOpenPilotId(nextDetail?.participants?.[0]?.pilotId || "");
      setStatus(nextDetail ? "详情已读取" : "详情读取失败");
    }
    loadDetail();
    return () => {
      stopped = true;
    };
  }, [activeSelectedId]);

  async function deleteEvent(eventId) {
    setStatus("正在删除事件...");
    try {
      await apiDelete(`/api/events/${eventId}`);
      await onDeleteEvent(eventId);
      setDetail(null);
      setSelectedId("");
      setStatus("事件已删除");
    } catch (error) {
      setStatus(`删除失败：${error.message}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <h3 style={{ margin: "0 0 12px", textAlign: "left", fontWeight: 900 }}>训练事件列表</h3>
        {finishedEvents.length === 0 && <div style={{ color: "#64748b" }}>还没有训练事件。</div>}
        <div style={{ display: "grid", gap: 8 }}>
          {finishedEvents.map((event) => (
            <div
              key={event.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 1.2fr 1.2fr 120px 110px 100px",
                gap: 10,
                alignItems: "center",
                border: "1px solid #e5e7eb",
                borderRadius: 12,
                padding: 12,
                background: activeSelectedId === event.id ? "#eff6ff" : "#fff",
              }}
            >
              <strong>{event.name}</strong>
              <span style={{ color: "#64748b", fontSize: 13 }}>开始：{formatDateTime(event.startedAt)}</span>
              <span style={{ color: "#64748b", fontSize: 13 }}>结束：{formatDateTime(event.endedAt)}</span>
              <span>{formatDuration(getEventDuration(event))}</span>
              <button type="button" style={activeSelectedId === event.id ? primaryButtonStyle : buttonStyle} onClick={() => setSelectedId(event.id)}>
                查看详情
              </button>
              <button type="button" style={dangerButtonStyle} onClick={() => deleteEvent(event.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      </section>

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>事件详情</h3>
          <span style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13 }}>{status}</span>
        </div>

        {!detail && <div style={{ color: "#64748b", marginTop: 12 }}>请选择一个训练事件。</div>}
        {detail && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginBottom: 14 }}>
              <div><strong>事件名称</strong><div>{detail.event.name}</div></div>
              <div><strong>开始时间</strong><div>{formatDateTime(detail.event.startedAt)}</div></div>
              <div><strong>结束时间</strong><div>{formatDateTime(detail.event.endedAt)}</div></div>
              <div><strong>参与人数</strong><div>{detail.participants.length}</div></div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {detail.participants.map((participant) => (
                <div key={`${participant.pilotId}-${participant.receiverId}`} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f8fafc" }}>
                  <button
                    type="button"
                    style={{ ...buttonStyle, width: "100%", height: "auto", minHeight: 42, display: "grid", gridTemplateColumns: "1.2fr 110px 130px 110px 130px 120px", gap: 10, alignItems: "center", textAlign: "left" }}
                    onClick={() => setOpenPilotId(openPilotId === participant.pilotId ? "" : participant.pilotId)}
                  >
                    <strong>{participant.pilotName}</strong>
                    <span>接收机 {participant.receiverId}</span>
                    <span>总飞行 {formatDuration(participant.totalFlightMs)}</span>
                    <span>利用率 {Math.round(participant.utilization * 100)}%</span>
                    <span>反乌龟 {formatDuration(participant.totalTurtleMs)}</span>
                    <span>采样 {participant.sampleCount}</span>
                  </button>
                  {openPilotId === participant.pilotId && (
                    <div style={{ marginTop: 10 }}>
                      <MiniWaveform samples={participant.samples || []} segments={participant.segments} eventStart={detail.event.startedAt || detail.event.createdAt} eventEnd={detail.event.endedAt || detail.generatedAt} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
