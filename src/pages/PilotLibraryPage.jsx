import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, buttonStyle, defaultChannelConfig, inputStyle, panelStyle, primaryButtonStyle, textareaStyle } from "../trainingShared.js";
import { getCoachPassword, setCoachPassword, validateCoachPassword } from "../authConfig.js";

const axes = ["Roll", "Pitch", "Yaw"];
const betaflightFields = ["RC Rate", "Rate", "Expo"];
const actualFields = ["中央灵敏度", "最大角速度", "Expo"];
// 视觉参数：飞手档案中技能树和成长历程的统一固定高度，用户最终按视觉效果微调。
const PROFILE_PANEL_H = 210;
// 视觉参数：飞手档案技能树小节点宽度，影响思维导图横向密度。
const PROFILE_SKILL_NODE_W = 132;
// 视觉参数：飞手档案技能树小节点高度，影响星星和文字的拥挤程度。
const PROFILE_SKILL_NODE_H = 54;
// 视觉参数：飞手档案技能树父子节点横向间距。
const PROFILE_SKILL_H_GAP = 52;
// 视觉参数：飞手档案技能树同级节点纵向间距。
const PROFILE_SKILL_V_GAP = 14;
// 视觉参数：技能树默认完整预览的最小缩放，下限越小越容易把整棵树塞进窗口。
const PROFILE_SKILL_MIN_ZOOM = 0.25;
// 视觉参数：四象限图固定尺寸，太大会挤压右侧评估表。
const QUADRANT_SIZE = 188;
const FILLED_STAR_COLOR = "#facc15";
const EMPTY_STAR_COLOR = "#d4d4d8";
const channelFunctions = [
  ["mode", "模式"],
  ["arm", "解锁"],
  ["turtle", "反乌龟"],
  ["empty", "空"],
  ["custom", "自定义"],
];
const modeOptions = ["Angle", "Air", "Acro"];

function hasSkillStars(skill) {
  return Array.isArray(skill?.star_criteria) && skill.star_criteria.length > 0;
}

async function apiCoachGet(path, fallback) {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      headers: { "x-coach-password": getCoachPassword() },
    });
    if (!response.ok) throw new Error("request failed");
    return await response.json();
  } catch {
    return fallback;
  }
}

async function apiCoachPost(path, data) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-coach-password": getCoachPassword() },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text);
      message = payload.error || payload.message || message;
    } catch {
      // 保留服务端原始错误文本。
    }
    throw new Error(message);
  }
  return response.json();
}

async function apiCoachDelete(path) {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "x-coach-password": getCoachPassword() },
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text);
      message = payload.error || payload.message || message;
    } catch {
      // 保留服务端原始错误文本。
    }
    throw new Error(message);
  }
  return response.json();
}

function scoreValue(form, key) {
  return Number(form[key] || 0);
}

function getNetValue(form) {
  const raw = (
    2 * scoreValue(form, "parent_investment")
    + 2 * scoreValue(form, "award_potential")
    + scoreValue(form, "training_enthusiasm")
    + scoreValue(form, "short_term_result_speed")
    - scoreValue(form, "service_cost")
  );
  return Math.max(0, Math.min(100, ((raw - 1) / 28) * 100));
}

