import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_TRANSPORT_CONFIG, EQUIPMENT_TYPES, displayTaskName } from "../../transportPlanner.js";
import { apiDelete, apiGet, apiPost, apiPut, buttonStyle, dangerButtonStyle, inputStyle, panelStyle, primaryButtonStyle } from "../trainingShared.js";

const equipmentTypes = [...EQUIPMENT_TYPES, { key: "flag", label: "刀旗" }].filter((item, index, list) => list.findIndex((entry) => entry.key === item.key) === index);
const equipmentNames = Object.fromEntries(equipmentTypes.map((item) => [item.key, item.label]));
const planColors = {
  single: "#eab308",
  triple: "#eab308",
  gravity: "#f97316",
  doubleGravity: "#f97316",
  sun: "#2563eb",
  sandbagHand: "#dc2626",
  sandbagCart: "#9333ea",
  sandbag: "#c026d3",
};

function fmtTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function fmtMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)} 分钟` : "--";
}

function badgeStyle(status) {
  if (status === "success") return { background: "#ecfdf5", color: "#047857", border: "1px solid #a7f3d0" };
  if (status === "error") return { background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" };
  if (status === "syncing") return { background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" };
  return { background: "#f8fafc", color: "#64748b", border: "1px solid #e2e8f0" };
}

function fieldStyle() {
  return { display: "grid", gap: 5, color: "#64748b", fontSize: 12, fontWeight: 800 };
}

function metric(label, value) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc", minWidth: 0 }}>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 800 }}>{label}</div>
      <div style={{ color: "#0f172a", fontSize: 18, fontWeight: 950, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

function equipmentSummary(equipment = []) {
  const visible = equipment.filter((row) => Number(row.final_quantity) > 0);
  return visible.length ? visible.map((row) => `${equipmentNames[row.equipment_type] || row.equipment_type} ${row.final_quantity}`).join(" / ") : "暂无器材";
}

function trackReadiness(track) {
  const readiness = track?.overlayJson?.data?.readiness || track?.overlayJson?.readiness || null;
  return readiness || null;
}

function readinessIssueText(issue) {
  const type = typeof issue === "string" ? issue : issue?.type;
  return ({
    "missing-start-finish": "缺少起终点计时点",
    "duplicate-start-finish": "起终点计时点重复",
    "missing-route": "缺少赛道路线",
    "multiple-routes": "存在多条路线",
    "duplicate-timing-id": "计时点 ID 重复",
    "missing-split-id": "分段计时点缺少 ID",
    "timing-point-off-route": "计时点不在路线附近",
  })[type] || type || "未知问题";
}

function taskColor(job) {
  if (job.type === "sandbag") {
    if (String(job.name || "").includes("小车")) return planColors.sandbagCart;
    if (String(job.name || "").includes("手提")) return planColors.sandbagHand;
    return planColors.sandbag;
  }
  return planColors[job.type] || "#64748b";
}

function darken(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!match) return "#111827";
  const value = (part) => Math.max(0, Math.round(parseInt(part, 16) * 0.7)).toString(16).padStart(2, "0");
  return `#${value(match[1])}${value(match[2])}${value(match[3])}`;
}

