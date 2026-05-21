import { useCallback, useEffect, useRef, useState } from "react";
import { buttonStyle, defaultChannelConfig, inputStyle, panelStyle, primaryButtonStyle, textareaStyle } from "../trainingShared.js";

const axes = ["Roll", "Pitch", "Yaw"];
const betaflightFields = ["RC Rate", "Rate", "Expo"];
const actualFields = ["中央灵敏度", "最大角速度", "Expo"];
const channelFunctions = [
  ["mode", "模式"],
  ["arm", "解锁"],
  ["turtle", "反乌龟"],
  ["empty", "空"],
  ["custom", "自定义"],
];
const modeOptions = ["Angle", "Air", "Acro"];

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

export default function PilotLibraryPage({ pilots, onSave }) {
  const [draftPilots, setDraftPilots] = useState(pilots);
  const [openPilotIds, setOpenPilotIds] = useState(new Set());
  const [saveText, setSaveText] = useState("");

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
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>飞手库</h2>
          <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>姓名、Rate、备注和 AUX 通道范围。</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {saveText && <span style={{ color: saveText.includes("失败") ? "#b91c1c" : "#047857", fontSize: 13 }}>{saveText}</span>}
          <button type="button" style={buttonStyle} onClick={addPilot}>新增飞手</button>
          <button type="button" style={primaryButtonStyle} onClick={savePilotLibrary}>保存飞手库</button>
        </div>
      </section>

      {draftPilots.map((pilot, pilotIndex) => {
        const config = cloneConfig(pilot.channelConfig);
        const rateProfile = normalizeRates(pilot);
        const open = openPilotIds.has(pilot.id);
        return (
          <section key={pilot.id} style={panelStyle}>
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
