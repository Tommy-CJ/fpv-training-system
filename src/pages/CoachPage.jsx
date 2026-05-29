import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, buttonStyle, panelStyle, primaryButtonStyle } from "../trainingShared.js";

function formatDateTime(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

const stateLabels = {
  stable: "稳定",
  unstable: "不稳定",
  inactive: "未活跃",
  improving: "改善中",
};

const stateColors = {
  stable: { bg: "#ecfdf5", fg: "#047857", border: "#a7f3d0" },
  unstable: { bg: "#fff7ed", fg: "#c2410c", border: "#fed7aa" },
  inactive: { bg: "#f1f5f9", fg: "#475569", border: "#cbd5e1" },
  improving: { bg: "#eff6ff", fg: "#1d4ed8", border: "#bfdbfe" },
};

const trendLabels = {
  improving: "改善",
  degrading: "变差",
  stable: "稳定",
};

const priorityLabels = {
  low: "低",
  medium: "中",
  high: "高",
};

const priorityColors = {
  low: { bg: "#ecfdf5", fg: "#047857", border: "#a7f3d0" },
  medium: { bg: "#fffbeb", fg: "#b45309", border: "#fde68a" },
  high: { bg: "#fef2f2", fg: "#b91c1c", border: "#fecaca" },
};

function StateBadge({ state }) {
  const color = stateColors[state] || stateColors.stable;
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: 68,
      height: 28,
      borderRadius: 999,
      border: `1px solid ${color.border}`,
      background: color.bg,
      color: color.fg,
      fontWeight: 900,
      fontSize: 13,
    }}>
      {stateLabels[state] || state}
    </span>
  );
}