function growthDateKey(value) {
  const date = new Date(value || Date.now());
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function displayGrowthDetail(item) {
  const detail = String(item?.label || item?.detail || "").replace(/^.*?：/, "");
  const match = detail.match(/^(.+?)\s*已点亮\s*(\d+)\s*颗[⭐星]?/);
  if (match) return `${match[1]} ${match[2]}颗⭐`;
  const fallback = String(item?.detail || "").replace(/^.*?：/, "");
  const fallbackMatch = fallback.match(/^(.+?)\s*已点亮\s*(\d+)\s*颗[⭐星]?/);
  if (fallbackMatch) return `${fallbackMatch[1]} ${fallbackMatch[2]}颗⭐`;
  return fallback || detail || "无详情";
}

function growthCardText(item) {
  if (item?.type === "coach_comment") return item.detail || "无评语";
  if (item?.type === "quiz_result") {
    const detail = item.detail || "小测成绩";
    return detail.startsWith("小测:") ? detail : `小测:${detail}`;
  }
  if (item?.type === "star") return displayGrowthDetail(item);
  return normalizeTrainingSummaryText(item?.label || item?.detail || "无详情");
}

function growthSelectedDetail(item) {
  if (item?.type === "star") return item.metadata?.criterion || "暂无该星级标准";
  if (item?.type === "quiz_result") {
    const detail = item.detail || "小测成绩";
    return detail.startsWith("小测:") ? detail : `小测:${detail}`;
  }
  return normalizeTrainingSummaryText(item?.detail || "无详情");
}

function normalizeTrainingSummaryText(value) {
  return String(value || "").replace(/，\s*(利用率)/g, "\n$1");
}

function isMultilineGrowthItem(item) {
  return item?.type === "coach_comment" || item?.type === "quiz_result" || item?.type === "training_summary";
}

function isHiddenGrowthItem(item) {
  return Boolean(item?.metadata?.hidden);
}

function getAttentionWeight(form) {
  return 0.05 + ((
    0.35 * scoreValue(form, "parent_investment")
    + 0.30 * scoreValue(form, "award_potential")
    + 0.20 * scoreValue(form, "training_enthusiasm")
    + 0.15 * scoreValue(form, "short_term_result_speed")
    - 0.25 * scoreValue(form, "service_cost")
    + 0.25
  ) / 5) * 0.30;
}

function quadrantFromScores(netValue, serviceCost) {
  const highE = Number(netValue) >= 50;
  const highC = Number(serviceCost) >= 3.5;
  if (highE && !highC) return "core";
  if (highE && highC) return "potential";
  if (!highE && !highC) return "standard";
  return "risk";
}

function quadrantLabel(value) {
  return {
    core: "S/A 核心资产型",
    potential: "R 高潜高耗型",
    standard: "B 标准兴趣型",
    risk: "C 亏损风险型",
  }[value] || "B 标准兴趣型";
}

function quadrantStrategy(value) {
  return {
    core: "重点培养、比赛冲刺、深度家长交付",
    potential: "先管规则，再给资源",
    standard: "标准化服务，维持兴趣和续费",
    risk: "限制资源、家长沟通、转班或劝退",
  }[value] || "标准化服务，维持兴趣和续费";
}

function computeProfileSkillLayout(skills) {
  const childrenMap = new Map();
  for (const skill of skills) {
    const key = skill.parent_id || "__root__";
    const list = childrenMap.get(key) || [];
    list.push(skill);
    childrenMap.set(key, list);
  }

  const layout = new Map();
  function layoutSubtree(skill, depth, topY) {
    const kids = childrenMap.get(skill.skill_id) || [];
    const x = depth * (PROFILE_SKILL_NODE_W + PROFILE_SKILL_H_GAP);
    if (!kids.length) {
      layout.set(skill.skill_id, { x, y: topY });
      return PROFILE_SKILL_NODE_H;
    }

    let childTop = topY;
    kids.forEach((child) => {
      childTop += layoutSubtree(child, depth + 1, childTop) + PROFILE_SKILL_V_GAP;
    });
    const first = layout.get(kids[0].skill_id);
    const last = layout.get(kids[kids.length - 1].skill_id);
    layout.set(skill.skill_id, { x, y: (first.y + last.y) / 2 });
    return Math.max(PROFILE_SKILL_NODE_H, childTop - topY - PROFILE_SKILL_V_GAP);
  }

  let top = 18;
  (childrenMap.get("__root__") || []).forEach((root) => {
    top += layoutSubtree(root, 0, top) + 26;
  });

  let width = 360;
  let height = PROFILE_PANEL_H;
  for (const pos of layout.values()) {
    width = Math.max(width, pos.x + PROFILE_SKILL_NODE_W + 24);
    height = Math.max(height, pos.y + PROFILE_SKILL_NODE_H + 18);
  }
  return { layout, width, height };
}

function cloneConfig(config) {
  return {
    ch5: (config?.ch5 || defaultChannelConfig.ch5).map((item) => ({ ...item })),
    ch6: (config?.ch6 || []).map((item) => ({ ...item })),
    ch7: (config?.ch7 || []).map((item) => ({ ...item })),
    ch8: (config?.ch8 || []).map((item) => ({ ...item })),
  };
}

function makeDefaultRates() {
  return {
    type: "Actual",
    Betaflight: {
      Roll: { "RC Rate": 1.0, Rate: 0.7, Expo: 0.0 },
      Pitch: { "RC Rate": 1.0, Rate: 0.7, Expo: 0.0 },
      Yaw: { "RC Rate": 1.0, Rate: 0.7, Expo: 0.0 },
    },
    Actual: {
      Roll: { 中央灵敏度: 120, 最大角速度: 600, Expo: 0.0 },
      Pitch: { 中央灵敏度: 120, 最大角速度: 600, Expo: 0.0 },
      Yaw: { 中央灵敏度: 120, 最大角速度: 600, Expo: 0.0 },
    },
  };
}

function normalizeRates(pilot) {
  if (pilot.rateProfile) return pilot.rateProfile;
  return makeDefaultRates();
}

function makeNewPilot(index) {
  return {
    id: `pilot-${Date.now()}-${index}`,
    name: `新飞手 ${index}`,
    rates: "BF: 600/600/500",
    rateProfile: makeDefaultRates(),
    note: "",
    channelConfig: cloneConfig(defaultChannelConfig),
  };
}

function RangeSlider({ range, disabled, onChange }) {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(null);
  const min = Number(range.min ?? 1500);
  const max = Number(range.max ?? 1998);
  const minPercent = ((min - 900) / 1098) * 100;
  const maxPercent = ((max - 900) / 1098) * 100;

  const setMin = useCallback((value) => {
    onChange({ ...range, min: Math.min(Number(value), max - 1) });
  }, [max, onChange, range]);

  const setMax = useCallback((value) => {
    onChange({ ...range, max: Math.max(Number(value), min + 1) });
  }, [min, onChange, range]);

  const valueFromPointer = useCallback((clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return min;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(900 + ratio * 1098);
  }, [min]);

  const moveThumb = useCallback((thumb, value) => {
    if (thumb === "min") setMin(value);
    if (thumb === "max") setMax(value);
  }, [setMax, setMin]);

  function handleTrackPointer(event) {
    if (disabled) return;
    const value = valueFromPointer(event.clientX);
    const thumb = Math.abs(value - min) <= Math.abs(value - max) ? "min" : "max";
    setDragging(thumb);
    moveThumb(thumb, value);
  }

  function handleThumbPointer(event, thumb) {
    if (disabled) return;
    event.stopPropagation();
    event.preventDefault();
    setDragging(thumb);
  }

  useEffect(() => {
    if (!dragging || disabled) return undefined;
    function handlePointerMove(event) {
      moveThumb(dragging, valueFromPointer(event.clientX));
    }
    function stopDragging() {
      setDragging(null);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [dragging, disabled, min, max, moveThumb, valueFromPointer]);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "78px minmax(120px,1fr) 78px", gap: 8, alignItems: "center", maxWidth: "100%" }}>
        <input type="number" value={min} disabled={disabled} onChange={(e) => setMin(e.target.value)} style={inputStyle} />
        <div
          ref={trackRef}
          style={{ position: "relative", height: 38, minWidth: 0, touchAction: "none", cursor: disabled ? "default" : "pointer" }}
          onPointerDown={handleTrackPointer}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: 17, height: 4, background: "#dbeafe", borderRadius: 999 }} />
          <div style={{ position: "absolute", left: `${minPercent}%`, right: `${100 - maxPercent}%`, top: 17, height: 4, background: "#2563eb", borderRadius: 999 }} />
          <div
            role="slider"
            aria-valuemin={900}
            aria-valuemax={max - 1}
            aria-valuenow={min}
            onPointerDown={(event) => handleThumbPointer(event, "min")}
            style={{ position: "absolute", left: `calc(${minPercent}% - 8px)`, top: 8, width: 16, height: 22, borderRadius: 6, background: disabled ? "#94a3b8" : "#2563eb", cursor: disabled ? "default" : "ew-resize", boxShadow: "0 2px 6px rgba(37,99,235,0.25)", userSelect: "none" }}
          />
          <div
            role="slider"
            aria-valuemin={min + 1}
            aria-valuemax={1998}
            aria-valuenow={max}
            onPointerDown={(event) => handleThumbPointer(event, "max")}
            style={{ position: "absolute", left: `calc(${maxPercent}% - 8px)`, top: 8, width: 16, height: 22, borderRadius: 6, background: disabled ? "#94a3b8" : "#2563eb", cursor: disabled ? "default" : "ew-resize", boxShadow: "0 2px 6px rgba(37,99,235,0.25)", userSelect: "none" }}
          />
        </div>
        <input type="number" value={max} disabled={disabled} onChange={(e) => setMax(e.target.value)} style={inputStyle} />
      </div>
    </div>
  );
}

