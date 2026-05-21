import { useEffect, useState } from "react";
import { apiPost, buttonStyle, dangerButtonStyle, inputStyle, panelStyle, primaryButtonStyle, videoChannels } from "../trainingShared.js";

function makeParticipant(pilot, index) {
  return {
    pilotId: pilot?.id || "",
    receiverId: index + 1,
    videoBand: "L",
    videoChannel: "L1",
  };
}

function makeEvent() {
  const now = Date.now();
  return {
    id: `event-${now}`,
    name: "",
    createdAt: now,
    startedAt: null,
    endedAt: null,
    active: false,
    participants: [],
    records: [],
  };
}

const videoBandOptions = Array.from(new Set(videoChannels.all.map((channel) => channel[0])));

function getVideoNumbers(band) {
  return videoChannels.all
    .filter((channel) => channel[0] === band)
    .map((channel) => channel.slice(1));
}

function formatSerialTime(ms) {
  if (!ms) return "暂无";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return `${seconds} 秒前`;
}

function ReceiverArrayPanel({ serialState, onConnectSerial, onDisconnectSerial }) {
  const identifiedCount = serialState.connected ? serialState.maxReceiverId || 0 : 0;
  const onlineCount = serialState.connected ? serialState.receiverCount || 0 : 0;
  const infoBoxStyle = {
    ...inputStyle,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const portBoxStyle = {
    ...infoBoxStyle,
    fontSize: "clamp(11px, 2.8vw, 14px)",
    maxWidth: 220,
    justifySelf: "center",
    width: "100%",
  };
  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>接收阵列</h2>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={primaryButtonStyle} onClick={onConnectSerial} disabled={serialState.connecting || serialState.connected || !serialState.supported}>
            {serialState.connecting ? "连接中..." : "连接阵列"}
          </button>
          {serialState.connected && <button type="button" style={dangerButtonStyle} onClick={onDisconnectSerial}>断开阵列</button>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
        <div style={infoBoxStyle}>串口：{serialState.connected ? "已连接" : "未连接"}</div>
        <div style={portBoxStyle} title={serialState.portName || "未选择"}>端口：{serialState.portName || "未选择"}</div>
        <div style={infoBoxStyle}>波特率：{serialState.baudRate || 115200}</div>
        <div style={infoBoxStyle}>识别数量：{identifiedCount}</div>
        <div style={infoBoxStyle}>在线接收机：{onlineCount}</div>
        <div style={infoBoxStyle}>最后 RX：{serialState.lastReceiverId || "暂无"}</div>
        <div style={infoBoxStyle}>最后数据：{formatSerialTime(serialState.lastDataAt)}</div>
      </div>
      {(!serialState.supported || serialState.error || serialState.lastCommand || serialState.lastLine) && (
        <div style={{ marginTop: 10, color: !serialState.supported || serialState.error ? "#b91c1c" : "#64748b", fontSize: 13 }}>
          {!serialState.supported && <div>当前浏览器不支持 Web Serial，请使用 Edge/Chrome 并通过 localhost 或 HTTPS 打开页面。</div>}
          {serialState.error && <div style={{ wordBreak: "break-all" }}>{serialState.error}</div>}
          {!serialState.error && serialState.lastCommand && <div>最后指令：{serialState.lastCommand}</div>}
          {!serialState.error && serialState.lastLine && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4, fontWeight: 800 }}>最后一行串口信息：</div>
              <pre style={{ margin: 0, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#f8fafc", color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-all", overflowX: "auto", maxHeight: 180 }}>
                {serialState.lastLine}
              </pre>
            </div>
          )}
        </div>
      )}
      {/*
        <div style={{ marginTop: 10, color: !serialState.supported || serialState.error ? "#b91c1c" : "#64748b", fontSize: 13, wordBreak: "break-all" }}>
          {!serialState.supported ? "当前浏览器不支持 Web Serial，请使用 Edge/Chrome 并通过 localhost 或 HTTPS 打开页面。" : serialState.error || `最后指令：${serialState.lastCommand || "无"}；最后一行：${serialState.lastLine || "暂无"}`}
        </div>
      */}
    </section>
  );
}