function Metric({ label, value, sub }) {
  return (
    <div style={{
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      padding: "10px 12px",
      background: "#fff",
      minWidth: 0,
    }}>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 18, fontWeight: 950, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
      {sub && <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PilotCoachCard({ pilot, onGenerateSuggestion, generating }) {
  const [open, setOpen] = useState(false);
  const features = pilot.features || {};
  const trends = pilot.trends || {};
  const reasons = pilot.reasons || [];
  const suggestedMessage = pilot.suggestedMessage || null;
  const priorityColor = priorityColors[suggestedMessage?.priority] || priorityColors.low;

  return (
    <section style={{ ...panelStyle, padding: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        style={{
          ...buttonStyle,
          width: "100%",
          height: "auto",
          minHeight: 52,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
          gap: 12,
          alignItems: "center",
          textAlign: "left",
          background: "#fff",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color: "#0f172a", fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pilot.pilotName}</div>
          <div style={{ color: "#64748b", fontSize: 12 }}>接收机 {pilot.receiverId || "-"}</div>
        </div>
        <StateBadge state={pilot.coachState} />
        <div style={{ color: "#334155", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {suggestedMessage?.message || pilot.suggestion || "暂无建议"}
        </div>
        <div style={{ color: "#64748b", fontSize: 13, textAlign: "right" }}>
          趋势：{trendLabels[trends.overall] || trends.overall || "--"}
        </div>
      </button>

      {open && (
        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={{ ...buttonStyle, minHeight: 32, height: 32 }}
              disabled={generating}
              onClick={() => onGenerateSuggestion?.(pilot)}
            >
              {generating ? "生成中..." : "手动生成 AI 建议"}
            </button>
          </div>
          {suggestedMessage && (
            <div style={{ border: `1px solid ${priorityColor.border}`, borderRadius: 8, padding: 10, background: priorityColor.bg, display: "grid", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <strong style={{ color: priorityColor.fg, fontSize: 14 }}>LLM 建议</strong>
                <span style={{ color: priorityColor.fg, fontSize: 12, fontWeight: 900 }}>优先级：{priorityLabels[suggestedMessage.priority] || suggestedMessage.priority}</span>
              </div>
              <div style={{ color: "#0f172a", fontWeight: 900 }}>{suggestedMessage.message}</div>
              <div style={{ color: "#475569", fontSize: 13 }}>原因：{suggestedMessage.reason}</div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 8 }}>
            <Metric label="利用率" value={formatPercent(features.utilization)} />
            <Metric label="平均空闲" value={formatDuration(features.avgIdleMs)} />
            <Metric label="飞行时间" value={formatDuration(features.totalFlightMs)} sub="最近窗口" />
            <Metric label="每10分钟飞行" value={formatDuration(features.flightTimePer10MinMs)} />
            <Metric label="反乌龟时间" value={formatDuration(features.totalTurtleMs)} />
            <Metric label="反乌龟占比" value={formatPercent(features.turtleTimeRatio)} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc" }}>
              <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>趋势</div>
              <div style={{ color: "#475569", fontSize: 13, lineHeight: 1.7 }}>
                <div>利用率：{trendLabels[trends.utilization] || trends.utilization || "--"}</div>
                <div>稳定性：{trendLabels[trends.stability] || trends.stability || "--"}</div>
                <div>综合：{trendLabels[trends.overall] || trends.overall || "--"}</div>
              </div>
            </div>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc" }}>
              <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>判断原因</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {reasons.length === 0 && <span style={{ color: "#64748b", fontSize: 13 }}>暂无明显异常</span>}
                {reasons.map((reason) => (
                  <span key={reason.code} style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 999, padding: "4px 8px", fontSize: 12, fontWeight: 800 }}>
                    {reason.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function LlmConfigCard({ config, apiKeyInput, status, onChange, onApiKeyChange, onSave }) {
  const hasApiKey = Boolean(config?.hasApiKey);
  return (
    <details style={panelStyle}>
      <summary style={{ cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 950, color: "#0f172a", fontSize: 16 }}>LLM 模型接口</div>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 3 }}>
            Structured Outputs JSON：message / priority / speakable / reason
          </div>
        </div>
        <span style={{ color: config?.enabled ? "#047857" : "#64748b", fontSize: 12, fontWeight: 900 }}>
          {config?.enabled ? "已启用" : "未启用"}{hasApiKey ? " · 已保存 API Key" : ""}
        </span>
      </summary>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <label style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "#334155", fontWeight: 900, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={Boolean(config?.enabled)}
            onChange={(event) => onChange("enabled", event.target.checked)}
          />
          启用 LLM 建议
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
            <span>接口地址</span>
            <input
              value={config?.endpoint || ""}
              onChange={(event) => onChange("endpoint", event.target.value)}
              style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
            <span>模型</span>
            <input
              value={config?.model || ""}
              onChange={(event) => onChange("model", event.target.value)}
              style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
            <span>API Key{hasApiKey ? "（留空不修改）" : ""}</span>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={hasApiKey ? "已保存，输入新 Key 可替换" : "输入 API Key"}
              style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
            <span>温度</span>
            <input
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={config?.temperature ?? 0.2}
              onChange={(event) => onChange("temperature", Number(event.target.value))}
              style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 10px" }}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
            <span>自动建议间隔（分钟）</span>
            <input
              type="number"
              min="1"
              max="60"
              value={config?.autoIntervalMinutes ?? 5}
              onChange={(event) => onChange("autoIntervalMinutes", Number(event.target.value))}
              style={{ height: 34, border: "1px solid #d4d4d8", borderRadius: 8, padding: "0 10px" }}
            />
          </label>
        </div>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "#64748b" }}>
          <span>系统提示词</span>
          <textarea
            value={config?.systemPrompt || ""}
            onChange={(event) => onChange("systemPrompt", event.target.value)}
            rows={5}
            style={{ border: "1px solid #d4d4d8", borderRadius: 8, padding: 10, resize: "vertical", fontFamily: "inherit" }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: status?.includes("失败") || config?.lastError ? "#b91c1c" : "#64748b", fontSize: 13 }}>
            {config?.lastError || status || "配置保存后，飞手状态变化会触发 LLM 分析。"}
          </span>
          <button type="button" style={primaryButtonStyle} onClick={onSave}>保存配置</button>
        </div>
      </div>
    </details>
  );
}

export default function CoachPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [llmConfig, setLlmConfig] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [llmStatus, setLlmStatus] = useState("");
  const [generatingPilotId, setGeneratingPilotId] = useState("");
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [status, setStatus] = useState("正在读取助教快照...");

  async function loadSnapshot() {
    const nextSnapshot = await apiGet("/api/coach/overview", null);
    setSnapshot(nextSnapshot);
    setStatus(nextSnapshot ? "助教快照已读取" : "助教快照读取失败");
  }

  async function saveLlmConfig() {
    setLlmStatus("正在保存 LLM 配置...");
    try {
      const payload = { ...(llmConfig || {}) };
      delete payload.hasApiKey;
      delete payload.lastError;
      delete payload.apiKey;
      if (apiKeyInput.trim()) payload.apiKey = apiKeyInput.trim();
      const saved = await apiPost("/api/coach/llm-config", payload);
      setLlmConfig(saved);
      setApiKeyInput("");
      setLlmStatus("LLM 配置已保存");
    } catch (error) {
      setLlmStatus(`保存失败：${error.message}`);
    }
  }

  async function generatePilotSuggestion(pilot) {
    if (!pilot?.pilotId) return;
    setGeneratingPilotId(pilot.pilotId);
    setLlmStatus(`${pilot.pilotName || pilot.pilotId} 正在生成 AI 建议...`);
    try {
      await apiPost(`/api/coach/llm-suggestions/${encodeURIComponent(pilot.pilotId)}`, {});
      setLlmStatus("AI 建议已生成");
      await loadSnapshot();
    } catch (error) {
      setLlmStatus(`生成失败：${error.message}`);
    } finally {
      setGeneratingPilotId("");
    }
  }

  async function generateEventSummary() {
    setGeneratingSummary(true);
    setLlmStatus("正在生成本场总结...");
    try {
      await apiPost("/api/coach/event-summary", {});
      setLlmStatus("本场总结已生成");
      await loadSnapshot();
    } catch (error) {
      setLlmStatus(`总结失败：${error.message}`);
    } finally {
      setGeneratingSummary(false);
    }
  }

  useEffect(() => {
    let stopped = false;
    async function load() {
      const nextSnapshot = await apiGet("/api/coach/overview", null);
      if (stopped) return;
      setSnapshot(nextSnapshot);
      setStatus(nextSnapshot ? "助教快照已读取" : "助教快照读取失败");
    }
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    async function load() {
      const nextConfig = await apiGet("/api/coach/llm-config", null);
      if (!stopped && nextConfig) setLlmConfig(nextConfig);
    }
    load();
    return () => {
      stopped = true;
    };
  }, []);

  const pilots = useMemo(() => snapshot?.pilots || [], [snapshot]);
  const hasActiveEvent = Boolean(snapshot?.event?.id);
  const eventSummary = snapshot?.eventSummary || null;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>AI助教</h2>
            <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
              只读 SQLite 训练段生成内存快照，不参与实时中继和采样写入。
            </div>
          </div>
          <button type="button" style={primaryButtonStyle} onClick={loadSnapshot}>刷新</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginTop: 14 }}>
          <Metric label="当前事件" value={snapshot?.event?.name || "无 active event"} />
          <Metric label="快照时间" value={formatDateTime(snapshot?.generatedAt)} />
          <Metric label="状态" value={snapshot?.stale ? "快照延迟" : "正常"} />
          <Metric label="分析窗口" value={formatDuration(snapshot?.windowMs || 0)} />
        </div>

        <div style={{ color: snapshot?.error ? "#b91c1c" : "#64748b", fontSize: 13, marginTop: 10 }}>
          {snapshot?.error || status}
        </div>
      </section>

      <LlmConfigCard
        config={llmConfig}
        apiKeyInput={apiKeyInput}
        status={llmStatus}
        onChange={(key, value) => setLlmConfig((current) => ({ ...(current || {}), [key]: value }))}
        onApiKeyChange={setApiKeyInput}
        onSave={saveLlmConfig}
      />

      {hasActiveEvent && (
        <section style={panelStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>本场训练总结</h3>
              <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>手动把整个 event 摘要发给 LLM，生成整体评价和下一轮建议。</div>
            </div>
            <button type="button" style={primaryButtonStyle} disabled={generatingSummary} onClick={generateEventSummary}>
              {generatingSummary ? "生成中..." : "生成本场总结"}
            </button>
          </div>
          {!eventSummary && <div style={{ color: "#64748b", fontSize: 13, marginTop: 10 }}>暂无本场总结</div>}
          {eventSummary && (
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <div style={{ color: "#0f172a", fontWeight: 900 }}>{eventSummary.overallEvaluation}</div>
              <div style={{ color: "#475569", fontSize: 13 }}>训练氛围：{eventSummary.atmosphere}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc" }}>
                  <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>表现较好</div>
                  {(eventSummary.strongPilots || []).length === 0 && <div style={{ color: "#64748b", fontSize: 13 }}>暂无</div>}
                  {(eventSummary.strongPilots || []).map((item) => (
                    <div key={`${item.pilotName}-${item.reason}`} style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>{item.pilotName}：{item.reason}</div>
                  ))}
                </div>
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc" }}>
                  <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>需要关注</div>
                  {(eventSummary.attentionPilots || []).length === 0 && <div style={{ color: "#64748b", fontSize: 13 }}>暂无</div>}
                  {(eventSummary.attentionPilots || []).map((item) => (
                    <div key={`${item.pilotName}-${item.reason}`} style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>{item.pilotName}：{item.reason}</div>
                  ))}
                </div>
              </div>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
                <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>下一轮建议</div>
                {(eventSummary.nextRoundAdvice || []).map((item) => (
                  <div key={item} style={{ color: "#475569", fontSize: 13, marginTop: 4 }}>- {item}</div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center", border: "1px solid #dbeafe", borderRadius: 8, padding: 10, background: "#eff6ff" }}>
                <span style={{ color: "#1d4ed8", fontWeight: 900 }}>播报总结：{eventSummary.speakableSummary}</span>
                <span style={{ color: "#64748b", fontSize: 12 }}>{formatDateTime(eventSummary.generatedAt)}</span>
              </div>
            </div>
          )}
        </section>
      )}

      {!hasActiveEvent && (
        <section style={panelStyle}>
          <div style={{ color: "#64748b" }}>当前没有进行中的训练事件。开始训练后，Coach Runtime 会每 5 秒生成一次快照。</div>
        </section>
      )}

      {hasActiveEvent && pilots.length === 0 && (
        <section style={panelStyle}>
          <div style={{ color: "#64748b" }}>当前事件还没有参训飞手。</div>
        </section>
      )}

      {hasActiveEvent && pilots.map((pilot) => (
        <PilotCoachCard
          key={`${pilot.pilotId}-${pilot.receiverId}`}
          pilot={pilot}
          generating={generatingPilotId === pilot.pilotId}
          onGenerateSuggestion={generatePilotSuggestion}
        />
      ))}
    </div>
  );
}