function RateTable({ profile, onChange }) {
  const type = profile.type || "Betaflight";
  const fields = type === "Actual" ? actualFields : betaflightFields;
  const data = profile[type] || makeDefaultRates()[type];

  function update(axis, field, value) {
    onChange({
      ...profile,
      [type]: {
        ...profile[type],
        [axis]: {
          ...data[axis],
          [field]: Number(value),
        },
      },
    });
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f8fafc", color: "#111827" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {["Betaflight", "Actual"].map((item) => (
          <button key={item} type="button" style={type === item ? primaryButtonStyle : buttonStyle} onClick={() => onChange({ ...profile, type: item })}>
            {item}
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `90px repeat(${fields.length}, minmax(120px,1fr))`, gap: 6, alignItems: "center" }}>
        <strong>轴</strong>
        {fields.map((field) => <strong key={field}>{field}</strong>)}
        {axes.map((axis) => (
          <div key={axis} style={{ display: "contents" }}>
            <strong>{axis}</strong>
            {fields.map((field) => (
              <input key={`${axis}-${field}`} type="number" step="0.01" value={data[axis]?.[field] ?? 0} onChange={(e) => update(axis, field, e.target.value)} style={inputStyle} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChannelRanges({ channelKey, ranges, fixed, onChange }) {
  const canAddSubFunction = !fixed && (ranges.length === 0 || ranges.some((range) => range.type === "mode" || range.type === "custom"));
  function updateRange(index, patch) {
    onChange(ranges.map((range, itemIndex) => (itemIndex === index ? { ...range, ...patch } : range)));
  }

  function updateFunction(index, type) {
    const labels = { arm: "Arm", mode: "Angle", turtle: "Turtle", empty: "空", custom: "自定义" };
    updateRange(index, { type, name: labels[type] || "自定义", min: type === "empty" ? 900 : 1500, max: type === "empty" ? 900 : 1998 });
  }

  function addRange() {
    onChange([...ranges, { name: "Angle", type: "mode", min: 1500, max: 1998 }]);
  }

  function removeRange(index) {
    onChange(ranges.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#f8fafc" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <strong>{channelKey.toUpperCase()}</strong>
        {canAddSubFunction && <button type="button" style={buttonStyle} onClick={addRange}>加子功能</button>}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {ranges.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13 }}>空通道</div>}
        {ranges.map((range, index) => {
          const disabled = range.type === "empty";
          return (
            <div key={`${channelKey}-${index}`} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#fff", minWidth: 0 }}>
              <div style={{ display: "grid", gridTemplateColumns: "96px minmax(90px,1fr) 76px", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <select value={range.type} disabled={fixed} onChange={(e) => updateFunction(index, e.target.value)} style={inputStyle}>
                  {channelFunctions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {range.type === "mode" ? (
                  <select value={range.name} disabled={fixed} onChange={(e) => updateRange(index, { name: e.target.value })} style={inputStyle}>
                    {modeOptions.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                ) : (
                  <input value={range.name} disabled={fixed || range.type !== "custom"} onChange={(e) => updateRange(index, { name: e.target.value })} style={inputStyle} />
                )}
                {!fixed && <button type="button" style={{ ...buttonStyle, minWidth: 72, whiteSpace: "nowrap" }} onClick={() => removeRange(index)}>删除</button>}
              </div>
              <RangeSlider range={range} disabled={disabled} onChange={(nextRange) => updateRange(index, nextRange)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkillPreview({ pilotId, refreshKey = 0, onAchievement }) {
  const [skills, setSkills] = useState([]);
  const [status, setStatus] = useState("");
  const [zoom, setZoom] = useState(0.9);
  const [pan, setPan] = useState({ x: 18, y: 12 });
  const [drag, setDrag] = useState(null);
  const viewRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    async function loadOnce() {
      setStatus("正在读取技能树...");
      const rows = await apiGet(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/skills`, []);
      if (!stopped) {
        setSkills(Array.isArray(rows) ? rows : []);
        setStatus("");
      }
    }
    loadOnce();
    return () => {
      stopped = true;
    };
  }, [pilotId, refreshKey]);

  useEffect(() => {
    if (!drag) return undefined;
    function handleMove(event) {
      setPan({ x: drag.px + event.clientX - drag.sx, y: drag.py + event.clientY - drag.sy });
    }
    function handleUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag]);

  const { layout, width, height } = useMemo(() => computeProfileSkillLayout(skills), [skills]);

  useEffect(() => {
    if (!skills.length) return undefined;
    const timer = window.setTimeout(() => {
      const rect = viewRef.current?.getBoundingClientRect();
      if (!rect?.width || !rect?.height) return;
      // 视觉参数：默认缩放留出四周边距，让飞手档案中尽量完整看到技能树。
      const fit = Math.max(PROFILE_SKILL_MIN_ZOOM, Math.min(1, (rect.width - 28) / width, (rect.height - 28) / height));
      setZoom(fit);
      setPan({ x: 14, y: 14 });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [height, skills.length, width]);

  async function setSkillStars(skill, stars) {
    if (!hasSkillStars(skill)) return;
    setStatus("正在记录成就...");
    try {
      await apiCoachPost(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/skills/${encodeURIComponent(skill.skill_id)}`, {
        stars,
        method: "飞手档案点亮",
        note: `${skill.name} 已点亮 ${stars} 颗⭐`,
      });
      const rows = await apiGet(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/skills`, []);
      setSkills(Array.isArray(rows) ? rows : []);
      setStatus(`已点亮 ${stars} 颗⭐`);
      onAchievement?.();
    } catch (error) {
      setStatus(`记录失败：${error.message}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8, }}>
      <div style={{ fontWeight: 900, color: "#0f172a", fontSize: 13, textAlign: "center"}}>技能树</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.max(PROFILE_SKILL_MIN_ZOOM, value - 0.1))}>-</button>
        <span style={{ fontSize: 12, color: "#64748b", minWidth: 42, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>+</button>
        <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => { setZoom(0.9); setPan({ x: 18, y: 12 }); }}>重置</button>
      </div>
      <div
        ref={viewRef}
        style={{ height: PROFILE_PANEL_H, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f8fafc", padding: 12, overflow: "hidden", position: "relative", cursor: drag ? "grabbing" : "grab", boxSizing: "border-box", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
        onPointerDown={(event) => {
          if (event.target.closest("button")) return;
          setDrag({ sx: event.clientX, sy: event.clientY, px: pan.x, py: pan.y });
        }}
      >
        {status && <div style={{ color: "#64748b", fontSize: 13 }}>{status}</div>}
        {!status && skills.length === 0 && <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: `${PROFILE_PANEL_H - 24}px` }}>暂无技能树数据</div>}
        {skills.length > 0 && (
          <div style={{ position: "absolute", left: 0, top: 0, width, height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "top left", userSelect: "none", WebkitUserSelect: "none" }}>
            <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {skills.filter((skill) => skill.parent_id).map((skill) => {
                const parent = layout.get(skill.parent_id);
                const child = layout.get(skill.skill_id);
                if (!parent || !child) return null;
                const x1 = parent.x + PROFILE_SKILL_NODE_W;
                const y1 = parent.y + PROFILE_SKILL_NODE_H / 2;
                const x2 = child.x;
                const y2 = child.y + PROFILE_SKILL_NODE_H / 2;
                const midX = x1 + Math.max(24, (x2 - x1) / 2);
                return <path key={`${skill.parent_id}-${skill.skill_id}`} d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`} fill="none" stroke="#cbd5e1" strokeWidth="1.5" />;
              })}
            </svg>
            {skills.map((skill) => {
              const pos = layout.get(skill.skill_id);
              if (!pos) return null;
              const canScore = hasSkillStars(skill);
              return (
                <div
                  key={skill.skill_id}
                  style={{
                    position: "absolute",
                    left: pos.x,
                    top: pos.y,
                    width: PROFILE_SKILL_NODE_W,
                    height: PROFILE_SKILL_NODE_H,
                    border: skill.parent_id ? "1px solid #d4d4d8" : "2px solid #93c5fd",
                    borderRadius: 10,
                    background: "#fff",
                    padding: "7px 9px",
                    boxSizing: "border-box",
                    display: "grid",
                    gridTemplateRows: canScore ? "18px 18px" : "1fr",
                    gap: 3,
                    alignContent: "center",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, lineHeight: "18px", fontWeight: skill.parent_id ? 700 : 900, color: "#0f172a" }}>{skill.name}</span>
                  <span style={{ display: canScore ? "inline-flex" : "none", alignItems: "center", justifyContent: "center", height: 18, gap: 1 }}>
                    {Array.from({ length: 5 }, (_, index) => (
                      <button
                        key={index}
                        type="button"
                        title={`点亮 ${index + 1} 星`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSkillStars(skill, index + 1);
                        }}
                        style={{ border: "none", background: "transparent", padding: 0, margin: 0, cursor: "pointer", color: index < Number(skill.current_stars || 0) ? FILLED_STAR_COLOR : EMPTY_STAR_COLOR, fontSize: 11, lineHeight: "18px", userSelect: "none", WebkitUserSelect: "none", touchAction: "manipulation" }}
                      >
                        ★
                      </button>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function GrowthTimeline({ pilotId, refreshKey = 0, onDeleted }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 12, y: 18 });
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    let stopped = false;
    async function loadGrowth() {
      const rows = await apiGet(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/growth`, []);
      if (!stopped) setItems(Array.isArray(rows) ? rows : []);
    }
    loadGrowth();
    return () => {
      stopped = true;
    };
  }, [pilotId, refreshKey]);

  async function deleteGrowth(item) {
    if (!window.confirm("确定删除这条成长记录并撤销对应星级？")) return;
    await apiCoachDelete(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/growth/${encodeURIComponent(item.id)}`);
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setSelected(null);
    onDeleted?.();
  }

  async function setGrowthHidden(item, hidden) {
    const saved = await apiCoachPost(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/growth/${encodeURIComponent(item.id)}/hidden`, { hidden });
    setItems((current) => current.map((entry) => (entry.id === item.id ? saved : entry)));
    if (hidden && !showHidden) setSelected(null);
    else setSelected(saved);
  }

  async function addCoachComment(dateKey) {
    const detail = window.prompt(`${dateKey} 教练评语`);
    if (!detail?.trim()) return;
    const occurredAt = new Date(`${dateKey}T12:00:00`).getTime();
    const saved = await apiCoachPost(`/api/teaching/pilot/${encodeURIComponent(pilotId)}/growth`, {
      type: "coach_comment",
      label: "教练评语",
      detail: detail.trim(),
      occurredAt,
    });
    setItems((current) => [saved, ...current].sort((left, right) => Number(right.occurred_at || 0) - Number(left.occurred_at || 0)));
    onDeleted?.();
  }

  useEffect(() => {
    if (!drag) return undefined;
    function handleMove(event) {
      setPan({ x: drag.px + event.clientX - drag.sx, y: drag.py + event.clientY - drag.sy });
    }
    function handleUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of items.filter((entry) => showHidden || !isHiddenGrowthItem(entry))) {
      const key = growthDateKey(item.occurred_at);
      map.set(key, [...(map.get(key) || []), item]);
    }
    return [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, entries]) => ({ date, entries: entries.slice().sort((left, right) => Number(left.occurred_at || 0) - Number(right.occurred_at || 0)) }));
  }, [items, showHidden]);

  const hiddenCount = useMemo(() => items.filter(isHiddenGrowthItem).length, [items]);

  const timeline = (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 6 }}>
        <div style={{ fontWeight: 900, color: "#0f172a", fontSize: 13 }}>成长历程</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.max(0.55, value - 0.1))}>-</button>
          <span style={{ fontSize: 12, color: "#64748b", minWidth: 42, textAlign: "center", lineHeight: "24px" }}>{Math.round(zoom * 100)}%</span>
          <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}>+</button>
          <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => { setZoom(1); setPan({ x: 12, y: 18 }); }}>重置</button>
          <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => setFullscreen(true)}>全屏</button>
          {hiddenCount > 0 && (
            <button type="button" style={{ ...buttonStyle, height: 24, padding: "0 8px", fontSize: 11, color: showHidden ? "#2563eb" : "#64748b" }} onClick={() => setShowHidden((value) => !value)}>
              {showHidden ? "隐藏隐藏" : `显示隐藏(${hiddenCount})`}
            </button>
          )}
        </div>
      </div>
      <div
        style={{ height: fullscreen ? "62vh" : PROFILE_PANEL_H, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f8fafc", padding: 12, overflow: "hidden", boxSizing: "border-box", position: "relative", cursor: drag ? "grabbing" : "grab", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
        onPointerDown={(event) => {
          if (event.target.closest("button")) return;
          setDrag({ sx: event.clientX, sy: event.clientY, px: pan.x, py: pan.y });
        }}
      >
        {groups.length === 0 ? (
          <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: `${PROFILE_PANEL_H - 24}px` }}>暂无成长记录</div>
        ) : (
          <div style={{ position: "absolute", left: 0, top: 0, display: "flex", alignItems: "flex-start", gap: 18, minWidth: "max-content", padding: "12px 4px", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "top left", userSelect: "none", WebkitUserSelect: "none" }}>
            {groups.map((group, index) => (
              <div key={group.date} style={{ position: "relative", width: 150, border: "1px solid #bfdbfe", borderRadius: 12, background: "#fff", padding: 10, display: "grid", alignContent: "start", alignItems: "start", gap: 6 }}>
                {index > 0 && <span style={{ position: "absolute", left: -18, top: 30, width: 18, color: "#93c5fd", fontWeight: 950, textAlign: "center" }}>→</span>}
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}>
                  <strong style={{ color: "#2563eb", fontSize: 12 }}>{group.date.slice(5)}</strong>
                  <button type="button" title="添加教练评语" style={{ ...buttonStyle, width: 24, height: 24, padding: 0, borderRadius: 999, fontSize: 14 }} onClick={() => addCoachComment(group.date)}>+</button>
                </div>
                {group.entries.map((item) => (
                  <button key={item.id} type="button" onClick={() => setSelected(item)} style={{ height: "auto", alignSelf: "start", border: isHiddenGrowthItem(item) ? "1px dashed #cbd5e1" : "1px solid #e2e8f0", borderRadius: 8, background: isHiddenGrowthItem(item) ? "#f1f5f9" : item.type === "coach_comment" ? "#fff7ed" : item.type === "quiz_result" ? "#eff6ff" : "#f8fafc", opacity: isHiddenGrowthItem(item) ? 0.65 : 1, padding: "6px 8px", textAlign: "left", cursor: "pointer" }}>
                    <span style={{ display: "block", color: "#0f172a", fontSize: 12, fontWeight: 900, whiteSpace: isMultilineGrowthItem(item) ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: isMultilineGrowthItem(item) ? "clip" : "ellipsis", overflowWrap: "anywhere", lineHeight: 1.45 }}>{growthCardText(item)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div style={{ border: "1px solid #dbeafe", borderRadius: 12, padding: 10, background: "#eff6ff", fontSize: 13, color: "#334155" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <strong style={{ color: "#0f172a" }}>{selected.type === "star" ? displayGrowthDetail(selected) : selected.label}</strong>
            <div style={{ display: "flex", gap: 6 }}>
              {selected.type === "star" && (
                <button type="button" style={{ ...buttonStyle, height: 26, padding: "0 8px", fontSize: 12, color: isHiddenGrowthItem(selected) ? "#2563eb" : "#64748b", borderColor: isHiddenGrowthItem(selected) ? "#bfdbfe" : "#cbd5e1" }} onClick={() => setGrowthHidden(selected, !isHiddenGrowthItem(selected))}>
                  {isHiddenGrowthItem(selected) ? "取消隐藏" : "隐藏"}
                </button>
              )}
              <button type="button" style={{ ...buttonStyle, height: 26, padding: "0 8px", fontSize: 12, color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteGrowth(selected)}>删除</button>
              <button type="button" style={{ ...buttonStyle, height: 26, padding: "0 8px", fontSize: 12 }} onClick={() => setSelected(null)}>关闭</button>
            </div>
          </div>
          <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{growthSelectedDetail(selected)}</div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {timeline}
      {fullscreen && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(15,23,42,0.48)", padding: 18, display: "grid", placeItems: "center" }}>
          <div style={{ width: "min(1180px, 100%)", maxHeight: "90vh", overflow: "hidden", background: "#fff", borderRadius: 14, padding: 14, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <strong style={{ color: "#0f172a" }}>成长历程全屏查看</strong>
              <button type="button" style={buttonStyle} onClick={() => setFullscreen(false)}>关闭</button>
            </div>
            {timeline}
          </div>
        </div>
      )}
    </>
  );
}

function CoachEvaluationPanel({ pilotId }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({
    pilot_id: pilotId,
    training_roi: 3,
    award_potential: 3,
    parent_investment: 3,
    training_enthusiasm: 3,
    short_term_result_speed: 3,
    phase_value: 3,
    service_cost: 3,
    quadrant: "watch",
    attention_weight: getAttentionWeight({ parent_investment: 3, award_potential: 3, training_enthusiasm: 3, short_term_result_speed: 3, service_cost: 3 }),
  });

  function updateScore(key, value) {
    setForm((current) => {
      const next = { ...current, [key]: Number(value) };
      if (key === "service_cost") next.phase_value = Number(value);
      const netValue = getNetValue(next);
      const quadrant = quadrantFromScores(netValue, next.service_cost);
      return { ...next, training_roi: netValue, quadrant, attention_weight: getAttentionWeight(next) };
    });
  }

  async function unlock() {
    const nextPassword = password.trim();
    if (!nextPassword) {
      setStatus("请输入教练密码");
      return;
    }
    try {
      await validateCoachPassword(nextPassword);
      setCoachPassword(nextPassword);
    } catch (error) {
      setStatus(error.message || "密码不正确");
      return;
    }
    setUnlocked(true);
    setStatus("正在读取分层评估...");
    const rows = await apiCoachGet("/api/teaching/stratification", []);
    const existing = rows.find((row) => row.pilot_id === pilotId);
    if (existing) {
      setForm((current) => {
        const next = { ...current, ...existing, service_cost: existing.service_cost ?? existing.phase_value ?? current.service_cost };
        const netValue = getNetValue(next);
        const quadrant = quadrantFromScores(netValue, next.service_cost);
        return { ...next, training_roi: netValue, quadrant, attention_weight: getAttentionWeight(next) };
      });
    }
    setStatus("");
  }

  async function save() {
    setStatus("正在保存分层评估...");
    try {
      await apiCoachPost("/api/teaching/stratification", [{ ...form, pilot_id: pilotId, phase_value: form.service_cost, training_roi: getNetValue(form), attention_weight: getAttentionWeight(form) }]);
      setStatus("");
      setPassword("");
      setUnlocked(false);
    } catch (error) {
      setStatus(`保存失败：${error.message}`);
    }
  }

  const netValue = getNetValue(form);
  const attentionWeight = getAttentionWeight(form);
  const pointLeft = `${Math.max(0, Math.min(100, netValue))}%`;
  const pointBottom = `${Math.max(0, Math.min(100, ((Number(form.service_cost || 0) - 1) / 4) * 100))}%`;
  const fields = [
    ["parent_investment", "P 付费确定性"],
    ["award_potential", "S 成长展示价值"],
    ["training_enthusiasm", "A 自驱配合度"],
    ["short_term_result_speed", "R 短期成果速度"],
    ["service_cost", "C 服务成本"],
  ];

  if (!unlocked) {
    return (
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,1fr) auto", gap: 8, alignItems: "center" }}>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="教练密码" style={inputStyle} />
          <button type="button" style={buttonStyle} onClick={unlock}>解锁评估</button>
        </div>
        {status && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 6 }}>{status}</div>}
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong>教练分层评估</strong>
        <span style={{ color: "#2563eb", fontWeight: 900 }}>{quadrantLabel(form.quadrant)} · N {netValue.toFixed(1)} · W {attentionWeight.toFixed(2)}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `minmax(240px,1fr) ${QUADRANT_SIZE}px`, gap: 14, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "86px minmax(120px,1fr) 46px", gap: 8, alignItems: "center", fontSize: 13 }}>
            <span>N 净价值</span>
            <div style={{ height: 8, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(0, Math.min(100, netValue))}%`, height: "100%", background: "#16a34a" }} />
            </div>
            <strong>{netValue.toFixed(1)}</strong>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "86px minmax(120px,1fr) 46px", gap: 8, alignItems: "center", fontSize: 13 }}>
            <span>W 权重</span>
            <div style={{ height: 8, borderRadius: 999, background: "#e5e7eb", overflow: "hidden" }}>
              <div style={{ width: `${Math.max(0, Math.min(100, ((attentionWeight - 0.05) / 0.30) * 100))}%`, height: "100%", background: "#2563eb" }} />
            </div>
            <strong>{attentionWeight.toFixed(2)}</strong>
          </div>
          {fields.map(([key, label]) => (
            <label key={key} style={{ display: "grid", gridTemplateColumns: "112px minmax(120px,1fr) 28px", gap: 8, alignItems: "center", fontSize: 13 }}>
              <span>{label}</span>
              <input type="range" min="1" max="5" step="0.5" value={form[key]} onChange={(event) => updateScore(key, event.target.value)} />
              <strong>{Number(form[key]).toFixed(1)}</strong>
            </label>
          ))}
        </div>
        <div style={{ width: QUADRANT_SIZE, height: QUADRANT_SIZE, position: "relative", border: "1px solid #cbd5e1", borderRadius: 12, background: "linear-gradient(90deg,#f8fafc 50%,#eff6ff 50%), linear-gradient(0deg,#fff7ed 50%,transparent 50%)", overflow: "hidden" }}>
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "#cbd5e1" }} />
          <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "#cbd5e1" }} />
          <span style={{ position: "absolute", left: 8, top: 8, fontSize: 11, color: "#64748b" }}>C 亏损风险</span>
          <span style={{ position: "absolute", right: 8, top: 8, fontSize: 11, color: "#64748b" }}>R 高潜高耗</span>
          <span style={{ position: "absolute", left: 8, bottom: 8, fontSize: 11, color: "#64748b" }}>B 标准兴趣</span>
          <span style={{ position: "absolute", right: 8, bottom: 8, fontSize: 11, color: "#64748b" }}>S/A 核心资产</span>
          <span style={{ position: "absolute", left: `calc(${pointLeft} - 7px)`, bottom: `calc(${pointBottom} - 7px)`, width: 14, height: 14, borderRadius: 999, background: "#2563eb", boxShadow: "0 0 0 4px rgba(37,99,235,.18)" }} />
        </div>
      </div>
      <div style={{ color: "#475569", fontSize: 13, lineHeight: 1.6 }}>W = 0.05 + ((0.35P + 0.30S + 0.20A + 0.15R - 0.25C + 0.25) / 5) × 0.30。象限仅作标签展示，不决定资源比例。策略：{quadrantStrategy(form.quadrant)}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" }}>
        {status && <span style={{ color: status.includes("失败") ? "#b91c1c" : "#047857", fontSize: 13 }}>{status}</span>}
        <button type="button" style={primaryButtonStyle} onClick={save}>保存评估</button>
      </div>
    </div>
  );
}

export default function PilotLibraryPage({ pilots, onSave }) {
  const [draftPilots, setDraftPilots] = useState(pilots);
  const [openPilotIds, setOpenPilotIds] = useState(new Set());
  const [saveText, setSaveText] = useState("");
  const [growthRefreshByPilot, setGrowthRefreshByPilot] = useState({});
  const [skillRefreshByPilot, setSkillRefreshByPilot] = useState({});

  function togglePilot(id) {
    setOpenPilotIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function updatePilot(id, patch) {
    setDraftPilots((current) => current.map((pilot) => (pilot.id === id ? { ...pilot, ...patch } : pilot)));
  }

  function updatePilotChannel(id, channelKey, ranges) {
    setDraftPilots((current) => current.map((pilot) => (
      pilot.id === id
        ? { ...pilot, channelConfig: { ...cloneConfig(pilot.channelConfig), [channelKey]: ranges } }
        : pilot
    )));
  }

  function addPilot() {
    setDraftPilots((current) => [...current, makeNewPilot(current.length + 1)]);
  }

  function removePilot(id) {
    const pilot = draftPilots.find((item) => item.id === id);
    if (!window.confirm(`确定删除飞手“${pilot?.name || id}”吗？保存飞手库后生效。历史训练记录不会被删除。`)) return;
    setDraftPilots((current) => current.filter((pilot) => pilot.id !== id));
  }

  async function savePilotLibrary() {
    setSaveText("正在保存飞手库...");
    try {
      await onSave(draftPilots);
      setSaveText("飞手库已保存");
    } catch (error) {
      setSaveText(`飞手库保存失败：${error.message}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={{ ...panelStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>飞手档案</h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>基础信息、技能成长、教练分层和 AUX 通道范围。</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {saveText && <span style={{ color: saveText.includes("失败") ? "#b91c1c" : "#047857", fontSize: 13 }}>{saveText}</span>}
          <button type="button" style={buttonStyle} onClick={addPilot}>新增飞手</button>
          <button type="button" style={primaryButtonStyle} onClick={savePilotLibrary}>保存飞手档案</button>
        </div>
      </section>

      {draftPilots.map((pilot, pilotIndex) => {
        const config = cloneConfig(pilot.channelConfig);
        const rateProfile = normalizeRates(pilot);
        const open = openPilotIds.has(pilot.id);
        return (
          <section key={pilot.id} style={{ ...panelStyle, display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "46px minmax(260px,1fr) auto auto", gap: 12, alignItems: "end" }}>
              <strong style={{ height: 46, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{pilotIndex + 1}</strong>
              <label>
                <div style={{ fontSize: 13, marginBottom: 6 }}>飞手姓名</div>
                <input
                  value={pilot.name}
                  onChange={(e) => updatePilot(pilot.id, { name: e.target.value })}
                  style={{ ...inputStyle, height: 46, fontSize: 22, fontWeight: 900 }}
                />
              </label>
              <button type="button" style={buttonStyle} onClick={() => togglePilot(pilot.id)}>{open ? "收起设置" : "展开设置"}</button>
              <button type="button" style={{ ...buttonStyle, minWidth: 72, whiteSpace: "nowrap" }} onClick={() => removePilot(pilot.id)}>删除</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(420px,1.4fr) minmax(260px,.75fr)", gap: 12, overflowX: "auto" }}>
              <SkillPreview
                pilotId={pilot.id}
                refreshKey={skillRefreshByPilot[pilot.id] || 0}
                onAchievement={() => setGrowthRefreshByPilot((current) => ({ ...current, [pilot.id]: (current[pilot.id] || 0) + 1 }))}
              />
              <GrowthTimeline
                pilotId={pilot.id}
                refreshKey={growthRefreshByPilot[pilot.id] || 0}
                onDeleted={() => setSkillRefreshByPilot((current) => ({ ...current, [pilot.id]: (current[pilot.id] || 0) + 1 }))}
              />
            </div>

            <CoachEvaluationPanel pilotId={pilot.id} />

            {open && (
              <div style={{ marginTop: 12 }}>
                <RateTable profile={rateProfile} onChange={(nextProfile) => updatePilot(pilot.id, { rateProfile: nextProfile, rates: nextProfile.type })} />

                <label style={{ display: "block", marginTop: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 6 }}>备注</div>
                  <textarea value={pilot.note} onChange={(e) => updatePilot(pilot.id, { note: e.target.value })} style={textareaStyle} />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 10, marginTop: 12 }}>
                  <ChannelRanges channelKey="ch5" ranges={config.ch5} fixed onChange={(ranges) => updatePilotChannel(pilot.id, "ch5", ranges)} />
                  <ChannelRanges channelKey="ch6" ranges={config.ch6} onChange={(ranges) => updatePilotChannel(pilot.id, "ch6", ranges)} />
                  <ChannelRanges channelKey="ch7" ranges={config.ch7} onChange={(ranges) => updatePilotChannel(pilot.id, "ch7", ranges)} />
                  <ChannelRanges channelKey="ch8" ranges={config.ch8} onChange={(ranges) => updatePilotChannel(pilot.id, "ch8", ranges)} />
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