function ReceiverStatus({ receivers, onBindReceiver }) {
  const [bindingId, setBindingId] = useState(null);

  async function bindReceiver(id) {
    setBindingId(id);
    try {
      await onBindReceiver(id);
    } finally {
      setBindingId(null);
    }
  }

  return (
    <section style={panelStyle}>
      <h2 style={{ margin: "0 0 12px", fontWeight: 900, textAlign: "left" }}>接收机节点状态</h2>
      {(!receivers || receivers.length === 0) && (
        <div style={{ color: "#64748b", fontSize: 13 }}>还未从串口识别到接收机。连接阵列后，STM32 输出 rx 数据会自动生成节点。</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
        {(receivers || []).map((receiver) => (
          <div key={receiver.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: receiver.online ? "#f0fdf4" : "#f8fafc" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <strong>{receiver.name || `接收机 ${receiver.id}`}</strong>
              <span style={{ color: receiver.online ? "#047857" : "#64748b", fontSize: 13 }}>{receiver.online ? "在线" : "离线"}</span>
            </div>
            <div style={{ color: !receiver.online ? "#64748b" : receiver.paired ? "#047857" : "#b45309", fontSize: 12, marginTop: 6 }}>
              {!receiver.online ? "离线" : receiver.paired ? "已对频" : "未对频"}
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
              LQ：{receiver.lq ?? "无"} RSSI：{receiver.rssi ?? "无"}
            </div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
              最后数据：{formatSerialTime(receiver.lastSeenAt)}
            </div>
            <button type="button" style={{ ...buttonStyle, marginTop: 10, width: "100%" }} onClick={() => bindReceiver(receiver.id)} disabled={bindingId === receiver.id}>
              {bindingId === receiver.id ? "发送中..." : "对频"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatPowerValue(value, digits, unit) {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : `-- ${unit}`;
}

function ReceiverPowerPanel({ power }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const voltageV = power?.voltageV;
  const currentA = power?.currentA;
  const powerW = power?.powerW;
  const ageMs = power?.updatedAt && now ? Math.max(0, now - power.updatedAt) : null;
  const stale = ageMs === null || ageMs > 3000;
  const itemStyle = {
    ...inputStyle,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    minWidth: 0,
  };
  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>接收阵列电源监测</h2>
        <span style={{ color: stale ? "#b45309" : "#047857", fontSize: 13, fontWeight: 800 }}>
          {stale ? "等待数据" : `更新于 ${Math.round(ageMs / 1000)} 秒前`}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10 }}>
        <div style={itemStyle}><span>电压</span><strong>{formatPowerValue(voltageV, 2, "V")}</strong></div>
        <div style={itemStyle}><span>电流</span><strong>{formatPowerValue(currentA, 3, "A")}</strong></div>
        <div style={itemStyle}><span>功率</span><strong>{formatPowerValue(powerW, 2, "W")}</strong></div>
      </div>
    </section>
  );
}

export default function EventPage({ pilots, events, live, serialState, serialPower, onConnectSerial, onDisconnectSerial, onSaveEvents, onBindReceiver }) {
  const activeEvent = events.find((event) => event.active);
  const [draftEvent, setDraftEvent] = useState(activeEvent || events[0] || makeEvent());
  const [busyText, setBusyText] = useState("");
  const currentEvent = draftEvent;

  function getDuplicateName(event) {
    const name = event.name.trim();
    if (!name) return "训练名称不能为空";
    return events.some((item) => item.id !== event.id && item.name.trim() === name) ? `已经存在同名训练事件：${name}` : "";
  }

  async function saveDraft(event = currentEvent) {
    const error = getDuplicateName(event);
    if (error) {
      setBusyText(error);
      return false;
    }
    const eventToSave = { ...event, createdAt: event.createdAt || Date.now() };
    const exists = events.some((item) => item.id === event.id);
    setBusyText("正在保存事件...");
    try {
      await onSaveEvents(exists ? events.map((item) => (item.id === event.id ? eventToSave : item)) : [eventToSave, ...events]);
      setDraftEvent(eventToSave);
      setBusyText(exists ? `已更新 ${event.name} 的配置` : `已新建 ${event.name}`);
      return true;
    } catch (saveError) {
      setBusyText(`事件保存失败：${saveError.message}`);
      return false;
    }
  }

  function updateParticipant(index, patch) {
    setDraftEvent({
      ...currentEvent,
      participants: currentEvent.participants.map((participant, itemIndex) => (
        itemIndex === index ? { ...participant, ...patch } : participant
      )),
    });
  }

  function selectablePilots(index) {
    const selected = new Set(currentEvent.participants.map((participant, itemIndex) => (itemIndex === index ? null : participant.pilotId)));
    return pilots.filter((pilot) => !selected.has(pilot.id));
  }

  function addParticipant() {
    const selected = new Set(currentEvent.participants.map((participant) => participant.pilotId));
    const nextPilot = pilots.find((pilot) => !selected.has(pilot.id));
    if (!nextPilot) {
      setBusyText("所有飞手都已经加入当前事件");
      return;
    }
    setDraftEvent({
      ...currentEvent,
      participants: [...currentEvent.participants, makeParticipant(null, currentEvent.participants.length)],
    });
  }

  function removeParticipant(index) {
    setDraftEvent({
      ...currentEvent,
      participants: currentEvent.participants.filter((_, itemIndex) => itemIndex !== index),
    });
  }

  function updateVideoBand(index, videoBand) {
    const firstNumber = getVideoNumbers(videoBand)[0] || "1";
    updateParticipant(index, { videoBand, videoChannel: `${videoBand}${firstNumber}` });
  }

  function updateVideoNumber(index, number) {
    const videoBand = currentEvent.participants[index]?.videoBand || currentEvent.participants[index]?.videoChannel?.[0] || "L";
    updateParticipant(index, { videoBand, videoChannel: `${videoBand}${number}` });
  }

  function createNewEvent() {
    if (events.some((event) => event.active)) {
      setBusyText("记录状态下不能新建事件，请先结束当前训练");
      return;
    }
    const nextEvent = makeEvent();
    setDraftEvent(nextEvent);
    setBusyText("已新建初始配置，请填写训练名称后保存配置");
  }

  async function startEvent() {
    const nextEvents = events.map((event) => ({ ...event, active: false }));
    const exists = events.some((event) => event.id === currentEvent.id);
    if (!exists) {
      setBusyText("请先保存配置，再开始记录");
      return;
    }
    const nextEvent = { ...currentEvent, startedAt: currentEvent.startedAt || Date.now(), endedAt: null, active: true, records: currentEvent.records || [] };
    if (getDuplicateName(nextEvent)) {
      setBusyText(getDuplicateName(nextEvent));
      return;
    }
    setBusyText("正在开始训练...");
    try {
      let savedEvent = nextEvent;
      try {
        const saved = await apiPost("/api/events/start", nextEvent);
        savedEvent = saved.event || nextEvent;
      } catch {
        // 兼容旧后端。
      }
      await onSaveEvents(nextEvents.map((event) => (event.id === nextEvent.id ? savedEvent : event)));
      setDraftEvent(savedEvent);
      setBusyText(currentEvent.startedAt ? "已继续记录，本次数据会追加到同一个事件" : "训练已开始记录");
    } catch (error) {
      setBusyText(`开始训练失败：${error.message}`);
    }
  }

  async function endEvent() {
    setBusyText("正在结束训练...");
    try {
      let savedEvent = { ...currentEvent, endedAt: Date.now(), active: false };
      try {
        const saved = await apiPost(`/api/events/${currentEvent.id}/end`, {});
        savedEvent = saved.event || savedEvent;
      } catch {
        // 兼容旧后端。
      }
      await onSaveEvents(events.map((event) => (event.id === currentEvent.id ? savedEvent : event)));
      setDraftEvent(savedEvent);
      setBusyText("训练已结束并保存");
    } catch (error) {
      setBusyText(`结束训练失败：${error.message}`);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>事件和系统</h2>
            <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>初始配置 → 保存配置 → 空闲 → 开始记录 → 记录中。</div>
            {busyText && <div style={{ color: busyText.includes("失败") || busyText.includes("存在") || busyText.includes("不能为空") ? "#b91c1c" : "#047857", fontSize: 13, marginTop: 6 }}>{busyText}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={buttonStyle} onClick={createNewEvent} disabled={events.some((event) => event.active)}>新建事件</button>
            <button type="button" style={buttonStyle} onClick={() => saveDraft()}>保存配置</button>
            {!currentEvent.active && <button type="button" style={primaryButtonStyle} onClick={startEvent}>开始记录</button>}
            {currentEvent.active && <button type="button" style={dangerButtonStyle} onClick={endEvent}>结束并保存</button>}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px,1fr) 180px", gap: 10, marginTop: 14 }}>
          <label>
            <div style={{ fontSize: 13, marginBottom: 6 }}>训练名称</div>
            <input value={currentEvent.name} onChange={(e) => setDraftEvent({ ...currentEvent, name: e.target.value })} style={{ ...inputStyle, fontSize: 14 }} />
          </label>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>状态</div>
            <div style={{ ...inputStyle, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 14, color: currentEvent.active ? "#047857" : "#64748b" }}>
              {currentEvent.active ? "记录状态" : events.some((event) => event.id === currentEvent.id) ? "事件空闲状态" : "初始配置状态"}
            </div>
          </div>
        </div>
      </section>

      <ReceiverArrayPanel
        serialState={serialState}
        onConnectSerial={onConnectSerial}
        onDisconnectSerial={onDisconnectSerial}
      />

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontWeight: 900, textAlign: "left" }}>参与飞手与图传频点</h2>
          <button type="button" style={buttonStyle} onClick={addParticipant} disabled={currentEvent.participants.filter((participant) => participant.pilotId).length >= pilots.length}>加入飞手</button>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {currentEvent.participants.map((participant, index) => (
            <div key={`${participant.pilotId}-${index}`} style={{ display: "grid", gridTemplateColumns: "44px minmax(180px,1.5fr) 120px 86px 86px auto", gap: 8, alignItems: "center" }}>
              <strong style={{ textAlign: "center" }}>{index + 1}</strong>
              <select value={participant.pilotId} onChange={(e) => updateParticipant(index, { pilotId: e.target.value })} style={inputStyle}>
                <option value="">选择飞手</option>
                {selectablePilots(index).map((pilot) => <option key={pilot.id} value={pilot.id}>{pilot.name}</option>)}
              </select>
              <select value={participant.receiverId} onChange={(e) => updateParticipant(index, { receiverId: Number(e.target.value) })} style={inputStyle}>
                {(!live.receivers || live.receivers.length === 0) && <option value={participant.receiverId}>未识别接收机</option>}
                {(live.receivers || []).map((receiver) => <option key={receiver.id} value={receiver.id}>接收机 {receiver.id}</option>)}
              </select>
              <select value={participant.videoBand || participant.videoChannel?.[0] || "L"} onChange={(e) => updateVideoBand(index, e.target.value)} style={inputStyle}>
                {videoBandOptions.map((band) => <option key={band} value={band}>{band}</option>)}
              </select>
              <select value={(participant.videoChannel || "L1").slice(1)} onChange={(e) => updateVideoNumber(index, e.target.value)} style={inputStyle}>
                {getVideoNumbers(participant.videoBand || participant.videoChannel?.[0] || "L").map((number) => <option key={number} value={number}>{number}</option>)}
              </select>
              <button type="button" style={buttonStyle} onClick={() => removeParticipant(index)}>移除</button>
            </div>
          ))}
        </div>
      </section>

      <ReceiverStatus receivers={live.receivers} onBindReceiver={onBindReceiver} />
      <ReceiverPowerPanel power={serialPower || serialState.power} />
    </div>
  );
}