export function TransportPlanView({ planRecord, compact = false, mobile = false }) {
  const plan = planRecord?.plan || planRecord;
  const ganttRef = useRef(null);
  const [ganttW, setGanttW] = useState(0);

  useEffect(() => {
    const el = ganttRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setGanttW(entries[0]?.contentRect.width || 0);
    });
    ro.observe(el);
    setGanttW(el.offsetWidth);
    return () => ro.disconnect();
  }, []);

  if (!plan) {
    return <div style={{ color: "#64748b", fontSize: 13 }}>暂无搬运方案</div>;
  }
  const people = plan.people || [];
  const maxT = Math.max(1, Number(plan.makespan) || 1);
  const rowStep = 54;
  const barTop = 4;
  const barHeight = 26;
  const laneOffset = mobile ? 58 : 100;
  const baseLaneW = mobile ? 300 : compact ? 640 : 780;
  const laneWidth = Math.max(mobile ? 180 : 320, ganttW > 0 ? ganttW - laneOffset - 30 : baseLaneW);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
        {metric("预计完成", fmtMinutes(plan.makespan))}
        {metric("人数", `${plan.usedCount || 0} 人`)}
        {!compact && metric("等待空挡", fmtMinutes(plan.totalIdle))}
        {!compact && metric("总难度负担", Number(plan.fatigue || 0).toFixed(1))}
        {!compact && metric("趟数不均衡", Number(plan.tripImbalance || 0).toFixed(1))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", color: "#475569", fontSize: 12 }}>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: planColors.single, marginRight: 4 }} />单门 / 三层门</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: planColors.sun, marginRight: 4 }} />日字门</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: planColors.sandbagHand, marginRight: 4 }} />沙包-手提</span>
        <span><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: planColors.sandbagCart, marginRight: 4 }} />沙包-小车</span>
        <span><i style={{ display: "inline-block", width: 12, height: 10, border: "2px solid #111827", marginRight: 4, verticalAlign: "middle" }} />同组协作（实线边框）</span>
      </div>
      <div ref={ganttRef} style={{ border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff", overflow: "hidden" }}>
        <div style={{ width: laneOffset + laneWidth + 24, position: "relative", padding: 12 }}>
          {people.map((person) => (
            <div key={person.id} style={{ display: "grid", gridTemplateColumns: `${laneOffset - 10}px ${laneWidth}px`, gap: 10, alignItems: "center", margin: "10px 0" }}>
              <div style={{ color: "#334155", fontSize: mobile ? 11 : 13, fontWeight: 900 }}>
                人员{person.id}<br />
                <span style={{ color: "#64748b", fontSize: mobile ? 10 : 12 }}>{person.trips}趟</span>
              </div>
              <div style={{ position: "relative", height: 34, background: "#f1f5f9", borderRadius: 8, overflow: "hidden" }}>
                {(person.jobs || []).map((job, index) => {
                  const left = (job.start / maxT) * laneWidth;
                  const width = Math.max(18, ((job.end - job.start) / maxT) * laneWidth);
                  const isCoop = job.peopleIds && job.peopleIds.length > 1;
                  return (
                    <div
                      key={`${job.name}-${job.start}-${index}`}
                      title={`${displayTaskName(job.name)}×${job.qty} ${Number(job.start).toFixed(1)}-${Number(job.end).toFixed(1)}min`}
                      style={{
                        position: "absolute",
                        top: isCoop ? 3 : 4,
                        left,
                        width,
                        height: isCoop ? 28 : 26,
                        borderRadius: 7,
                        background: taskColor(job),
                        color: "#fff",
                        fontSize: mobile ? 10 : 12,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        boxSizing: "border-box",
                        zIndex: 2,
                        border: isCoop ? `2px solid ${darken(taskColor(job))}` : "none",
                        lineHeight: 1,
                      }}
                    >
                      {displayTaskName(job.name)}×{job.qty}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "#64748b", textAlign: "left" }}>
              <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>人员</th>
              <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>趟数</th>
              <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>难度负担</th>
              <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>任务</th>
            </tr>
          </thead>
          <tbody>
            {people.filter((person) => person.jobs?.length).map((person) => (
              <tr key={person.id}>
                <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", fontWeight: 900, textAlign: "center" }}>人员{person.id}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>{person.trips}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>{Number(person.fatigue || 0).toFixed(1)}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>{person.jobs.map((job) => `${displayTaskName(job.name)}×${job.qty}`).join("、")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TrackPreview({ track, height = 600, cropped = false, showLink = true, mobile = false }) {
  if (!track?.trackdrawEmbedUrl) {
    return <div style={{ color: "#64748b", fontSize: 13 }}>尚未填写 TrackDraw 预览链接。</div>;
  }
  const bottomCrop = mobile && cropped;
  return (
    <div style={{ display: "grid", gap: 8, overflow: "hidden", borderRadius: cropped ? 12 : 0, height: cropped ? height : "auto" }}>
      <iframe
        title="TrackDraw 3D 预览"
        src={track.trackdrawEmbedUrl}
        allowFullScreen
        style={{ width: cropped ? "111.2%" : "100%", height: bottomCrop ? height * 1.40 : (cropped ? height * 1.10 : height), border: "none", borderRadius: cropped ? 12 : 0, background: "#f8fafc", transform: cropped ? (bottomCrop ? "translate(-5%, -15%)" : "translate(-5%, -10%)") : "none", transformOrigin: "top left" }}
      />
      <a href={track.trackdrawEmbedUrl} target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: showLink ? "inline-flex" : "none", alignItems: "center", justifyContent: "center", textDecoration: "none", width: "fit-content" }}>
        打开 TrackDraw 预览
      </a>
    </div>
  );
}

function TrackForm({ value, onChange, onSave, saving }) {
  function normalizeEmbedInput(raw) {
    const text = String(raw || "");
    const src = text.match(/src=["']([^"']+)["']/i)?.[1];
    return src || text;
  }

  return (
    <section style={panelStyle}>
      <h2 style={{ marginTop: 0, color: "#0f172a", fontWeight: 900, textAlign: "left" }}>{value.id ? "编辑赛道" : "新建赛道"}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
        <label style={{ ...fieldStyle(), gridColumn: "1 / -1" }}>
          <span>TrackDraw Project ID</span>
          <input style={inputStyle} value={value.trackdrawProjectId || ""} placeholder="例如 FdVRYEY8f32w_5c00tFbg" onChange={(event) => onChange({ ...value, trackdrawProjectId: event.target.value.trim() })} />
        </label>
        <label style={{ ...fieldStyle(), gridColumn: "1 / -1" }}>
          <span>TrackDraw 预览链接</span>
          <input style={inputStyle} value={value.trackdrawEmbedUrl || ""} placeholder={'可粘贴 https://trackdraw.app/embed/... 或完整 <iframe src="..."></iframe>'} onChange={(event) => onChange({ ...value, trackdrawEmbedUrl: normalizeEmbedInput(event.target.value) })} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", marginTop: 12 }}>
        <a href="https://trackdraw.app" target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>打开 TrackDraw</a>
        <button type="button" style={primaryButtonStyle} onClick={onSave} disabled={saving}>{saving ? "保存中..." : "保存"}</button>
      </div>
    </section>
  );
}

function EquipmentEditor({ track, onSaved }) {
  const [rows, setRows] = useState(track?.equipment || []);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setRows(track?.equipment || []);
  }, [track?.id, track?.equipment]);

  async function save() {
    setStatus("正在保存器材修正...");
    try {
      const result = await apiPost(`/api/tracks/${track.id}/equipment`, { equipment: rows });
      setRows(result.equipment || []);
      setStatus("器材修正已保存");
      await onSaved?.();
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  return (
    <section style={panelStyle}>
      <details open>
        <summary style={{ cursor: "pointer", fontWeight: 950, fontSize: 16, color: "#0f172a", padding: "4px 0", listStyle: "none" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>器材统计<span style={{ fontSize: 12, color: "#64748b", fontWeight: 400 }}>▸ 搬运计算优先使用人工修正数量</span></span>
        </summary>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" style={primaryButtonStyle} onClick={save}>保存修正</button>
        </div>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>器材类型</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>API 自动识别</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb", textAlign: "center" }}>人工修正</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.equipment_type}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", fontWeight: 900, textAlign: "center" }}>{equipmentNames[row.equipment_type] || row.equipment_type}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>{row.auto_quantity}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", textAlign: "center" }}>
                    <input
                      type="number"
                      min="0"
                      value={row.corrected_quantity ?? ""}
                      placeholder="空=自动"
                      style={{ ...inputStyle, width: 110 }}
                      onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, corrected_quantity: event.target.value } : item))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status && <div style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13, marginTop: 8 }}>{status}</div>}
      </details>
    </section>
  );
}

function UnknownObjectEditor({ track, onSaved }) {
  const [items, setItems] = useState(track?.unknownObjects || []);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setItems(track?.unknownObjects || []);
  }, [track?.id, track?.unknownObjects]);

  async function save() {
    setStatus("正在保存未识别对象处理...");
    try {
      const result = await apiPost(`/api/tracks/${track.id}/unknown-objects`, { unknownObjects: items });
      setItems(result.unknownObjects || []);
      setStatus("未识别对象处理已保存");
      await onSaved?.();
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  if (!items.length) return null;

  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "#0f172a" }}>未识别器材</h3>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>可手动归类或忽略，原始对象会保留在 SQLite。</div>
        </div>
        <button type="button" style={primaryButtonStyle} onClick={save}>保存处理</button>
      </div>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {items.map((item, index) => (
          <div key={item.id} style={{ display: "grid", gridTemplateColumns: "minmax(180px,1fr) minmax(160px,220px) 100px", gap: 8, alignItems: "center", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#f8fafc", fontSize: 13 }}>
            <div style={{ color: "#475569", overflowWrap: "anywhere" }}>{item.guessed_name || "未知对象"}</div>
            <select
              style={inputStyle}
              value={item.assigned_equipment_type || ""}
              onChange={(event) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, assigned_equipment_type: event.target.value, ignored: false } : row))}
            >
              <option value="">暂不归类</option>
              {equipmentTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
            </select>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", color: "#334155", fontWeight: 900 }}>
              <input
                type="checkbox"
                checked={Boolean(item.ignored)}
                onChange={(event) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ignored: event.target.checked, assigned_equipment_type: event.target.checked ? "" : row.assigned_equipment_type } : row))}
              />
              忽略
            </label>
          </div>
        ))}
      </div>
      {status && <div style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13, marginTop: 8 }}>{status}</div>}
    </section>
  );
}

