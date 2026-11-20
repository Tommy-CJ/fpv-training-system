const byId = (id) => document.getElementById(id);
const receiverNodes = new Map();
const fpsHistory = Array(28).fill(0);
let lastRateAt = 0;
let lastFrameCount = 0;
let displayedFps = 0;
let portSignature = "";

function ageText(timestamp, now) {
  if (!timestamp) return "尚无数据";
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 1) return "刚刚";
  if (seconds < 60) return `${seconds.toFixed(1)} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function setDot(id, good) {
  byId(id).classList.toggle("good", Boolean(good));
}

function showAction(text, error = false) {
  const message = byId("action-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

function updateFps(snapshot) {
  const now = Number(snapshot.now) || Date.now();
  const framesRead = Number(snapshot.framesRead) || 0;
  if (!lastRateAt) {
    lastRateAt = now;
    lastFrameCount = framesRead;
  } else if (now - lastRateAt >= 900) {
    displayedFps = Math.max(0, Math.round((framesRead - lastFrameCount) * 1000 / (now - lastRateAt)));
    lastRateAt = now;
    lastFrameCount = framesRead;
    fpsHistory.push(displayedFps);
    fpsHistory.shift();
    byId("fps-bars").replaceChildren(...fpsHistory.map((fps) => {
      const bar = document.createElement("i");
      bar.style.height = `${Math.max(2, Math.min(16, fps * 0.5))}px`;
      return bar;
    }));
  }
  byId("input-fps").textContent = displayedFps.toLocaleString();
}

function updatePorts(snapshot) {
  const entries = snapshot.ports || [];
  const signature = JSON.stringify(entries);
  if (signature !== portSignature) {
    portSignature = signature;
    const select = byId("port-select");
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择接收阵列串口";
    select.append(placeholder);
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.path;
      option.textContent = entry.selectable ? entry.label : `${entry.label} · 无法核验设备身份`;
      option.disabled = !entry.selectable;
      select.append(option);
    }
  }
  byId("port-select").value = snapshot.selectedPortPath || "";
  byId("connect-port").disabled = !snapshot.selectedPortPath || snapshot.connectRequested;
  byId("disconnect-port").disabled = !snapshot.connectRequested && !snapshot.serialConnected;
}

function makeReceiverCard(receiverId) {
  const card = document.createElement("article");
  card.className = "receiver-card";
  const head = document.createElement("div");
  head.className = "receiver-head";
  const titleBox = document.createElement("div");
  titleBox.className = "receiver-title";
  const title = document.createElement("strong");
  const rx = document.createElement("small");
  rx.textContent = `接收机 RX ${receiverId}`;
  titleBox.append(title, rx);
  const badge = document.createElement("span");
  badge.className = "receiver-badge";
  head.append(titleBox, badge);
  card.append(head);

  const details = document.createElement("div");
  details.className = "receiver-details";
  const paired = document.createElement("span");
  const link = document.createElement("span");
  details.append(paired, link);
  card.append(details);

  const channels = [];
  for (const [index, label] of [[0, "横滚"], [1, "俯仰"], [2, "油门"], [3, "偏航"]]) {
    const row = document.createElement("div");
    row.className = index === 2 ? "channel throttle" : "channel";
    const name = document.createElement("span");
    name.textContent = label;
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    track.append(fill);
    const value = document.createElement("span");
    value.className = "value";
    row.append(name, track, value);
    card.append(row);
    channels.push({ index, fill, value });
  }

  const footer = document.createElement("div");
  footer.className = "receiver-footer";
  const lastSeen = document.createElement("span");
  const bind = document.createElement("button");
  bind.className = "button";
  bind.type = "button";
  bind.textContent = "对频";
  bind.addEventListener("click", async () => {
    bind.disabled = true;
    try {
      await window.collector.bind(receiverId);
      showAction(`接收机 RX ${receiverId} 已发送对频指令。`);
    } catch (error) {
      showAction(`接收机 RX ${receiverId} 对频失败：${error.message}`, true);
    } finally {
      bind.disabled = false;
    }
  });
  footer.append(lastSeen, bind);
  card.append(footer);
  byId("receiver-grid").append(card);
  const node = { card, title, badge, paired, link, channels, lastSeen, bind };
  receiverNodes.set(receiverId, node);
  return node;
}

function updateReceivers(snapshot) {
  const now = Number(snapshot.now) || Date.now();
  const receivers = snapshot.receivers || [];
  const seen = new Set();
  let freshCount = 0;
  for (const sample of receivers) {
    const id = Number(sample.receiverId);
    if (!Number.isInteger(id) || id < 1) continue;
    seen.add(id);
    const node = receiverNodes.get(id) || makeReceiverCard(id);
    const fresh = Boolean(snapshot.serialConnected && sample.capturedAt && now - Number(sample.capturedAt) < 2500);
    if (fresh) freshCount += 1;
    node.title.textContent = sample.pilotName || "未分配飞手";
    node.badge.textContent = fresh ? "在线" : "离线";
    node.badge.classList.toggle("fresh", fresh);
    const paired = fresh && (Number(sample.lq) > 0 || (sample.rssi != null && Number(sample.rssi) > -127));
    node.paired.textContent = !fresh ? "离线" : paired ? "已对频" : "未对频";
    node.paired.className = fresh && paired ? "paired" : "unpaired";
    node.link.textContent = `LQ ${sample.lq ?? "—"} · RSSI ${sample.rssi ?? "—"}`;
    for (const channel of node.channels) {
      const raw = sample.rawChannels?.[channel.index];
      const value = raw == null ? NaN : Number(raw);
      channel.value.textContent = Number.isFinite(value) ? String(value) : "—";
      channel.fill.style.width = `${Number.isFinite(value) ? Math.max(0, Math.min(100, (value - 172) / 1639 * 100)) : 0}%`;
    }
    node.lastSeen.textContent = `最后数据：${ageText(sample.capturedAt, now)}`;
    node.bind.disabled = !snapshot.serialConnected;
  }
  for (const [id, node] of receiverNodes) {
    if (seen.has(id)) continue;
    node.card.remove();
    receiverNodes.delete(id);
  }
  byId("receiver-count").textContent = `${freshCount} 台在线 / ${receivers.length} 台已列出`;
  byId("receiver-empty").hidden = receivers.length > 0;
}

function render(snapshot) {
  if (!snapshot) return;
  const now = Number(snapshot.now) || Date.now();
  byId("clock").textContent = new Date(now).toLocaleTimeString("zh-CN", { hour12: false });
  const receiving = Boolean(snapshot.serialConnected && now - Number(snapshot.lastSerialAt || 0) < 2500);
  const relaying = Boolean(snapshot.serverConnected && now - Number(snapshot.lastLiveSentAt || 0) < 2500);
  setDot("serial-dot", receiving);
  setDot("server-dot", snapshot.serverConnected);
  setDot("event-dot", Boolean(snapshot.eventId));
  byId("serial-state").textContent = snapshot.serialConnected ? receiving ? "正在实时接收" : "已连接，等待数据"
    : snapshot.connectRequested ? "正在连接串口" : snapshot.selectedPortPath ? "等待手动连接" : "等待选择串口";
  const activeInfo = (snapshot.ports || []).find((entry) => entry.path === snapshot.activePortPath);
  byId("active-port").textContent = activeInfo?.label || snapshot.activePortPath || "未连接";
  byId("server-state").textContent = snapshot.serverConnected ? "WebSocket 已连接" : "正在重连";
  byId("server-detail").textContent = relaying ? "正在持续上传当前帧" : `最近发送：${ageText(snapshot.lastLiveSentAt, now)}`;
  byId("event-state").textContent = snapshot.eventName || (snapshot.eventId ? snapshot.eventId : "暂无活动事件");
  byId("event-state").title = snapshot.eventName || snapshot.eventId || "";
  byId("frames-read").textContent = (Number(snapshot.framesRead) || 0).toLocaleString();
  byId("live-sent").textContent = (Number(snapshot.liveSent) || 0).toLocaleString();
  byId("cached-packets").textContent = (Number(snapshot.cachedPackets) || 0).toLocaleString();
  byId("last-frame").textContent = `最近接收：${ageText(snapshot.lastSerialAt, now)}`;
  byId("last-live").textContent = `最近上传：${ageText(snapshot.lastLiveSentAt, now)}`;
  byId("last-ack").textContent = `最近确认：${ageText(snapshot.lastAckAt, now)} · 拒收保留 ${Number(snapshot.rejectedPackets) || 0}`;
  const global = byId("global-indicator");
  global.classList.toggle("active", receiving && relaying);
  global.lastElementChild.textContent = receiving && relaying ? "实时运行中" : "等待实时链路";
  const error = byId("error-banner");
  error.hidden = !(snapshot.portSelectionError || snapshot.lastError);
  if (!error.hidden) error.textContent = snapshot.portSelectionError || snapshot.lastError;
  updateFps(snapshot);
  updatePorts(snapshot);
  updateReceivers(snapshot);
}

byId("port-select").addEventListener("change", async (event) => {
  try {
    render(await window.collector.selectPort(event.target.value));
    showAction(event.target.value ? "串口已选择，请点击连接。" : "已清除串口选择。");
  } catch (error) {
    showAction(`选择串口失败：${error.message}`, true);
  }
});

byId("connect-port").addEventListener("click", async () => {
  try {
    showAction("正在连接串口…");
    render(await window.collector.connectPort());
    showAction("已发起连接；接收机数据将在下方实时更新。");
  } catch (error) {
    showAction(`连接失败：${error.message}`, true);
  }
});

byId("disconnect-port").addEventListener("click", async () => {
  try {
    render(await window.collector.disconnectPort());
    showAction("串口已断开。再次采集需手动点击连接。");
  } catch (error) {
    showAction(`断开失败：${error.message}`, true);
  }
});

byId("open-coach").addEventListener("click", () => void window.collector.openCoach());
window.collector.onSnapshot(render);
window.collector.getSnapshot().then(render);