function TransportPlanner({ track, onSaved }) {
  const [config, setConfig] = useState(() => ({ ...DEFAULT_TRANSPORT_CONFIG, counts: {} }));
  const [plans, setPlans] = useState(track?.transportPlans || []);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const counts = {};
    for (const row of track?.equipment || []) counts[row.equipment_type] = Number(row.final_quantity || 0);
    setConfig((current) => ({ ...current, counts, rules: current.rules || DEFAULT_TRANSPORT_CONFIG.rules }));
    const sorted = (track?.transportPlans || []).slice().sort((a, b) => (a.used_people_count || 0) - (b.used_people_count || 0));
    const deduped = [];
    const seenCounts = new Set();
    for (const plan of sorted) {
      const key = plan.used_people_count;
      if (!seenCounts.has(key)) { seenCounts.add(key); deduped.push(plan); }
    }
    setPlans(deduped);
  }, [track?.id, track?.equipment, track?.transportPlans]);

  useEffect(() => {
    let stopped = false;
    async function loadRules() {
      const result = await apiGet("/api/transport/rules", null);
      if (!stopped && result?.rules) {
        setConfig((current) => ({ ...current, rules: result.rules }));
      }
    }
    loadRules();
    return () => {
      stopped = true;
    };
  }, [track?.id]);

  function setParam(key, value) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function setNested(section, key, value) {
    setConfig((current) => ({ ...current, [section]: { ...(current[section] || {}), [key]: value } }));
  }

  function setRule(type, key, value) {
    setConfig((current) => ({
      ...current,
      rules: {
        ...(current.rules || {}),
        [type]: {
          ...(current.rules?.[type] || {}),
          [key]: value,
        },
      },
    }));
  }

  async function saveRules() {
    setStatus("正在保存搬运规则...");
    try {
      const result = await apiPost("/api/transport/rules", { rules: config.rules || {} });
      setConfig((current) => ({ ...current, rules: result.rules || current.rules }));
      setStatus("搬运规则已保存");
    } catch (error) {
      setStatus(`规则保存失败：${error.message}`);
    }
  }

  async function calculate() {
    setStatus("正在计算搬运方案...");
    try {
      const result = await apiPost(`/api/tracks/${track.id}/transport-plans/calculate`, { config });
      setPlans(result.plans || []);
      setStatus(`已生成 ${result.plans?.length || 0} 个方案，搜索节点 ${result.meta?.nodes || 0}`);
      await onSaved?.();
    } catch (error) {
      setStatus(`计算失败：${error.message}`);
    }
  }

  async function selectPlan(planId) {
    const result = await apiPost(`/api/tracks/${track.id}/transport-plans/${planId}/select`, {});
    const sorted = (result.plans || []).slice().sort((a, b) => (a.used_people_count || 0) - (b.used_people_count || 0));
    const deduped = [];
    const seenCounts = new Set();
    for (const plan of sorted) {
      const key = plan.used_people_count;
      if (!seenCounts.has(key)) { seenCounts.add(key); deduped.push(plan); }
    }
    setPlans(deduped);
    await onSaved?.();
  }

  const selected = plans.find((plan) => plan.selected) || plans[0] || null;

  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "#0f172a" }}>搬运规划</h3>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>{equipmentSummary(track?.equipment)}</div>
        </div>
        <button type="button" style={primaryButtonStyle} onClick={calculate}>计算搬运方案</button>
      </div>
      <details style={{ marginTop: 12, border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#f8fafc" }}>
        <summary style={{ cursor: "pointer", fontWeight: 950, color: "#0f172a" }}>参数配置</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 12 }}>
          <label style={fieldStyle()}><span>起始人数</span><input type="number" style={inputStyle} value={config.peopleStart} onChange={(e) => setParam("peopleStart", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>小车数量</span><input type="number" style={inputStyle} value={config.carts} onChange={(e) => setParam("carts", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>每人最多趟数</span><input type="number" style={inputStyle} value={config.maxTrips} onChange={(e) => setParam("maxTrips", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>搜索节点上限</span><input type="number" style={inputStyle} value={config.nodeLimit} onChange={(e) => setParam("nodeLimit", Number(e.target.value))} /></label>
          <label style={{ display: "inline-flex", gap: 8, alignItems: "center", color: "#334155", fontWeight: 900, fontSize: 13 }}>
            <input type="checkbox" checked={Boolean(config.wind)} onChange={(e) => setParam("wind", e.target.checked)} />风大，单门也需要沙包
          </label>
          <label style={fieldStyle()}><span>沙包数量修正</span><input type="number" placeholder="空=自动" style={inputStyle} value={config.sandbags ?? ""} onChange={(e) => setParam("sandbags", e.target.value === "" ? null : Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>单门普通候选/趟</span><input type="number" style={inputStyle} value={config.params?.singleQtyNormal ?? 4} onChange={(e) => setNested("params", "singleQtyNormal", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>单门最大候选/趟</span><input type="number" style={inputStyle} value={config.params?.singleQtyMax ?? 5} onChange={(e) => setNested("params", "singleQtyMax", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>单门2人时间系数</span><input type="number" step="0.01" style={inputStyle} value={config.params?.singleTwoPeopleCoef ?? 0.9} onChange={(e) => setNested("params", "singleTwoPeopleCoef", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>单门5个时间系数</span><input type="number" step="0.01" style={inputStyle} value={config.params?.singleFiveCoef ?? 1.15} onChange={(e) => setNested("params", "singleFiveCoef", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>日字门2人时间系数</span><input type="number" step="0.01" style={inputStyle} value={config.params?.sunTwoPeopleCoef ?? 0.85} onChange={(e) => setNested("params", "sunTwoPeopleCoef", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>日字门沙包/个</span><input type="number" style={inputStyle} value={config.params?.sunSandPerGate ?? 2} onChange={(e) => setNested("params", "sunSandPerGate", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>风大单门沙包/个</span><input type="number" style={inputStyle} value={config.params?.singleSandPerGate ?? 2} onChange={(e) => setNested("params", "singleSandPerGate", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>手提沙包/趟</span><input type="number" style={inputStyle} value={config.params?.sandHandQty ?? 2} onChange={(e) => setNested("params", "sandHandQty", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>手提沙包分钟/趟</span><input type="number" style={inputStyle} value={config.params?.sandHandTime ?? 6} onChange={(e) => setNested("params", "sandHandTime", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>小车沙包/趟</span><input type="number" style={inputStyle} value={config.params?.sandCartQty ?? 6} onChange={(e) => setNested("params", "sandCartQty", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>小车沙包分钟/趟</span><input type="number" style={inputStyle} value={config.params?.sandCartTime ?? 5} onChange={(e) => setNested("params", "sandCartTime", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>完成时间权重</span><input type="number" style={inputStyle} value={config.params?.wTime ?? 100} onChange={(e) => setNested("params", "wTime", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>等待空挡权重</span><input type="number" style={inputStyle} value={config.params?.wIdle ?? 80} onChange={(e) => setNested("params", "wIdle", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>难度负担权重</span><input type="number" style={inputStyle} value={config.params?.wFatigue ?? 18} onChange={(e) => setNested("params", "wFatigue", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>高难连续权重</span><input type="number" style={inputStyle} value={config.params?.wHardStreak ?? 25} onChange={(e) => setNested("params", "wHardStreak", Number(e.target.value))} /></label>
          <label style={fieldStyle()}><span>趟数均衡权重</span><input type="number" style={inputStyle} value={config.params?.wTripBalance ?? 45} onChange={(e) => setNested("params", "wTripBalance", Number(e.target.value))} /></label>
        </div>
        <div style={{ marginTop: 14, overflowX: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <strong style={{ color: "#0f172a" }}>器材搬运规则</strong>
            <button type="button" style={{ ...buttonStyle, height: 32 }} onClick={saveRules}>保存规则</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff" }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>器材</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>每趟数量</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>人数</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>小车</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>每趟分钟</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>难度</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>启用</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(config.rules || {}).map(([type, rule]) => (
                <tr key={type}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", fontWeight: 900 }}>{rule.name || equipmentNames[type] || type}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="number" min="1" style={{ ...inputStyle, width: 82 }} value={rule.qty ?? 1} onChange={(e) => setRule(type, "qty", Number(e.target.value))} /></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="number" min="1" style={{ ...inputStyle, width: 82 }} value={rule.people ?? 1} onChange={(e) => setRule(type, "people", Number(e.target.value))} /></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="number" min="0" style={{ ...inputStyle, width: 82 }} value={rule.cart ?? 0} onChange={(e) => setRule(type, "cart", Number(e.target.value))} /></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="number" min="0.1" step="0.1" style={{ ...inputStyle, width: 92 }} value={rule.minutes ?? 1} onChange={(e) => setRule(type, "minutes", Number(e.target.value))} /></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="number" min="1" max="5" step="0.5" style={{ ...inputStyle, width: 82 }} value={rule.difficulty ?? 1} onChange={(e) => setRule(type, "difficulty", Number(e.target.value))} /></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><input type="checkbox" checked={rule.enabled !== false} onChange={(e) => setRule(type, "enabled", e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {status && <div style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13, marginTop: 8 }}>{status}</div>}
      {plans.length > 0 && (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                onClick={() => selectPlan(plan.id)}
                style={{ ...buttonStyle, height: "auto", textAlign: "left", padding: 12, minWidth: 210, flex: "1 1 210px", border: plan.selected ? "2px solid #2563eb" : "1px solid #e5e7eb", background: plan.selected ? "#eff6ff" : "#fff" }}
              >
                <div style={{ fontSize: 20, fontWeight: 950, color: "#0f172a" }}>{fmtMinutes(plan.estimated_minutes)}</div>
                <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>
                  人数 {plan.used_people_count} 人 / 空挡 {fmtMinutes(plan.idle_minutes)}
                </div>
              </button>
            ))}
          </div>
          <TransportPlanView planRecord={selected} />
        </div>
      )}
    </section>
  );
}

export function TrackAudiencePanel({ showEmpty = false }) {
  const [track, setTrack] = useState(null);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    function check() { setMobile(window.innerWidth < 768); }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    let stopped = false;
    async function load() {
      const result = await apiGet("/api/tracks/current", { track: null });
      if (!stopped) setTrack(result?.track || null);
    }
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!track) {
    if (!showEmpty) return null;
    return (
      <section style={{ ...panelStyle, borderRadius: 22, padding: 18, border: "1px solid rgba(226,232,240,.9)", background: "rgba(255,255,255,.92)" }}>
        <h2 style={{ margin: 0, fontSize: "clamp(22px, 6vw, 28px)", color: "#0f172a", fontWeight: 950 }}>训练赛道</h2>
        <div style={{ color: "#64748b", fontSize: 14, marginTop: 8 }}>还没有设置当前训练赛道。请在教练模式的赛道管理中创建赛道并设为当前训练赛道。</div>
      </section>
    );
  }
  const selectedPlan = track.selectedPlan || track.transportPlans?.find((plan) => plan.selected);

  return (
    <section style={{ ...panelStyle, borderRadius: 22, padding: 18, border: "1px solid rgba(226,232,240,.9)", background: "rgba(255,255,255,.92)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "clamp(22px, 6vw, 28px)", color: "#0f172a", fontWeight: 950 }}>训练赛道</h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 5 }}>{track.name} / 赛道长度 {track.routeLength ? `${Number(track.routeLength).toFixed(1)} m` : "--"}</div>
        </div>
        <div style={{ ...badgeStyle(track.syncStatus), borderRadius: 999, padding: "6px 10px", fontSize: 12, fontWeight: 900 }}>{track.syncStatus || "pending"}</div>
      </div>
      <div style={{ display: "grid", gap: 14 }}>
        <TrackPreview track={track} height={mobile ? 280 : 460} cropped showLink={false} mobile={mobile} />
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          {metric("器材统计", equipmentSummary(track.equipment))}
          {selectedPlan && <TransportPlanView planRecord={selectedPlan} compact mobile={mobile} />}
        </div>
      </div>
    </section>
  );
}

export default function TrackManagementPage() {
  const [tracks, setTracks] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ name: "", location: "", note: "", trackdrawEmbedUrl: "", trackdrawProjectId: "" });
  const [status, setStatus] = useState("正在读取赛道...");
  const [saving, setSaving] = useState(false);

  async function loadTracks(nextSelectedId = selectedId) {
    const list = await apiGet("/api/tracks", []);
    setTracks(Array.isArray(list) ? list : []);
    const pick = nextSelectedId || list?.[0]?.id || "";
    setSelectedId(pick);
    if (pick) {
      const nextDetail = await apiGet(`/api/tracks/${pick}`, null);
      setDetail(nextDetail);
      setForm(nextDetail || { name: "", location: "", note: "", trackdrawEmbedUrl: "", trackdrawProjectId: "" });
    } else {
      setDetail(null);
      setForm({ name: "", location: "", note: "", trackdrawEmbedUrl: "", trackdrawProjectId: "" });
    }
    setStatus("赛道数据已读取");
  }

  useEffect(() => {
    loadTracks("");
  }, []);

  async function selectTrack(id) {
    setSelectedId(id);
    const nextDetail = await apiGet(`/api/tracks/${id}`, null);
    setDetail(nextDetail);
    setForm(nextDetail || {});
  }

  function newTrack() {
    setSelectedId("");
    setDetail(null);
    setForm({ name: "", location: "", note: "", trackdrawEmbedUrl: "", trackdrawProjectId: "" });
  }

  async function saveTrack() {
    setSaving(true);
    setStatus("正在保存赛道...");
    try {
      const payload = {
        trackdrawEmbedUrl: form.trackdrawEmbedUrl,
        trackdrawProjectId: form.trackdrawProjectId,
      };
      const result = selectedId ? await apiPut(`/api/tracks/${selectedId}`, payload) : await apiPost("/api/tracks", payload);
      const id = result.track?.id || selectedId;
      setStatus("赛道已保存");
      await loadTracks(id);
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeTrack(id) {
    if (!window.confirm("确认删除这个赛道？")) return;
    await apiDelete(`/api/tracks/${id}`);
    await loadTracks("");
  }

  async function setCurrent(id) {
    await apiPost(`/api/tracks/${id}/current`, {});
    await loadTracks(id);
  }

  async function syncTrack() {
    if (!selectedId) return;
    setStatus("正在查询 TrackDraw API...");
    try {
      const result = await apiPost(`/api/tracks/${selectedId}/sync-trackdraw`, {});
      setDetail(result.track);
      setForm(result.track);
      setStatus("TrackDraw 同步成功");
      await loadTracks(selectedId);
    } catch (error) {
      setStatus(`TrackDraw 同步失败：${error.message}`);
      await loadTracks(selectedId);
    }
  }

  const readiness = trackReadiness(detail);
  const selectedPlan = useMemo(() => detail?.transportPlans?.find((plan) => plan.selected) || detail?.transportPlans?.[0] || null, [detail]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, color: "#0f172a", fontSize: 24 }}>赛道管理</h2>
            <div style={{ color: status.includes("失败") ? "#b91c1c" : "#64748b", fontSize: 13, marginTop: 5 }}>{status}</div>
          </div>
          <button type="button" style={primaryButtonStyle} onClick={newTrack}>新建赛道</button>
        </div>
      </section>

      <section style={panelStyle}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>赛道名称</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>场地</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>同步状态</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>最近更新</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>器材统计</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>搬运预计</th>
                <th style={{ padding: 8, borderBottom: "1px solid #e5e7eb" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => (
                <tr key={track.id} style={{ background: track.id === selectedId ? "#f8fafc" : "#fff" }}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9", fontWeight: 950 }}>{track.name}</td>
                  <td style={{ display: "none" }}>{track.location || "--"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}><span style={{ ...badgeStyle(track.syncStatus), borderRadius: 999, padding: "4px 8px", fontWeight: 900 }}>{track.syncStatus}</span></td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>{fmtTime(track.updatedAt)}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>{track.equipmentSummary || "--"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>{track.selectedPlan ? fmtMinutes(track.selectedPlan.estimated_minutes) : "--"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f1f5f9" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button type="button" style={{ ...buttonStyle, height: 32 }} onClick={() => selectTrack(track.id)}>查看</button>
                      <button type="button" style={{ ...buttonStyle, height: 32 }} onClick={() => selectTrack(track.id)}>编辑</button>
                      <button type="button" style={{ ...buttonStyle, height: 32 }} onClick={() => setCurrent(track.id)}>设为当前</button>
                      <button type="button" style={{ ...dangerButtonStyle, height: 32 }} onClick={() => removeTrack(track.id)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {tracks.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 18, color: "#64748b", textAlign: "center" }}>还没有赛道。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <TrackForm value={form} onChange={setForm} onSave={saveTrack} saving={saving} />

      {detail && (
        <>
          <section style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, color: "#0f172a" }}>赛道详情</h3>
                <div style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>projectId: {detail.trackdrawProjectId || "--"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a href="https://trackdraw.app" target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>打开 TrackDraw</a>
                {detail.trackdrawEmbedUrl && <a href={detail.trackdrawEmbedUrl} target="_blank" rel="noreferrer" style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>打开 TrackDraw 预览链接</a>}
                <button type="button" style={primaryButtonStyle} onClick={syncTrack}>查询 TrackDraw API</button>
              </div>
            </div>
            <div style={{ display: "none" }}>
              TrackDraw API Key 只在后端运行环境变量中设置：TRACKDRAW_API_KEY。修改 Key 后重启后端即可，不需要重新 build 前端。
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginBottom: 12 }}>
              {metric("最近同步", detail.trackdrawUpdatedAt ? new Date(detail.trackdrawUpdatedAt).toLocaleString("zh-CN", { hour12: false }) : "--")}
              {metric("赛道长度", detail.routeLength ? `${Number(detail.routeLength).toFixed(1)} m` : "--")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8, marginBottom: 12 }}>
              <div style={{ border: "1px solid #fca5a5", borderRadius: 8, padding: 10, background: "#fef2f2" }}>
                <div style={{ color: "#991b1b", fontSize: 12, fontWeight: 800 }}>极限圈速</div>
                <div style={{ color: "#7f1d1d", fontSize: 18, fontWeight: 950, marginTop: 2 }}>{detail.estimatedLapMs ? `${(Number(detail.estimatedLapMs) / 1000).toFixed(1)} s` : "填写"}</div>
              </div>
              <div style={{ border: "1px solid #fcd34d", borderRadius: 8, padding: 10, background: "#fffbeb" }}>
                <div style={{ color: "#92400e", fontSize: 12, fontWeight: 800 }}>优秀圈速</div>
                <div style={{ color: "#78350f", fontSize: 18, fontWeight: 950, marginTop: 2 }}>{detail.estimatedLapMs ? `${(Number(detail.estimatedLapMs) * 1.38 / 1000).toFixed(1)} s` : "--"}</div>
              </div>
              <div style={{ border: "1px solid #86efac", borderRadius: 8, padding: 10, background: "#f0fdf4" }}>
                <div style={{ color: "#166534", fontSize: 12, fontWeight: 800 }}>良好圈速</div>
                <div style={{ color: "#14532d", fontSize: 18, fontWeight: 950, marginTop: 2 }}>{detail.estimatedLapMs ? `${(Number(detail.estimatedLapMs) * 1.48 / 1000).toFixed(1)} s` : "--"}</div>
              </div>
            </div>
            {detail.syncError && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{detail.syncError}</div>}
            {readiness?.status && readiness.status !== "ready" && (
              <div style={{ border: "1px solid #fed7aa", background: "#fff7ed", color: "#9a3412", borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 13 }}>
                readiness issues：{(readiness.issues || []).map((item) => item.type).join("、") || "未通过 ready 检查"}
              </div>
            )}
          </section>

          <EquipmentEditor track={detail} onSaved={() => loadTracks(detail.id)} />

          <UnknownObjectEditor track={detail} onSaved={() => loadTracks(detail.id)} />

          <TransportPlanner track={detail} onSaved={() => loadTracks(detail.id)} />

          {false && selectedPlan && (
            <section style={panelStyle}>
              <h3 style={{ marginTop: 0, color: "#0f172a" }}>当前选中方案</h3>
              <TransportPlanView planRecord={selectedPlan} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
