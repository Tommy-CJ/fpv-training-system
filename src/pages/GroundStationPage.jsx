import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyBetaflightPreset,
  applyBetaflightQuickSettings,
  customizeBetaflightFrame,
  extractBetaflightPresetCommands,
  readBetaflightState,
  supportsMspCli,
  triggerBetaflightConnection,
  triggerBetaflightDisconnect,
} from "../groundStation/betaflightFrameBridge.js";
import { AgentCliSession } from "../groundStation/agentCliSession.js";
import { isTrainingSerialPortClaimed } from "../serialPortClaim.js";
import {
  FLEET_COMMANDS,
  FLEET_EVENTS,
  FleetBetaflightClient,
  domainForMspName,
  initialKernelId,
  normalizeDeviceIdentity,
  normalizeKernelCatalog,
} from "../groundStation/fleet/index.js";
import "./GroundStationPage.css";

const TEAM_PASSWORD_KEY = "fpv-ground-station-team-password";
const COACH_PASSWORD_KEY = "bracketDemoCoachPassword";
const AGENT_WIDTH_KEY = "fpv-ground-station-agent-width";
const AGENT_MIN_WIDTH = 300;
const RATE_COLUMN_LABELS = Object.freeze({
  0: { rcRate: "RC Rate", expo: "RC Expo", superRate: "Super Rate" },
  1: { rcRate: "Rate", expo: "Expo", superRate: "Acro+" },
  2: { rcRate: "RC Rate", expo: "RC 曲线", superRate: "Acro+" },
  3: { rcRate: "中心灵敏度", expo: "Expo", superRate: "最大角速率" },
  4: { rcRate: "RC Rate", expo: "Expo", superRate: "最大角速率" },
});
function rateColumnLabels(ratesType) {
  return RATE_COLUMN_LABELS[Number(ratesType)] || RATE_COLUMN_LABELS[0];
}

// Pull only `set key = value` assignments from a `dump profile` /
// `dump rateprofile` output, dropping headers, comments and save/exit lines so
// they can be replayed into another profile scope.
function extractProfileSetCommands(dump) {
  const lines = [];
  for (const rawLine of String(dump || "").replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (/^set\s+[^=\s]+\s*=\s*.+$/i.test(line)) lines.push(line);
  }
  return lines;
}

const VTX_BAND_PATH = "settings.vtx.band";
const VTX_CHANNEL_PATH = "settings.vtx.channel";

// When both VTX band and channel are selected, collapse them into a single
// "图传频点" entry using the resolved letter+number label (e.g. R1) supplied by
// the backend important summary.
function mergeVtxCriticalFields(fields, important) {
  const hasBand = fields.some((field) => field.path === VTX_BAND_PATH);
  const hasChannel = fields.some((field) => field.path === VTX_CHANNEL_PATH);
  // Merge whenever either VTX field is shown and the backend resolved a
  // letter+number label (e.g. R8). We no longer require both fields to be
  // present/available so a single checked field still collapses cleanly.
  if (!hasBand && !hasChannel) return fields;
  const label = important?.vtxChannel || "";
  if (!label) return fields;
  const merged = [];
  let inserted = false;
  for (const field of fields) {
    if (field.path === VTX_BAND_PATH || field.path === VTX_CHANNEL_PATH) {
      if (!inserted) {
        merged.push({
          path: VTX_CHANNEL_PATH,
          label: "图传频点",
          available: true,
          formattedValue: important?.vtxFrequency ? `${label} · ${important.vtxFrequency} MHz` : label,
        });
        inserted = true;
      }
      continue;
    }
    merged.push(field);
  }
  return merged;
}
const DEVICE_INFO_FIELDS = Object.freeze([
  { key: "boardIdentifier", label: "飞控" },
  { key: "deviceUid", label: "设备 UID" },
  { key: "firmwareVersion", label: "固件" },
  { key: "firmwareBuildKey", label: "固件 ID" },
  { key: "kernel", label: "内核" },
  { key: "ownerName", label: "机主" },
  { key: "serialNumber", label: "序号" },
]);

function emptyAircraftForm() {
  return {
    serialNumber: "",
    ownerPilotId: "",
    ownerDisplayName: "",
    newOwnerName: "",
    model: "",
    configurationNote: "",
  };
}

function maximumAgentWidth() {
  return Math.max(AGENT_MIN_WIDTH, Math.floor(window.innerWidth / 2));
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function captureRecord(value) {
  if (value && typeof value === "object" && typeof value.content === "string") {
    return {
      content: value.content,
      contentFormat: value.contentFormat === "json" ? "json" : "betaflight_cli",
      metadata: value.metadata || {},
    };
  }
  return {
    content: String(value || ""),
    contentFormat: "betaflight_cli",
    metadata: {},
  };
}

function fieldProfileInfo(field) {
  if (field.profileType && Number.isInteger(field.profileIndex)) {
    return {
      profileType: field.profileType,
      profileIndex: field.profileIndex,
      profileLabel: field.profileLabel || `${field.profileType === "pid" ? "PID" : "Rate"} Profile ${field.profileIndex}`,
    };
  }
  const match = String(field.path || "").match(/^profiles\.(pid|rates)\[(\d+)]/);
  if (!match) return null;
  const profileType = match[1];
  const profileIndex = Number(match[2]);
  return {
    profileType,
    profileIndex,
    profileLabel: `${profileType === "pid" ? "PID" : "Rate"} Profile ${profileIndex}`,
  };
}

function normalizeAgentCliSnapshot(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && (!lines.at(-1).trim() || lines.at(-1).trim() === "#")) lines.pop();
  if (/^#?\s*diff\s+all\s*$/i.test(lines[0]?.trim() || "")) lines.shift();
  return lines.join("\n").trim();
}

function savedCredentials() {
  return {
    teamPassword: sessionStorage.getItem(TEAM_PASSWORD_KEY) || "",
    coachPassword: sessionStorage.getItem(COACH_PASSWORD_KEY) || "",
  };
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "—";
}

function debugDetail(value) {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
      if (item instanceof Window) return "[Window]";
      return item;
    });
  } catch (error) {
    return `[无法序列化：${error.message}]`;
  }
}

function useDebugStatus(initialStatus) {
  const [status, setStatusState] = useState(initialStatus);
  const [statusLogs, setStatusLogs] = useState([]);
  const appendDebugLog = useCallback((message, {
    tone = "neutral",
    event = "status",
    detail = null,
  } = {}) => {
    const next = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
      tone,
      event,
      message: String(message || event),
      detail: debugDetail(detail),
    };
    setStatusLogs((current) => {
      const last = current.at(-1);
      if (
        last
        && last.event === next.event
        && last.message === next.message
        && last.detail === next.detail
        && next.at - last.at < 800
      ) {
        return [...current.slice(0, -1), {
          ...last,
          at: next.at,
          count: (last.count || 1) + 1,
        }];
      }
      return [...current, next].slice(-200);
    });
  }, []);
  const setStatus = useCallback((next) => {
    setStatusState(next);
    appendDebugLog(next.message, { tone: next.tone });
  }, [appendDebugLog]);
  return {
    status,
    setStatus,
    statusLogs,
    setStatusLogs,
    appendDebugLog,
  };
}

function historyTitle(item) {
  if (item.ownerName && item.aircraftSerialNumber) return `${item.ownerName} · ${item.aircraftSerialNumber}`;
  return item.aircraftSerialNumber || item.boardName || "访客飞控";
}

async function readError(response) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text);
    return payload.error || payload.message || text;
  } catch {
    return text || `请求失败 (${response.status})`;
  }
}

function diffRows(diff) {
  if (!diff) return [];
  const row = (item, state, reference, current) => ({
    key: item.key,
    rawKey: item.rawKey || item.key,
    canonicalPath: item.canonicalPath || item.key,
    label: item.label || item.key.replace(/^set\s+/, ""),
    categoryLabel: item.categoryLabel || "参数",
    profileLabel: item.profileLabel || "",
    mapped: item.mapped !== false,
    reference,
    current,
    state,
  });
  return [
    ...(diff.changed || []).map((item) => row(
      item,
      "修改",
      item.beforeDisplay ?? item.before,
      item.afterDisplay ?? item.after,
    )),
    ...(diff.added || []).map((item) => row(
      item,
      "新增",
      "—",
      item.valueDisplay ?? item.value,
    )),
    ...(diff.removed || []).map((item) => row(
      item,
      "缺少",
      item.valueDisplay ?? item.value,
      "—",
    )),
  ];
}

const CONFIGURATION_DOMAIN_LABELS = Object.freeze({
  identity: "名称",
  pid: "PID",
  rates: "Rate",
  filters: "滤波",
  motor: "电机",
  receiver: "接收机",
  failsafe: "失控保护",
  vtx: "图传",
  battery: "电池",
  ports: "端口",
  modes: "模式",
  osd: "OSD",
  gps: "GPS",
  led: "LED",
  sensors: "传感器",
  blackbox: "黑匣子",
  servos: "舵机",
  features: "功能",
  advanced: "高级硬件",
  legacy: "旧版设置",
  transponder: "高级硬件",
  other: "其他",
});

function configurationDomainLabel(value) {
  return CONFIGURATION_DOMAIN_LABELS[value] || value || "其他";
}

function ConfigurationDifference({ label, comparison, emptyLabel = "无同版本记录" }) {
  if (!comparison) {
    return <div className="gs-difference-unavailable"><b>{label}</b><small>{emptyLabel}</small></div>;
  }
  const rows = diffRows(comparison.diff);
  return (
    <details className="gs-difference-detail">
      <summary>
        <b>{label}</b>
        <em data-state={comparison.differenceCount === 0}>
          {comparison.differenceCount} 项
          {comparison.diff?.summary?.unmapped ? ` · ${comparison.diff.summary.unmapped} 项未映射` : ""}
        </em>
      </summary>
      <div>
        {rows.map((row) => (
          <article key={`${row.state}-${row.key}`}>
            <strong title={`原始字段：${row.rawKey}\n统一路径：${row.canonicalPath}`}>
              <i>{row.state}</i>
              <small className="gs-param-category">
                {row.profileLabel || row.categoryLabel}
              </small>
              {row.label}
              {!row.mapped && <u>未映射</u>}
            </strong>
            <span>{row.reference} → {row.current}</span>
          </article>
        ))}
        {!rows.length && <small>完全一致</small>}
      </div>
    </details>
  );
}

const INITIAL_BF_STATE = {
  ready: false,
  connected: false,
  timestamp: null,
  deviceUid: "",
  boardIdentifier: "",
  boardName: "",
  firmwareVariant: "",
  firmwareVersion: "",
  apiVersion: "",
  buildKey: "",
  buildTime: "",
  craftName: "",
  vtxBand: "",
  vtxChannel: "",
  vtxPower: "",
};

export default function GroundStationPage({ onBack }) {
  const initialCredentials = useMemo(() => savedCredentials(), []);
  const [teamPassword, setTeamPassword] = useState(initialCredentials.teamPassword);
  const [coachPassword, setCoachPassword] = useState(initialCredentials.coachPassword);
  const [operatorLabel, setOperatorLabel] = useState("");
  const [bootstrap, setBootstrap] = useState(null);
  const [panel, setPanel] = useState("station");
  const {
    status,
    setStatus,
    statusLogs,
    setStatusLogs,
    appendDebugLog,
  } = useDebugStatus({ tone: "neutral", message: "正在载入 Betaflight…" });
  const [statusLogOpen, setStatusLogOpen] = useState(false);
  const [frameSecured, setFrameSecured] = useState(false);
  const [fleetBridgeReady, setFleetBridgeReady] = useState(false);
  const [activeKernelId, setActiveKernelId] = useState("modern");
  const [bfState, setBfState] = useState(INITIAL_BF_STATE);
  const [device, setDevice] = useState(null);
  const [aircraft, setAircraft] = useState([]);
  const [pilots, setPilots] = useState({ fleetPilots: [], trainingPilots: [] });
  const [firmwareFiles, setFirmwareFiles] = useState([]);
  const [history, setHistory] = useState([]);
  const [configurationPreview, setConfigurationPreview] = useState(null);
  const [registrationNeeded, setRegistrationNeeded] = useState(false);
  const [aircraftForm, setAircraftForm] = useState(emptyAircraftForm);
  const [editingAircraftId, setEditingAircraftId] = useState("");
  const [pilotForm, setPilotForm] = useState({ id: "", name: "" });
  const [firmwareForm, setFirmwareForm] = useState({
    file: null,
    boardIdentifier: "",
    firmwareVersion: "",
    sourceType: "local",
    buildKey: "",
    buildTime: "",
  });
  const [quickForm, setQuickForm] = useState({ craftName: "", vtxSelection: "", presetId: "", throttleLimit: "" });
  const [quickOpen, setQuickOpen] = useState(false);
  const [agentCliMode, setAgentCliMode] = useState(false);
  const [agentOperation, setAgentOperation] = useState("");
  const [agentCliCommand, setAgentCliCommand] = useState("");
  const [agentCliOutput, setAgentCliOutput] = useState("");
  const [busy, setBusy] = useState("");
  const [agentMaxWidth, setAgentMaxWidth] = useState(() => maximumAgentWidth());
  const [agentWidth, setAgentWidth] = useState(() => {
    const saved = Number(sessionStorage.getItem(AGENT_WIDTH_KEY));
    return Number.isFinite(saved)
      ? Math.min(maximumAgentWidth(), Math.max(AGENT_MIN_WIDTH, saved))
      : Math.min(390, maximumAgentWidth());
  });
  const [presetForm, setPresetForm] = useState({
    boardIdentifier: "",
    firmwareVersion: "",
    content: "",
    sourceFileName: "",
    useCaseCategory: "默认",
    variantCategory: "基准",
    versionLabel: "",
    firmwareFileId: "",
  });
  const [expandedPresetAssetsId, setExpandedPresetAssetsId] = useState("");
  const [navPage, setNavPage] = useState("primary");
  const [expandedAircraftId, setExpandedAircraftId] = useState("");
  const [expandedPilotId, setExpandedPilotId] = useState("");
  const [expandedHistoryId, setExpandedHistoryId] = useState("");
  const [displayForm, setDisplayForm] = useState({
    deviceFields: DEVICE_INFO_FIELDS.map((field) => field.key),
    criticalFields: [],
    checks: [],
    showPidTable: false,
    showRateTable: false,
    excludedDiffFields: [],
  });
  const [displayProfileFilter, setDisplayProfileFilter] = useState("");

  const iframeRef = useRef(null);
  const fleetClientRef = useRef(null);
  const kernelHandoffRef = useRef(false);
  const agentCliRef = useRef(null);
  const connectionRunRef = useRef("");
  const identifiedDeviceRef = useRef(null);
  const currentStateRef = useRef(null);
  const dirtyDomainsRef = useRef(new Set());
  const commitPersistingRef = useRef(false);
  const rebootReconnectRef = useRef({
    expected: false,
    commitAt: 0,
    generation: 0,
    running: false,
    sawDisconnect: false,
    disconnectObservedAt: 0,
    connectedEventAt: 0,
  });
  const bfStateRef = useRef(bfState);

  const role = bootstrap?.role || "guest";
  const isMember = role === "team" || role === "coach";
  const isCoach = role === "coach";
  const credentials = useMemo(() => ({ teamPassword, coachPassword }), [teamPassword, coachPassword]);
  const presets = useMemo(() => bootstrap?.presets || [], [bootstrap?.presets]);
  const kernelCatalog = useMemo(
    () => normalizeKernelCatalog(bootstrap?.betaflight),
    [bootstrap?.betaflight],
  );
  const activeKernel = kernelCatalog[activeKernelId] || kernelCatalog.modern;
  const presetDirectory = useMemo(() => {
    const targets = new Map();
    presets.forEach((preset) => {
      const targetKey = preset.boardIdentifier || "未指定 target";
      const useCaseKey = preset.useCaseCategory || "默认";
      const firmwareKey = preset.firmwareVersion || "未指定固件";
      const variantKey = preset.variantCategory || (preset.kind === "pilot" ? "个性化" : "基准");
      if (!targets.has(targetKey)) targets.set(targetKey, new Map());
      const useCases = targets.get(targetKey);
      if (!useCases.has(useCaseKey)) useCases.set(useCaseKey, new Map());
      const firmwares = useCases.get(useCaseKey);
      if (!firmwares.has(firmwareKey)) firmwares.set(firmwareKey, new Map());
      const variants = firmwares.get(firmwareKey);
      if (!variants.has(variantKey)) variants.set(variantKey, []);
      variants.get(variantKey).push(preset);
    });
    return [...targets].map(([target, useCases]) => ({
      target,
      useCases: [...useCases].map(([useCase, firmwares]) => ({
        useCase,
        firmwares: [...firmwares].map(([firmware, variants]) => ({
          firmware,
          variants: [...variants].map(([variant, versions]) => ({
            variant,
            versions: versions.sort((left, right) => right.createdAt - left.createdAt),
          })),
        })),
      })),
    }));
  }, [presets]);
  const matchingPresets = presets.filter((preset) => (
    preset.boardIdentifier === bfState.boardIdentifier
    && preset.firmwareVersion === bfState.firmwareVersion
    && (!preset.firmwareBuildKey || preset.firmwareBuildKey === bfState.buildKey)
  ));
  const applicablePresets = matchingPresets.filter((preset) => preset.hasRawCli);
  const historyGroups = useMemo(() => {
    const groups = new Map();
    history.forEach((item) => {
      const key = item.aircraftId || item.deviceUid || `${item.ownerName}:${item.aircraftSerialNumber}:${item.boardName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          title: historyTitle(item),
          boardName: item.boardName,
          firmwareVersion: item.firmwareVersion,
          records: [],
        });
      }
      groups.get(key).records.push(item);
    });
    return [...groups.values()];
  }, [history]);

  useEffect(() => {
    bfStateRef.current = bfState;
  }, [bfState]);

  useEffect(() => {
    connectionRunRef.current = "";
  }, [role]);

  useEffect(() => () => {
    void agentCliRef.current?.close();
    const client = fleetClientRef.current;
    fleetClientRef.current = null;
    if (client?.ready) void client.disconnect({ force: true }).catch(() => {}).finally(() => client.destroy());
    else client?.destroy();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const maximum = maximumAgentWidth();
      setAgentMaxWidth(maximum);
      setAgentWidth((current) => Math.min(maximum, Math.max(AGENT_MIN_WIDTH, current)));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!navigator.serial?.addEventListener) return undefined;
    const handlePhysicalDisconnect = async (event) => {
      if (await isTrainingSerialPortClaimed(event.target)) return;
      try {
        const frameState = fleetClientRef.current?.ready
          ? await fleetClientRef.current.getState()
          : null;
        if (frameState?.flashing) {
          appendDebugLog("刷写流程正在接管 USB，忽略普通断线处理", {
            event: "serial.firmware-flash-handoff",
            tone: "neutral",
          });
          return;
        }
      } catch {
        // Fall through to ordinary physical-disconnect recovery.
      }
      if (!bfStateRef.current.connected && !agentCliRef.current?.isOpen) return;
      const expectedReboot = rebootReconnectRef.current.expected;
      appendDebugLog(
        expectedReboot ? "飞控重启期间 USB 串口已重新枚举" : "浏览器检测到 USB 串口已物理拔除",
        {
          event: expectedReboot ? "serial.reboot-disconnect" : "serial.physical-disconnect",
          tone: expectedReboot ? "neutral" : "warning",
        },
      );
      bfStateRef.current = {
        ...bfStateRef.current,
        connected: false,
        phase: "IDLE",
      };
      setBfState((current) => ({ ...current, connected: false, phase: "IDLE" }));
      connectionRunRef.current = "";
      setAgentCliMode(false);
      setRegistrationNeeded(false);
      void agentCliRef.current?.close();

      const reconnect = rebootReconnectRef.current;
      if (reconnect.expected) {
        reconnect.sawDisconnect = true;
        reconnect.disconnectObservedAt = Date.now();
        reconnect.connectedEventAt = 0;
        void fleetClientRef.current?.disconnect({ force: true }).catch(() => {});
        void reconnectAfterControllerReboot();
        return;
      }
      void fleetClientRef.current?.disconnect({ force: true }).catch(() => {});
      setAgentOperation("");
      setBusy("");
      setStatus({ tone: "neutral", message: "飞控已拔出" });
    };
    navigator.serial.addEventListener("disconnect", handlePhysicalDisconnect);
    return () => navigator.serial.removeEventListener("disconnect", handlePhysicalDisconnect);
    // Reconnect reads only mutable refs; re-registering the origin-wide serial
    // listener on every render would create duplicate unplug handling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendDebugLog, setStatus]);

  const authHeaders = useCallback((extra = {}) => ({
    ...extra,
    ...(credentials.teamPassword ? { "x-team-password": credentials.teamPassword } : {}),
    ...(credentials.coachPassword ? { "x-coach-password": credentials.coachPassword } : {}),
    ...(operatorLabel ? { "x-operator-label": encodeURIComponent(operatorLabel) } : {}),
  }), [credentials, operatorLabel]);

  const api = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      headers: authHeaders(options.headers || {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  }, [authHeaders]);

  const loadBootstrap = useCallback(async () => {
    try {
      const data = await api("/api/ground-station/bootstrap");
      setBootstrap(data);
      setDisplayForm(data.displaySettings || {
        deviceFields: DEVICE_INFO_FIELDS.map((field) => field.key),
        criticalFields: [],
        checks: [],
        showPidTable: false,
        showRateTable: false,
        excludedDiffFields: [],
      });
      const catalog = normalizeKernelCatalog(data.betaflight);
      setActiveKernelId((current) => (
        catalog[current]?.available ? current : initialKernelId(catalog)
      ));
      setStatus({
        tone: data.betaflight.available ? "neutral" : "warning",
        message: data.betaflight.available ? "等待连接飞控" : "Betaflight 镜像未部署",
      });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }, [api, setStatus]);

  const loadMemberData = useCallback(async () => {
    if (!isMember) return;
    try {
      const [aircraftData, pilotData, historyData, firmwareData] = await Promise.all([
        api("/api/ground-station/aircraft"),
        api("/api/ground-station/pilots"),
        api("/api/ground-station/history"),
        api("/api/ground-station/firmware"),
      ]);
      setAircraft(aircraftData);
      setPilots(pilotData);
      setHistory(historyData);
      setFirmwareFiles(firmwareData);
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }, [api, isMember, setStatus]);

  useEffect(() => {
    queueMicrotask(loadBootstrap);
  }, [loadBootstrap]);

  useEffect(() => {
    queueMicrotask(() => {
      if (isMember) loadMemberData();
      else {
        setAircraft([]);
        setHistory([]);
        setPilots({ fleetPilots: [], trainingPilots: [] });
        setFirmwareFiles([]);
        if (panel === "fleet" || panel === "history") setPanel("station");
        setNavPage("primary");
      }
    });
  }, [isMember, loadMemberData, panel]);

  async function waitForBetaflightConnection(expected, timeoutMs = 10_000) {
    const attempts = Math.ceil(timeoutMs / 120);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const connected = fleetBridgeReady && fleetClientRef.current?.ready
          ? Boolean((await fleetClientRef.current.getState()).connected)
          : readBetaflightState(iframeRef.current).connected;
        if (connected === expected) return;
      } catch {
        // The iframe is allowed to redraw while the port is handed over.
      }
      await wait(120);
    }
    throw new Error(expected ? "BF 未能重新连接飞控" : "BF 未能在规定时间内释放飞控串口");
  }

  function cancelRebootReconnect() {
    const reconnect = rebootReconnectRef.current;
    reconnect.expected = false;
    reconnect.commitAt = 0;
    reconnect.sawDisconnect = false;
    reconnect.disconnectObservedAt = 0;
    reconnect.connectedEventAt = 0;
    reconnect.generation += 1;
  }

  function expectControllerReboot(message = "设置已保存 · 飞控即将重启") {
    const reconnect = rebootReconnectRef.current;
    reconnect.generation += 1;
    reconnect.expected = true;
    reconnect.sawDisconnect = false;
    reconnect.disconnectObservedAt = 0;
    reconnect.connectedEventAt = 0;
    reconnect.commitAt = Date.now();
    setStatus({ tone: "neutral", message });
    void reconnectAfterControllerReboot();
  }

  async function reconnectAfterControllerReboot() {
    const reconnect = rebootReconnectRef.current;
    if (reconnect.running) return;
    reconnect.running = true;
    const generation = reconnect.generation;
    let connectingAttempts = 0;
    let staleCloseRequestedAt = 0;
    let lastLoggedReconnectState = "";
    setAgentOperation("飞控正在重启 · Agent 正在重新连接串口");
    setStatus({ tone: "neutral", message: "设置已保存 · 等待飞控重启并重新连接" });
    try {
      await wait(600);
      for (let attempt = 0; attempt < 48; attempt += 1) {
        if (
          rebootReconnectRef.current.generation !== generation
          || !rebootReconnectRef.current.expected
        ) return;
        try {
          const state = fleetClientRef.current?.ready
            ? await fleetClientRef.current.getState()
            : readBetaflightState(iframeRef.current);
          const reconnectState = `${Boolean(state?.connected)}:${state?.phase || "unknown"}`;
          if (
            attempt === 0
            || reconnectState !== lastLoggedReconnectState
            || (attempt + 1) % 8 === 0
          ) {
            appendDebugLog(`重启重连检查 ${attempt + 1}/48`, {
              event: "reconnect.attempt",
              detail: {
                connected: Boolean(state?.connected),
                phase: state?.phase || "unknown",
              },
            });
            lastLoggedReconnectState = reconnectState;
          }
          if (!state?.connected) {
            rebootReconnectRef.current.sawDisconnect = true;
            if (!rebootReconnectRef.current.disconnectObservedAt) {
              rebootReconnectRef.current.disconnectObservedAt = Date.now();
            }
          }
          if (state?.connected && !rebootReconnectRef.current.sawDisconnect) {
            const now = Date.now();
            if (!staleCloseRequestedAt || now - staleCloseRequestedAt >= 1800) {
              appendDebugLog("BF 仍保留重启前的旧连接，主动关闭后重连", {
                event: "reconnect.close-stale-connection",
                detail: { attempt: attempt + 1 },
              });
              if (fleetClientRef.current?.ready) {
                await fleetClientRef.current.disconnect({ force: true });
              }
              else triggerBetaflightDisconnect(iframeRef.current);
              staleCloseRequestedAt = now;
            }
          }
          if (
            state?.connected
            && rebootReconnectRef.current.sawDisconnect
            && rebootReconnectRef.current.connectedEventAt
            && rebootReconnectRef.current.connectedEventAt
              >= rebootReconnectRef.current.disconnectObservedAt
          ) {
            rebootReconnectRef.current.expected = false;
            setAgentOperation("");
            setStatus({ tone: "success", message: "飞控已重启并重新连接" });
            return;
          }
          if (state?.phase === "CONNECTING") {
            connectingAttempts += 1;
            if (rebootReconnectRef.current.sawDisconnect && connectingAttempts >= 8) {
              appendDebugLog("BF 打开串口超时，取消后重新尝试", {
                event: "reconnect.cancel-stuck-open",
                detail: { attempt: attempt + 1 },
              });
              await fleetClientRef.current?.disconnect();
              connectingAttempts = 0;
            }
          } else {
            connectingAttempts = 0;
          }
          if (
            rebootReconnectRef.current.sawDisconnect
            && (!state?.phase || state.phase === "IDLE")
          ) {
            appendDebugLog("请求 BF 重新打开串口", {
              event: "reconnect.connect",
              detail: { attempt: attempt + 1 },
            });
            if (fleetClientRef.current?.ready) await fleetClientRef.current.connect();
            else triggerBetaflightConnection(iframeRef.current);
          }
        } catch {
          // USB re-enumeration and the BF reconnect transition are both temporary.
        }
        await wait(500);
      }
      if (rebootReconnectRef.current.generation === generation) {
        rebootReconnectRef.current.expected = false;
        setAgentOperation("");
        setStatus({ tone: "error", message: "飞控重启完成，但 BF 未能自动重新连接；请点连接重试" });
      }
    } finally {
      rebootReconnectRef.current.running = false;
    }
  }

  async function disconnectBetaflightBestEffort() {
    cancelRebootReconnect();
    if (!bfStateRef.current.connected) return;
    let disconnected = false;
    if (fleetBridgeReady && fleetClientRef.current?.ready) {
      try {
        await withTimeout(
          fleetClientRef.current.disconnect(),
          5000,
          "Agent 断开命令超时",
        );
        disconnected = true;
      } catch {
        // Fall through to the native same-origin button. This also handles a
        // controller that rebooted while the bridge command was in flight.
      }
    }
    if (!disconnected) {
      try {
        if (readBetaflightState(iframeRef.current).connected) {
          triggerBetaflightDisconnect(iframeRef.current);
        }
      } catch {
        // A rebooted controller is already disconnected from the user's view.
      }
    }
    setBfState((current) => ({ ...current, connected: false, phase: "IDLE" }));
  }

  function getAgentCli() {
    if (!agentCliRef.current) {
      agentCliRef.current = new AgentCliSession({ onOutput: appendAgentCliOutput });
    }
    return agentCliRef.current;
  }

  async function takeOverSerialForAgentCli() {
    cancelRebootReconnect();
    const state = fleetBridgeReady
      ? bfStateRef.current
      : readBetaflightState(iframeRef.current);
    const bfWasConnected = state.connected;
    if (bfWasConnected) {
      if (fleetClientRef.current?.ready) await fleetClientRef.current.disconnect();
      else triggerBetaflightDisconnect(iframeRef.current);
      await waitForBetaflightConnection(false);
    }
    try {
      await getAgentCli().open();
      return { bfWasConnected };
    } catch (error) {
      if (bfWasConnected) {
        try {
          await restoreBetaflightAfterCli();
        } catch {
          // Preserve the actual acquisition error for the user.
        }
      }
      throw error;
    }
  }

  async function returnSerialToBetaflight({ reconnect = true } = {}) {
    const cli = agentCliRef.current;
    try {
      if (cli?.isOpen) {
        try {
          await cli.write("exit\r");
          await wait(160);
        } catch {
          // Boards which reboot after a command may already have closed the port.
        }
        await cli.close();
      }
    } finally {
      if (reconnect) {
        await wait(260);
        triggerBetaflightConnection(iframeRef.current);
      }
    }
  }

  async function restoreBetaflightAfterCli() {
    await returnSerialToBetaflight({ reconnect: false });
    await wait(450);
    let lastPhase = "";
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const state = fleetClientRef.current?.ready
          ? await fleetClientRef.current.getState()
          : readBetaflightState(iframeRef.current);
        lastPhase = state?.phase || "IDLE";
        if (state?.connected) return;
        if (!state?.phase || state.phase === "IDLE") {
          if (fleetClientRef.current?.ready) await fleetClientRef.current.connect();
          else triggerBetaflightConnection(iframeRef.current);
        }
      } catch {
        // The legacy kernel can briefly rebuild its serial backend after exit.
      }
      await wait(400);
    }
    throw new Error(`BF 退出 CLI 后未能恢复调参连接${lastPhase ? `（${lastPhase}）` : ""}`);
  }

  const captureConfiguration = useCallback(async (options = {}) => {
    const {
      operationLabel = "正在通过 MSP 读取飞控配置",
      domains = [],
      showOverlay = false,
    } = options;
    if (showOverlay) setAgentOperation(operationLabel);
    try {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const client = fleetClientRef.current;
        if (client?.ready) {
          const state = await client.getState();
          if (state?.connected) break;
        }
        await wait(100);
      }
      const client = fleetClientRef.current;
      if (!client?.ready) throw new Error("Betaflight MSP Bridge 未就绪");
      const bridgeState = await client.getState();
      if (!bridgeState?.connected) throw new Error("飞控 MSP 尚未连接");
      const snapshot = await client.captureSnapshot({ domains });
      return {
        content: JSON.stringify(snapshot, null, 2),
        contentFormat: "json",
        snapshot,
        metadata: {
          source: domains.length ? "fleet_msp_domains" : "fleet_msp",
          schemaVersion: snapshot.schemaVersion,
          coverage: snapshot.coverage,
          kernel: activeKernelId,
          domains,
        },
      };
    } finally {
      if (showOverlay) setAgentOperation("");
    }
  }, [activeKernelId]);

  const loadConfigurationPreview = useCallback(async (
    content,
    state = bfStateRef.current,
    linkedAircraft = null,
    comparisonStateId,
  ) => {
    const record = captureRecord(content);
    if (!record.content.trim()) return;
    try {
      const result = await api("/api/ground-station/preset-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: record.content,
          contentFormat: record.contentFormat,
          boardIdentifier: state.boardIdentifier,
          firmwareVersion: state.firmwareVersion,
          buildKey: state.buildKey || "",
          aircraftId: linkedAircraft?.id || "",
          ownerPilotId: linkedAircraft?.ownerPilotId || "",
          ...(comparisonStateId !== undefined ? { comparisonStateId } : {}),
        }),
      });
      setConfigurationPreview(result);
      const selectedVtx = result.important?.vtxOptions?.find(
        (option) => option.label === result.important?.vtxChannel,
      );
      setQuickForm((current) => ({
        ...current,
        craftName: result.important?.craftName || current.craftName,
        vtxSelection: selectedVtx?.value || current.vtxSelection,
      }));
    } catch (error) {
      setConfigurationPreview(null);
      setStatus({ tone: "warning", message: error.message });
    }
  }, [api, setStatus]);

  const saveAircraftState = useCallback(async (
    identifiedDevice,
    state,
    captured,
    { source = "connection_scan", changedDomains = [] } = {},
  ) => {
    const record = captureRecord(captured);
    const result = await api("/api/ground-station/states", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aircraftId: identifiedDevice?.aircraft?.id || null,
        flightControllerId: identifiedDevice?.flightControllerId,
        boardIdentifier: state.boardIdentifier,
        firmwareVersion: state.firmwareVersion,
        apiVersion: state.apiVersion,
        source,
        changedDomains,
        content: record.content,
        contentFormat: record.contentFormat,
      }),
    });
    currentStateRef.current = result.state;
    if (isMember) await loadMemberData();
    return result;
  }, [api, isMember, loadMemberData]);

  const saveCliAdvancedState = useCallback(async (source = "cli_advanced_scan") => {
    const identified = identifiedDeviceRef.current;
    const state = bfStateRef.current;
    if (!identified?.flightControllerId) throw new Error("飞控身份尚未建立，无法保存 CLI 状态");
    const output = await getAgentCli().command("diff all", 90_000);
    const content = normalizeAgentCliSnapshot(output);
    if (!content) throw new Error("CLI diff all 没有返回可保存的配置");
    const result = await api("/api/ground-station/states", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aircraftId: identified.aircraft?.id || null,
        flightControllerId: identified.flightControllerId,
        boardIdentifier: state.boardIdentifier,
        firmwareVersion: state.firmwareVersion,
        apiVersion: state.apiVersion,
        source,
        changedDomains: ["advanced-cli"],
        content,
        contentFormat: "betaflight_cli",
      }),
    });
    if (isMember) await loadMemberData();
    appendDebugLog(
      result.created
        ? `CLI 高级状态已更新 · ${result.diff?.summary?.total || 0} 项变化`
        : "CLI 高级状态没有变化",
      {
        event: "cli.state",
        detail: {
          created: result.created,
          differenceCount: result.diff?.summary?.total || 0,
          source,
        },
        tone: result.created ? "success" : "neutral",
      },
    );
    return result;
    // getAgentCli returns the same ref-backed session for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, appendDebugLog, isMember, loadMemberData]);

  const scanConnectedState = useCallback(async (
    identifiedDevice,
    state,
    linkedAircraft = identifiedDevice.aircraft,
  ) => {
    setBusy("snapshot");
    setStatus({ tone: "neutral", message: "飞控已连接 · 正在后台自动扫描 MSP 配置" });
    try {
      const captured = await captureConfiguration({
        operationLabel: "正在进行连接后的完整 MSP 扫描",
        showOverlay: true,
      });
      const liveState = bfStateRef.current;
      if (
        !liveState.connected
        || liveState.deviceUid !== state.deviceUid
        || liveState.boardIdentifier !== state.boardIdentifier
        || liveState.firmwareVersion !== state.firmwareVersion
      ) {
        appendDebugLog("连接在 MSP 扫描期间发生变化，本次结果已丢弃", {
          event: "snapshot.discarded",
          detail: {
            expectedDeviceUid: state.deviceUid,
            currentDeviceUid: liveState.deviceUid,
            connected: liveState.connected,
          },
        });
        return;
      }
      const stored = await saveAircraftState(identifiedDevice, state, captured, {
        source: "connection_scan",
        changedDomains: [],
      });
      await loadConfigurationPreview(
        captured,
        state,
        linkedAircraft,
        stored.state.previousStateId || stored.state.id,
      );
      setStatus({
        tone: "success",
        message: stored.coverageEnriched
          ? "扫描完成 · 已补齐基线"
          : stored.created
          ? "扫描完成 · 已建档"
          : "扫描完成 · 无变化",
      });
    } catch (error) {
      setStatus({ tone: "error", message: `MSP 自动扫描失败：${error.message}` });
    } finally {
      setAgentOperation("");
      setBusy("");
    }
  }, [appendDebugLog, captureConfiguration, loadConfigurationPreview, saveAircraftState, setStatus]);

  const initializeConnectedController = useCallback(async (state) => {
    const connectionKey = `${state.timestamp || ""}:${state.deviceUid || ""}`;
    if (!state.deviceUid || connectionRunRef.current === connectionKey) return;
    connectionRunRef.current = connectionKey;
    setBusy("identify");
    setConfigurationPreview(null);
    setStatus({ tone: "neutral", message: "正在识别飞控…" });
    try {
      const identified = await api("/api/ground-station/controllers/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      setDevice(identified);
      identifiedDeviceRef.current = identified;
      setQuickForm({
        craftName: state.craftName,
        vtxSelection: "",
        presetId: "",
      });

      if (isMember && !identified.knownAircraft) {
        setRegistrationNeeded(true);
        setStatus({ tone: "warning", message: "新飞控 · 请先登记飞机" });
        setBusy("");
        return;
      }
      await scanConnectedState(identified, state);
    } catch (error) {
      connectionRunRef.current = "";
      setBusy("");
      setStatus({ tone: "error", message: error.message });
    }
  }, [api, isMember, scanConnectedState, setStatus]);

  const persistCommittedState = useCallback(async (payload = {}) => {
    if (commitPersistingRef.current) return;
    const identified = identifiedDeviceRef.current;
    const state = bfStateRef.current;
    if (!identified?.flightControllerId || !state.connected) return;
    commitPersistingRef.current = true;
    const domains = [...new Set([
      ...(Array.isArray(payload.domains) ? payload.domains : []),
      ...dirtyDomainsRef.current,
    ].filter(Boolean))];
    try {
      let captured;
      if (payload.snapshot && typeof payload.snapshot === "object") {
        captured = {
          content: JSON.stringify(payload.snapshot, null, 2),
          contentFormat: "json",
          snapshot: payload.snapshot,
          metadata: {
            source: "fleet_msp_commit",
            coverage: payload.snapshot.coverage,
            domains,
          },
        };
      } else if (payload.verificationError) {
        setStatus({
          tone: "warning",
          message: `设置已保存，但本次状态未补录：${payload.verificationError}；重连或刷新检查后自动补齐`,
        });
        return;
      } else {
        captured = await captureConfiguration({
          operationLabel: `正在验证已修改配置${domains.length ? ` · ${domains.join(" / ")}` : ""}`,
          domains,
        });
      }
      const stored = await saveAircraftState(identified, state, captured, {
        source: "msp_commit",
        changedDomains: domains,
      });
      await loadConfigurationPreview(
        captured,
        state,
        identified.aircraft,
        stored.state.previousStateId || stored.state.id,
      );
      setStatus({
        tone: "success",
        message: stored.coverageEnriched
          ? "设置已保存 · 已补齐此前缺失的配置基线"
          : stored.created
          ? `已记录飞机状态 · ${stored.diff?.summary?.total ?? domains.length} 项变化`
          : "保存完成 · 飞机状态没有实际变化",
      });
      dirtyDomainsRef.current.clear();
    } catch (error) {
      setStatus({ tone: "error", message: `保存后的 MSP 验证失败：${error.message}` });
    } finally {
      commitPersistingRef.current = false;
    }
  }, [captureConfiguration, loadConfigurationPreview, saveAircraftState, setStatus]);

  function handleFleetBridgeEvent(eventName, payload = {}) {
    if (eventName !== "snapshot.progress") {
      appendDebugLog(eventName, {
        event: eventName,
        detail: payload,
        tone: eventName === FLEET_EVENTS.OPERATION_ERROR ? "error" : "neutral",
      });
    }
    if (eventName === FLEET_EVENTS.BRIDGE_READY) {
      setFleetBridgeReady(true);
      setFrameSecured(true);
      setStatus({
        tone: "neutral",
        message: `${payload.kernel === "legacy" ? "Legacy 10.10" : "Modern 2026.6"} 内核已就绪`,
      });
      return;
    }

    if (eventName === FLEET_EVENTS.KERNEL_SWITCH_REQUIRED) {
      cancelRebootReconnect();
      const requiredKernel = payload.requiredKernel;
      if (!requiredKernel || !kernelCatalog[requiredKernel]?.available) {
        setStatus({ tone: "error", message: payload.reason || "没有可用的 Betaflight 兼容内核" });
        return;
      }
      if (requiredKernel !== activeKernelId) {
        if (kernelHandoffRef.current) return;
        kernelHandoffRef.current = true;
        setFleetBridgeReady(false);
        setFrameSecured(false);
        setAgentOperation("正在释放串口并切换兼容内核");
        setStatus({
          tone: "neutral",
          message: `${payload.reason || "正在切换兼容内核"}，请稍等`,
        });
        void (async () => {
          try {
            await fleetClientRef.current?.disconnect();
          } catch {
            // A version-mismatch connection may already be closing itself.
          }
          await wait(450);
          setActiveKernelId(requiredKernel);
        })();
      }
      return;
    }

    if (eventName === FLEET_EVENTS.CONNECTION_PHASE) {
      const reconnect = rebootReconnectRef.current;
      if (reconnect.expected) {
        if (payload.connected !== true) {
          reconnect.sawDisconnect = true;
          reconnect.disconnectObservedAt ||= Date.now();
          reconnect.connectedEventAt = 0;
        } else if (reconnect.sawDisconnect) {
          reconnect.connectedEventAt = Date.now();
        }
      }
      bfStateRef.current = {
        ...bfStateRef.current,
        connected: payload.connected === true,
        phase: payload.phase || "IDLE",
      };
      setBfState((current) => ({
        ...current,
        connected: payload.connected === true,
        phase: payload.phase || "IDLE",
      }));
      return;
    }

    if (eventName === FLEET_EVENTS.DEVICE_IDENTIFIED) {
      const identity = normalizeDeviceIdentity(payload, activeKernelId);
      if (
        !identity.deviceUid
        || !identity.target
        || !identity.firmwareVersion
        || identity.apiVersion === "0.0.0"
      ) {
        appendDebugLog("忽略 BF 尚未初始化完成的设备身份", {
          event: "device.identity-ignored",
          detail: identity,
        });
        return;
      }
      const completedExpectedReconnect = (
        rebootReconnectRef.current.expected
        && rebootReconnectRef.current.sawDisconnect
        && rebootReconnectRef.current.disconnectObservedAt > 0
      );
      cancelRebootReconnect();
      kernelHandoffRef.current = false;
      setAgentOperation("");
      const next = {
        ...INITIAL_BF_STATE,
        ready: true,
        connected: true,
        timestamp: identity.deviceUid,
        deviceUid: identity.deviceUid,
        boardIdentifier: identity.target,
        boardName: identity.target,
        hardwareName: identity.hardwareName,
        firmwareVariant: identity.firmwareVariant,
        firmwareVersion: identity.firmwareVersion,
        apiVersion: identity.apiVersion,
        buildKey: identity.buildKey,
        buildTime: identity.buildTime,
        craftName: identity.craftName,
        pilotName: identity.pilotName,
        kernel: identity.kernel,
      };
      bfStateRef.current = next;
      setBfState(next);
      if (completedExpectedReconnect) {
        setStatus({ tone: "success", message: "飞控已重启并重新连接" });
      }
      initializeConnectedController(next);
      return;
    }

    if (eventName === FLEET_EVENTS.CONNECTION_CLOSED) {
      bfStateRef.current = {
        ...bfStateRef.current,
        connected: false,
        phase: "IDLE",
      };
      setBfState((current) => ({ ...current, connected: false, phase: "IDLE" }));
      connectionRunRef.current = "";
      const reconnect = rebootReconnectRef.current;
      if (reconnect.expected) {
        reconnect.sawDisconnect = true;
        reconnect.disconnectObservedAt ||= Date.now();
        reconnect.connectedEventAt = 0;
        void reconnectAfterControllerReboot();
        return;
      }
      if (!agentCliRef.current?.isOpen) {
        setStatus({
          tone: "neutral",
          message: currentStateRef.current ? "飞控已断开或正在重启" : "飞控已断开",
        });
        setAgentCliMode(false);
        setRegistrationNeeded(false);
        connectionRunRef.current = "";
      }
      return;
    }

    if (eventName === FLEET_EVENTS.CONFIGURATION_WRITE) {
      dirtyDomainsRef.current.add(payload.domain || domainForMspName(payload.name));
      setStatus({
        tone: "neutral",
        message: `检测到未保存修改 · ${[...dirtyDomainsRef.current].join(" / ")}`,
      });
      return;
    }

    if (eventName === FLEET_EVENTS.CONFIGURATION_COMMIT) {
      rebootReconnectRef.current.commitAt = Number(payload.completedAt || payload.startedAt) || 0;
      void persistCommittedState(payload);
      return;
    }

    if (eventName === FLEET_EVENTS.CONTROLLER_REBOOT) {
      expectControllerReboot("设置已保存 · 飞控即将重启");
      rebootReconnectRef.current.commitAt = Number(payload.dispatchedAt || payload.startedAt) || Date.now();
      return;
    }

    if (eventName === FLEET_EVENTS.OPERATION_ERROR) {
      setStatus({ tone: "warning", message: payload.message || "Betaflight 操作异常" });
    }
  }

  function handleFrameLoad() {
    try {
      // A document reload creates a fresh BF JavaScript runtime and therefore
      // clears its in-memory MSP baseline. Treat the next identification as a
      // new connection even when the same controller UID remains connected.
      connectionRunRef.current = "";
      customizeBetaflightFrame(iframeRef.current);
      if (!fleetClientRef.current) {
        fleetClientRef.current = new FleetBetaflightClient({
          iframe: iframeRef.current,
          kernel: activeKernelId,
          onEvent: handleFleetBridgeEvent,
        });
      } else {
        fleetClientRef.current.onEvent = handleFleetBridgeEvent;
        fleetClientRef.current.bindFrame(iframeRef.current, activeKernelId);
      }
      window.setTimeout(async () => {
        try {
          const bridgeState = await fleetClientRef.current?.getState();
          if (!bridgeState) return;
          setFleetBridgeReady(true);
          if (bridgeState.connected && bridgeState.device?.deviceUid) {
            kernelHandoffRef.current = false;
            handleFleetBridgeEvent(FLEET_EVENTS.DEVICE_IDENTIFIED, bridgeState.device);
          } else if (kernelHandoffRef.current) {
            // The browser already granted this origin access to the serial port.
            // The destination kernel can therefore select the known port without
            // showing a second chooser.
            triggerBetaflightConnection(iframeRef.current);
          }
        } catch {
          // Unmodified mirrors continue through the temporary DOM compatibility bridge.
        }
      }, 250);
      setFrameSecured(true);
      setStatus({ tone: "neutral", message: "等待连接飞控" });
    } catch (error) {
      setFrameSecured(false);
      setStatus({ tone: "error", message: error.message });
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!iframeRef.current || !bootstrap?.betaflight?.available) return;
      try {
        customizeBetaflightFrame(iframeRef.current);
        if (fleetBridgeReady) return;
        const next = readBetaflightState(iframeRef.current);
        setBfState((current) => {
          if (JSON.stringify(current) === JSON.stringify(next)) return current;
          return next;
        });
        if (next.connected) initializeConnectedController(next);
        else if (bfStateRef.current.connected && !agentCliRef.current?.isOpen) {
          setStatus({
            tone: "neutral",
            message: currentStateRef.current ? "飞控已断开或正在重启" : "飞控已断开",
          });
          setAgentCliMode(false);
          setRegistrationNeeded(false);
          connectionRunRef.current = "";
        }
      } catch {
        // The iframe may still be navigating; the next poll will retry.
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [bootstrap, fleetBridgeReady, initializeConnectedController, setStatus]);

  useEffect(() => () => {
    cancelRebootReconnect();
  }, []);

  async function handleConnectionClick() {
    try {
      if (!bfState.connected) {
        triggerBetaflightConnection(iframeRef.current);
        return;
      }
      if (busy) {
        if (!window.confirm("当前正在读取 MSP 配置。确认强制断开？")) return;
        await disconnectBetaflightBestEffort();
        setAgentOperation("");
        setBusy("");
        setStatus({ tone: "warning", message: "飞控已强制断开" });
        return;
      }
      await disconnectBetaflightBestEffort();
      setStatus({ tone: "neutral", message: "飞控已断开 · 不需要结束扫描" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  function appendAgentCliOutput(content) {
    setAgentCliOutput((current) => `${current}${current ? "\n" : ""}${content}`.slice(-30_000));
  }

  async function openAgentCli() {
    setBusy("cli");
    setAgentCliOutput("");
    try {
      await takeOverSerialForAgentCli();
      setAgentCliMode(true);
      setAgentCliOutput("# CLI 已由 Agent 接管");
      setStatus({ tone: "neutral", message: "CLI 高级模式 · 正在扫描进入时状态" });
      try {
        const stored = await saveCliAdvancedState("cli_advanced_enter");
        setStatus({
          tone: stored.created ? "success" : "neutral",
          message: stored.created
            ? `CLI 高级状态已更新 · ${stored.diff?.summary?.total || 0} 项变化`
            : "CLI 高级模式 · 当前状态没有变化",
        });
      } catch (scanError) {
        appendDebugLog("CLI 进入状态扫描失败", {
          event: "cli.scan-error",
          detail: scanError.message,
          tone: "error",
        });
        setStatus({ tone: "warning", message: `CLI 已打开，但进入状态扫描失败：${scanError.message}` });
      }
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function runAgentCliCommand(event) {
    event.preventDefault();
    const command = agentCliCommand.trim();
    if (!command) return;
    setBusy("cli");
    appendAgentCliOutput(`> ${command}`);
    try {
      if (/^save$/i.test(command)) {
        await saveCliAdvancedState("cli_advanced_save");
        await getAgentCli().write(`${command}\r`);
        await wait(180);
        await returnSerialToBetaflight({ reconnect: false });
        setAgentCliCommand("");
        setAgentCliMode(false);
        expectControllerReboot("CLI 已保存 · 等待飞控重启并重新连接");
        return;
      }
      if (/^exit$/i.test(command)) {
        await saveCliAdvancedState("cli_advanced_exit");
        await restoreBetaflightAfterCli();
        setAgentCliCommand("");
        setAgentCliMode(false);
        setStatus({ tone: "neutral", message: "已退出 CLI，BF 正在恢复调参连接" });
        return;
      }
      const output = await getAgentCli().command(command);
      if (!output) appendAgentCliOutput("(无返回)");
      appendAgentCliOutput(output || "(无返回)");
      setAgentCliCommand("");
    } catch (error) {
      appendAgentCliOutput(`### ERROR ${error.message}`);
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function closeAgentCli() {
    setBusy("cli");
    let scanWarning = "";
    try {
      try {
        await saveCliAdvancedState("cli_advanced_leave");
      } catch (scanError) {
        scanWarning = scanError.message;
        appendDebugLog("CLI 退出状态扫描失败", {
          event: "cli.scan-error",
          detail: scanError.message,
          tone: "error",
        });
      }
      await restoreBetaflightAfterCli();
      setAgentCliMode(false);
      setStatus({
        tone: scanWarning ? "warning" : "neutral",
        message: scanWarning
          ? `已退出 CLI；结束状态未补录：${scanWarning}`
          : "CLI 状态已更新 · BF 正在恢复调参连接",
      });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  function startAgentResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = agentWidth;
    const onMove = (moveEvent) => {
      const nextWidth = Math.min(agentMaxWidth, Math.max(AGENT_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
      setAgentWidth(nextWidth);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      setAgentWidth((width) => {
        sessionStorage.setItem(AGENT_WIDTH_KEY, String(width));
        return width;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  }

  function resizeByKeyboard(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setAgentWidth((width) => {
      const nextWidth = event.key === "Home"
        ? AGENT_MIN_WIDTH
        : event.key === "End"
          ? agentMaxWidth
          : Math.min(agentMaxWidth, Math.max(AGENT_MIN_WIDTH, width + (event.key === "ArrowLeft" ? -20 : 20)));
      sessionStorage.setItem(AGENT_WIDTH_KEY, String(nextWidth));
      return nextWidth;
    });
  }

  async function login(kind) {
    const password = kind === "coach" ? coachPassword : teamPassword;
    if (!password.trim()) return setStatus({ tone: "error", message: "请输入密码" });
    try {
      const result = await api("/api/ground-station/auth", { method: "POST" });
      if ((kind === "coach" && result.role !== "coach") || (kind === "team" && result.role === "guest")) {
        throw new Error("密码错误");
      }
      sessionStorage.setItem(kind === "coach" ? COACH_PASSWORD_KEY : TEAM_PASSWORD_KEY, password);
      await loadBootstrap();
      setPanel("station");
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  function logout() {
    sessionStorage.removeItem(TEAM_PASSWORD_KEY);
    sessionStorage.removeItem(COACH_PASSWORD_KEY);
    setTeamPassword("");
    setCoachPassword("");
    setBootstrap((current) => current ? { ...current, role: "guest" } : current);
    setNavPage("primary");
    setPanel("station");
  }

  async function createAircraft(event) {
    event.preventDefault();
    if (!device?.flightControllerId) return;
    setBusy("register");
    try {
      const created = await api("/api/ground-station/aircraft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...aircraftForm, flightControllerId: device.flightControllerId }),
      });
      const identified = { ...device, knownAircraft: true, aircraft: created };
      setDevice(identified);
      identifiedDeviceRef.current = identified;
      setRegistrationNeeded(false);
      setAircraftForm(emptyAircraftForm());
      await loadMemberData();
      await scanConnectedState(identified, bfStateRef.current, created);
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function saveAircraft(event) {
    event.preventDefault();
    setBusy("aircraft");
    try {
      const endpoint = editingAircraftId ? `/api/ground-station/aircraft/${editingAircraftId}` : "/api/ground-station/aircraft";
      await api(endpoint, {
        method: editingAircraftId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(aircraftForm),
      });
      setEditingAircraftId("");
      setAircraftForm(emptyAircraftForm());
      await loadMemberData();
      setStatus({ tone: "success", message: "飞机资料已更新" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  function editAircraft(item) {
    setEditingAircraftId(item.id);
    setAircraftForm({
      serialNumber: item.serialNumber || "",
      ownerPilotId: item.ownerPilotId || "",
      ownerDisplayName: item.ownerName || "",
      newOwnerName: "",
      model: item.model || "",
      configurationNote: item.configurationNote || "",
    });
  }

  function updateAircraftOwner(value) {
    const normalizedName = value.trim();
    const existingPilot = pilots.fleetPilots.find((pilot) => pilot.name.trim() === normalizedName);
    setAircraftForm((current) => ({
      ...current,
      ownerDisplayName: value,
      ownerPilotId: existingPilot?.id || "",
      newOwnerName: existingPilot ? "" : value,
    }));
  }

  async function deleteAircraft(item) {
    if (!window.confirm(`永久删除飞机“${item.serialNumber}”及其全部调参历史？此操作不可恢复。`)) return;
    setBusy("aircraft");
    try {
      await api(`/api/ground-station/aircraft/${item.id}`, { method: "DELETE" });
      await loadMemberData();
      setExpandedAircraftId("");
      setStatus({ tone: "success", message: "飞机及关联历史已从数据库删除" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function savePilot(event) {
    event.preventDefault();
    setBusy("pilot");
    try {
      const url = pilotForm.id ? `/api/ground-station/pilots/${pilotForm.id}` : "/api/ground-station/pilots";
      await api(url, {
        method: pilotForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pilotForm.name }),
      });
      setPilotForm({ id: "", name: "" });
      await loadMemberData();
      setStatus({ tone: "success", message: "飞手库已更新" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function deletePilot(item) {
    if (!window.confirm(`永久删除飞手“${item.name}”、名下飞机及全部调参历史？此操作不可恢复。`)) return;
    setBusy("pilot");
    try {
      await api(`/api/ground-station/pilots/${item.id}`, { method: "DELETE" });
      await loadMemberData();
      setExpandedPilotId("");
      setStatus({ tone: "success", message: "飞手及关联数据已从数据库删除" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function deleteHistory(item) {
    if (!window.confirm("永久删除这个飞机状态版本？此操作不可恢复。")) return;
    setBusy("history");
    try {
      await api(`/api/ground-station/history/${item.id}`, { method: "DELETE" });
      setExpandedHistoryId("");
      await loadMemberData();
      setStatus({ tone: "success", message: "飞机状态版本已从数据库删除" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function applyQuickSettings(settings, successLabel) {
    if (!window.confirm(`${successLabel}并保存到飞控。确认继续？`)) return;
    setBusy("quick");
    try {
      let commands;
      if (fleetBridgeReady && fleetClientRef.current?.ready) {
        commands = [];
        if (settings.craftName?.trim()) {
          await fleetClientRef.current.request(FLEET_COMMANDS.SETTING_SET_CRAFT_NAME, {
            craftName: settings.craftName.trim(),
          });
          commands.push("craftName");
        }
        if (settings.vtxBand && settings.vtxChannel) {
          await fleetClientRef.current.request(FLEET_COMMANDS.SETTING_SET_VTX_CHANNEL, {
            band: Number(settings.vtxBand),
            channel: Number(settings.vtxChannel),
          });
          commands.push("vtxChannel");
        }
        if (!commands.length) throw new Error("没有可写入的快捷设置");
        await fleetClientRef.current.request(FLEET_COMMANDS.CONFIGURATION_COMMIT);
      } else {
        commands = await applyBetaflightQuickSettings(iframeRef.current, settings);
      }
      setStatus({
        tone: "success",
        message: fleetBridgeReady
          ? `${successLabel}完成 · 已写入并保存 ${commands.length} 项`
          : `${successLabel}完成 · 已写入 ${commands.length} 项 · 飞控重启中`,
      });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function applyQuickVtx() {
    const [band, channel] = quickForm.vtxSelection.split(":");
    if (!band || !channel) return setStatus({ tone: "error", message: "请选择图传频点" });
    await applyQuickSettings({ vtxBand: band, vtxChannel: channel }, "修改图传频点");
  }

  // Discover how many rate/pid profiles the connected controller exposes so the
  // batch CLI writes cover exactly the profiles that exist (not a hard-coded 4).
  function connectedProfileIndexes(kind) {
    const tables = configurationPreview?.configuredDisplay?.tables;
    const list = kind === "pid" ? tables?.pidProfiles : tables?.rateProfiles;
    const indexes = (list || [])
      .map((profile) => Number(profile.index))
      .filter((value) => Number.isInteger(value));
    return indexes.length ? [...new Set(indexes)].sort((a, b) => a - b) : [0, 1, 2, 3];
  }

  // Run a batch of CLI commands through the same serial-takeover flow used by
  // preset writes, so throttle-limit / profile-sync work on every kernel.
  async function runQuickCliBatch(commands, { operation, successLabel }) {
    if (!commands.length) throw new Error("没有可写入的命令");
    let takenOver = false;
    setAgentOperation(operation);
    try {
      await takeOverSerialForAgentCli();
      takenOver = true;
      const cli = getAgentCli();
      const output = await cli.executeCommandsFast(commands, {
        timeoutMs: 90_000,
        onProgress: (completed, total, command) => {
          if (completed === 1 || completed % 10 === 0 || completed === total) {
            setAgentOperation(`CLI 正在写入 ${completed}/${total} · ${command.slice(0, 40)}`);
          }
        },
      });
      if (/###\s*ERROR|unknown command|invalid (?:name|value)|parse error/i.test(String(output || ""))) {
        throw new Error(`CLI 拒绝命令\n${String(output).slice(-400)}`);
      }
      await cli.write("save\r");
      await wait(180);
      await returnSerialToBetaflight({ reconnect: false });
      setStatus({ tone: "success", message: `${successLabel} · 已写入 ${commands.length} 条并保存重启` });
    } catch (error) {
      if (takenOver) {
        try {
          await restoreBetaflightAfterCli();
        } catch {
          // Preserve the write failure instead of the reconnect detail.
        }
      }
      throw error;
    } finally {
      setAgentOperation("");
    }
  }

  async function applyQuickThrottleLimit() {
    const percent = Number(quickForm.throttleLimit);
    if (!Number.isInteger(percent) || percent < 25 || percent > 100) {
      return setStatus({ tone: "error", message: "油门限制需为 25～100 的整数百分比" });
    }
    if (!bfState.connected) return setStatus({ tone: "error", message: "请先连接飞控" });
    if (!window.confirm(`将所有 Rate Profile 的油门限制设为 SCALE ${percent}% 并保存重启飞控？`)) return;
    setBusy("quick-throttle");
    try {
      if (fleetBridgeReady && fleetClientRef.current?.ready) {
        // Prefer MSP: CLI throttle_limit commands vary per firmware and the
        // "rateprofile N" command rejects indexes the board doesn't expose,
        // whereas MSP_SET_RC_TUNING is stable across firmware versions and the
        // bridge sweeps only the rate profiles the firmware reports.
        const result = await fleetClientRef.current.request(
          FLEET_COMMANDS.SETTING_SET_THROTTLE_LIMIT,
          { percent, type: 1 },
        );
        await fleetClientRef.current.request(FLEET_COMMANDS.CONFIGURATION_COMMIT);
        const count = Array.isArray(result?.rateProfiles) ? result.rateProfiles.length : 0;
        setStatus({
          tone: "success",
          message: `油门限制 SCALE ${percent}% · 已通过 MSP 写入 ${count} 个 Rate Profile 并保存`,
        });
      } else {
        const commands = [];
        for (const index of connectedProfileIndexes("rate")) {
          commands.push(`rateprofile ${index}`);
          commands.push("set throttle_limit_type = SCALE");
          commands.push(`set throttle_limit_percent = ${percent}`);
        }
        await runQuickCliBatch(commands, {
          operation: "Agent 正在写入各 Profile 油门限制，请勿拔出 USB",
          successLabel: `油门限制 SCALE ${percent}%`,
        });
      }
      await refreshConfigurationPreview();
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function syncProfilesToFirst() {
    if (!bfState.connected) return setStatus({ tone: "error", message: "请先连接飞控" });
    if (!window.confirm("将 Profile 1 的 PID / Rate 参数复制到其他所有 Profile 并保存重启？此操作会覆盖其他 Profile。")) return;
    setBusy("quick-sync");
    try {
      const cli = getAgentCli();
      let takenOver = false;
      setAgentOperation("Agent 正在读取 Profile 1 参数，请勿拔出 USB");
      try {
        await takeOverSerialForAgentCli();
        takenOver = true;
        await cli.command("profile 0", 15_000);
        const pidDump = await cli.command("dump profile", 60_000);
        const rateDump = await cli.command("dump rateprofile", 60_000);
        const pidLines = extractProfileSetCommands(pidDump);
        const rateLines = extractProfileSetCommands(rateDump);
        if (!pidLines.length && !rateLines.length) {
          throw new Error("未能从 Profile 1 读取到可复制的参数");
        }
        const pidTargets = connectedProfileIndexes("pid").filter((index) => index !== 0);
        const rateTargets = connectedProfileIndexes("rate").filter((index) => index !== 0);
        const commands = [];
        for (const index of pidTargets) {
          commands.push(`profile ${index}`);
          commands.push(...pidLines);
        }
        for (const index of rateTargets) {
          commands.push(`rateprofile ${index}`);
          commands.push(...rateLines);
        }
        setAgentOperation("Agent 正在把 Profile 1 参数同步到其他 Profile");
        const output = await cli.executeCommandsFast(commands, {
          timeoutMs: 120_000,
          onProgress: (completed, total, command) => {
            if (completed === 1 || completed % 15 === 0 || completed === total) {
              setAgentOperation(`CLI 同步 ${completed}/${total} · ${command.slice(0, 40)}`);
            }
          },
        });
        if (/###\s*ERROR|unknown command|invalid (?:name|value)|parse error/i.test(String(output || ""))) {
          throw new Error(`CLI 拒绝命令\n${String(output).slice(-400)}`);
        }
        await cli.write("save\r");
        await wait(180);
        await returnSerialToBetaflight({ reconnect: false });
        setStatus({ tone: "success", message: `已将 Profile 1 同步到其他 ${pidTargets.length} 个 Profile` });
      } catch (error) {
        if (takenOver) {
          try {
            await restoreBetaflightAfterCli();
          } catch {
            // Preserve the sync failure.
          }
        }
        throw error;
      } finally {
        setAgentOperation("");
      }
      await refreshConfigurationPreview();
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function applyPresetWithNativeCli(content) {
    const commands = extractBetaflightPresetCommands(content);
    if (!commands.length) throw new Error("这个预设没有可写入的 Betaflight 配置");
    let takenOver = false;
    setAgentOperation("Agent 正在通过 CLI 写入低版本飞控预设，请勿拔出 USB");
    try {
      await takeOverSerialForAgentCli();
      takenOver = true;
      const cli = getAgentCli();
      const assertCliAccepted = (output, command) => {
        if (/###\s*ERROR|unknown command|invalid (?:name|value)|parse error/i.test(String(output || ""))) {
          throw new Error(`CLI 拒绝命令：${command}\n${String(output).slice(-500)}`);
        }
      };
      const writeOutput = await cli.executeCommandsFast(
        commands,
        {
          timeoutMs: 90_000,
          onProgress: (completed, total, command) => {
            if (completed === 1 || completed % 20 === 0 || completed === total) {
              setAgentOperation(`CLI 正在写入 ${completed}/${total} · ${command.slice(0, 42)}`);
            }
          },
        },
      );
      assertCliAccepted(writeOutput, "批量预设");
      appendDebugLog("CLI 预设批量写入完成", {
        event: "cli.preset-written",
        detail: {
          commandCount: commands.length,
          responseBytes: writeOutput.length,
        },
        tone: "success",
      });
      await cli.write("save\r");
      await wait(180);
      await returnSerialToBetaflight({ reconnect: false });
      return commands.length;
    } catch (error) {
      if (takenOver) {
        try {
          await restoreBetaflightAfterCli();
        } catch {
          // Preserve the write failure instead of replacing it with reconnect detail.
        }
      }
      throw error;
    } finally {
      setAgentOperation("");
    }
  }

  async function applyQuickPreset() {
    const preset = applicablePresets.find((item) => item.id === quickForm.presetId);
    if (!preset) return setStatus({ tone: "error", message: "请选择当前 target / 固件可用的预设" });
    if (!window.confirm(`套用“${preset.versionLabel || preset.name}”并保存重启飞控？`)) return;
    if (!bfState.connected) {
      setStatus({ tone: "error", message: "请先连接飞控后再套用预设" });
      return;
    }
    setBusy("quick-preset");
    try {
      const fullPreset = await api(`/api/ground-station/presets/${preset.id}`);
      if (
        fullPreset.boardIdentifier !== bfState.boardIdentifier
        || fullPreset.firmwareVersion !== bfState.firmwareVersion
        || (fullPreset.firmwareBuildKey && fullPreset.firmwareBuildKey !== bfState.buildKey)
      ) {
        throw new Error("预设与当前飞控 target、固件版本或 Build Key 不一致");
      }
      if (!fullPreset.rawCliText?.trim()) throw new Error("这个预设尚未上传 CLI 配置，不能完整套用");
      const commandCount = supportsMspCli(bfState.firmwareVersion)
        ? await applyBetaflightPreset(iframeRef.current, fullPreset.rawCliText)
        : await applyPresetWithNativeCli(fullPreset.rawCliText);
      expectControllerReboot(`预设已写入 ${commandCount} 条配置 · 等待飞控重启`);
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function refreshConfigurationPreview() {
    setBusy("preview");
    try {
      const content = await captureConfiguration({
        operationLabel: "正在重新进行完整 MSP 扫描",
      });
      const identified = identifiedDeviceRef.current;
      if (!identified?.flightControllerId) throw new Error("飞控身份尚未建立");
      const stored = await saveAircraftState(identified, bfStateRef.current, content, {
        source: "manual_refresh",
        changedDomains: [],
      });
      await loadConfigurationPreview(
        content,
        bfStateRef.current,
        identified.aircraft,
        stored.state.previousStateId || stored.state.id,
      );
      setStatus({
        tone: "success",
        message: stored.created ? "MSP 状态已刷新并生成新版本" : "MSP 状态已刷新 · 没有变化",
      });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function createPreset(event) {
    event.preventDefault();
    if (!presetForm.content.trim()) return setStatus({ tone: "error", message: "请选择配置 TXT 文件" });
    try {
      await api("/api/ground-station/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: presetForm.versionLabel,
          kind: "team_baseline",
          boardIdentifier: presetForm.boardIdentifier,
          firmwareVersion: presetForm.firmwareVersion,
          content: presetForm.content,
          contentFormat: "betaflight_cli",
          useCaseCategory: presetForm.useCaseCategory,
          variantCategory: presetForm.variantCategory,
          versionLabel: presetForm.versionLabel,
          firmwareFileId: presetForm.firmwareFileId,
        }),
      });
      setPresetForm({
        boardIdentifier: bfState.boardIdentifier,
        firmwareVersion: bfState.firmwareVersion,
        content: "",
        sourceFileName: "",
        useCaseCategory: "默认",
        variantCategory: "基准",
        versionLabel: "",
        firmwareFileId: "",
      });
      await loadBootstrap();
      setStatus({ tone: "success", message: "预设新版本已发布" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function readPresetTextFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("TXT 配置不能超过 2MB");
      const content = await file.text();
      if (!content.trim()) throw new Error("TXT 配置为空");
      setPresetForm((current) => ({ ...current, content, sourceFileName: file.name }));
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function downloadPreset(item) {
    try {
      const response = await fetch(`/api/ground-station/presets/${item.id}/download`, { headers: authHeaders() });
      if (!response.ok) throw new Error(await readError(response));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${item.boardIdentifier}_${item.firmwareVersion}_${item.versionLabel || item.createdAt}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function attachCliToPreset(item, event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("TXT 配置不能超过 2MB");
      const rawCliText = await file.text();
      if (!rawCliText.trim()) throw new Error("TXT 配置为空");
      await api(`/api/ground-station/presets/${item.id}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawCliText }),
      });
      await loadBootstrap();
      setStatus({ tone: "success", message: `已补充 ${item.name} 的 CLI 基线` });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function calibratePresetWithCurrentMsp(item) {
    if (
      item.boardIdentifier !== bfState.boardIdentifier
      || item.firmwareVersion !== bfState.firmwareVersion
      || (item.firmwareBuildKey && item.firmwareBuildKey !== bfState.buildKey)
    ) {
      return setStatus({ tone: "error", message: "当前飞机与该预设 target、固件版本或 Build Key 不一致" });
    }
    setBusy("preset-calibration");
    try {
      const captured = await captureConfiguration({
        operationLabel: `正在为 ${item.name} 补充 MSP 基线`,
        showOverlay: true,
      });
      const record = captureRecord(captured);
      let snapshotDevice = {};
      try {
        snapshotDevice = JSON.parse(record.content)?.device || {};
      } catch {
        snapshotDevice = {};
      }
      const firmwareAsset = await api("/api/ground-station/firmware/metadata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardIdentifier: bfState.boardIdentifier,
          firmwareVersion: bfState.firmwareVersion,
          buildKey: snapshotDevice.buildKey || bfState.buildKey || "",
          buildTime: snapshotDevice.buildTime || bfState.buildTime || "",
        }),
      });
      const updated = await api(`/api/ground-station/presets/${item.id}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonicalSnapshot: record.content,
          firmwareFileId: firmwareAsset.id,
        }),
      });
      await loadBootstrap();
      await loadConfigurationPreview(record, bfStateRef.current, device?.aircraft);
      setStatus({
        tone: updated.consistency?.status === "different" ? "warning" : "success",
        message: updated.consistency?.status === "different"
          ? `MSP 与固件身份已更新，但与 CLI 有 ${updated.consistency.different?.length || 0} 项可解析差异`
          : "MSP 与固件身份已更新 · CLI/MSP 可解析项目检查通过",
      });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function attachFirmwareToPreset(item, firmwareFileId) {
    try {
      await api(`/api/ground-station/presets/${item.id}/assets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firmwareFileId }),
      });
      await loadBootstrap();
      setStatus({ tone: "success", message: "预设固件层已更新" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function deletePreset(item) {
    if (!window.confirm(`删除预设“${item.name}”？`)) return;
    try {
      await api(`/api/ground-station/presets/${item.id}`, { method: "DELETE" });
      await loadBootstrap();
      setStatus({ tone: "success", message: "预设已删除" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function uploadFirmware(event) {
    event.preventDefault();
    const file = firmwareForm.file;
    if (!file) return setStatus({ tone: "error", message: "请选择 .hex 固件文件" });
    setBusy("firmware");
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("无法读取固件文件"));
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.readAsDataURL(file);
      });
      await api("/api/ground-station/firmware", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          contentBase64: base64,
          boardIdentifier: firmwareForm.boardIdentifier,
          firmwareVersion: firmwareForm.firmwareVersion,
          sourceType: firmwareForm.sourceType,
          buildKey: firmwareForm.buildKey,
          buildTime: firmwareForm.buildTime ? new Date(firmwareForm.buildTime).getTime() : Date.now(),
        }),
      });
      setFirmwareForm({
        file: null,
        boardIdentifier: "",
        firmwareVersion: "",
        sourceType: "local",
        buildKey: "",
        buildTime: "",
      });
      await loadMemberData();
      setStatus({ tone: "success", message: "HEX 固件已上传" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    } finally {
      setBusy("");
    }
  }

  async function downloadFirmware(item) {
    try {
      const response = await fetch(`/api/ground-station/firmware/${item.id}/download`, { headers: authHeaders() });
      if (!response.ok) throw new Error(await readError(response));
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  async function deleteFirmware(item) {
    if (!window.confirm(`删除固件“${item.fileName}”？`)) return;
    try {
      await api(`/api/ground-station/firmware/${item.id}`, { method: "DELETE" });
      await loadMemberData();
      setStatus({ tone: "success", message: "固件已删除" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  function toggleDisplayField(section, value, checked) {
    setDisplayForm((current) => ({
      ...current,
      [section]: checked
        ? [...new Set([...(current[section] || []), value])]
        : (current[section] || []).filter((item) => item !== value),
    }));
  }

  function updateDisplayCheck(id, patch) {
    setDisplayForm((current) => ({
      ...current,
      checks: current.checks.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  }

  function addDisplayCheck() {
    setDisplayForm((current) => ({
      ...current,
      checks: [
        ...current.checks,
        {
          id: `check-${Date.now().toString(36)}`,
          label: "",
          path: "",
          operator: "eq",
          value: "",
        },
      ],
    }));
  }

  async function saveDisplaySettings(event) {
    event.preventDefault();
    try {
      setStatus({ tone: "neutral", message: "正在保存显示设置…" });
      const saved = await api("/api/ground-station/settings/display", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(displayForm),
      });
      setDisplayForm(saved);
      await loadBootstrap();
      setStatus({ tone: "success", message: "Agent 显示与检查规则已保存" });
    } catch (error) {
      setStatus({ tone: "error", message: error.message });
    }
  }

  const mirrorAvailable = Boolean(activeKernel?.available);
  const availableConfigurationFields = useMemo(() => {
    const fields = configurationPreview?.configuredDisplay?.availableFields || [];
    const byPath = new Map(fields.map((field) => [field.path, field]));
    [
      ...displayForm.criticalFields,
      ...displayForm.checks.map((check) => check.path),
    ].filter(Boolean).forEach((path) => {
      if (!byPath.has(path)) byPath.set(path, {
        path,
        label: path,
        category: "已保存",
        value: null,
      });
    });
    return [...byPath.values()];
  }, [configurationPreview, displayForm]);
  const configurationFieldGroups = useMemo(() => {
    const groups = new Map();
    availableConfigurationFields.forEach((field) => {
      if (fieldProfileInfo(field)) return;
      const category = field.category || "其他";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(field);
    });
    return [...groups].map(([category, fields]) => ({
      category,
      fields: fields.sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    }));
  }, [availableConfigurationFields]);
  const profileConfigurationFieldGroups = useMemo(() => {
    const groups = [];
    const add = (profileType, profileIndex, label) => {
      const id = `${profileType}:${profileIndex}`;
      const fields = availableConfigurationFields.filter((field) => {
        const info = fieldProfileInfo(field);
        return info && info.profileType === profileType && info.profileIndex === profileIndex;
      }).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
      groups.push({ id, label, profileType, profileIndex, fields });
    };
    const tables = configurationPreview?.configuredDisplay?.tables;
    (tables?.pidProfiles || []).forEach((profile) => add("pid", profile.index, `PID Profile ${profile.index}`));
    (tables?.rateProfiles || []).forEach((profile) => add("rates", profile.index, `Rate Profile ${profile.index}`));
    return groups.filter((group) => group.fields.length > 0);
  }, [availableConfigurationFields, configurationPreview]);
  const selectedProfileConfigurationGroup = useMemo(() => (
    profileConfigurationFieldGroups.find((group) => group.id === displayProfileFilter)
    || profileConfigurationFieldGroups[0]
    || null
  ), [displayProfileFilter, profileConfigurationFieldGroups]);

  async function copyStatusLogs() {
    const content = statusLogs.map((entry) => (
      `${new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}`
      + ` [${entry.tone}] [${entry.event}] ${entry.message}`
      + `${entry.count > 1 ? ` ×${entry.count}` : ""}`
      + `${entry.detail ? `\n${entry.detail}` : ""}`
    )).join("\n");
    await navigator.clipboard.writeText(content);
  }

  return (
    <div className="gs-shell" style={{ "--agent-width": `${agentWidth}px` }}>
      <datalist id="ground-station-owner-options">
        {pilots.fleetPilots.map((pilot) => <option key={pilot.id} value={pilot.name} />)}
      </datalist>
      <aside className="gs-agent">
        <header className="gs-agent-header">
          <button type="button" className="gs-icon-button" onClick={onBack} title="返回训练系统">←</button>
          <div>
            <strong>FLEET AGENT</strong>
            <span>{role === "coach" ? "教练" : role === "team" ? "队员" : "访客"}</span>
          </div>
          <button type="button" className="gs-role-button" onClick={() => setPanel(panel === "auth" ? "station" : "auth")}>
            {role === "guest" ? "登录" : "权限"}
          </button>
        </header>

        <nav className="gs-agent-nav" aria-label="地面站功能">
          {navPage === "primary" ? <>
            <button type="button" className={panel === "station" ? "active" : ""} onClick={() => setPanel("station")}>调参</button>
            {isMember && <button type="button" className={panel === "fleet" ? "active" : ""} onClick={() => setPanel("fleet")}>机库</button>}
            <button type="button" className={panel === "presets" ? "active" : ""} onClick={() => setPanel("presets")}>预设</button>
            {isMember && <button type="button" className="gs-nav-page" aria-label="下一页" onClick={() => { setNavPage("history"); setPanel("history"); }}>›</button>}
          </> : <>
            <button type="button" className="gs-nav-page" aria-label="上一页" onClick={() => { setNavPage("primary"); setPanel("station"); }}>‹</button>
            <button type="button" className={panel === "history" ? "active" : ""} onClick={() => setPanel("history")}>历史</button>
            <button type="button" className={panel === "settings" ? "active" : ""} onClick={() => setPanel("settings")}>设置</button>
          </>}
        </nav>

        <div className="gs-agent-scroll">
        <div className="gs-status-stack">
          <button
            type="button"
            className={`gs-agent-status gs-status-${status.tone}`}
            aria-expanded={statusLogOpen}
            onClick={() => setStatusLogOpen((open) => !open)}
          >
            <i />
            <span>{busy ? "处理中 · " : ""}{status.message}</span>
            <b>{statusLogOpen ? "收起" : `日志 ${statusLogs.length}`}</b>
          </button>
          {statusLogOpen && (
            <section className="gs-status-log">
              <header>
                <strong>Agent 调试日志</strong>
                <span>
                  <button type="button" onClick={copyStatusLogs}>复制</button>
                  <button type="button" onClick={() => setStatusLogs([])}>清空</button>
                </span>
              </header>
              <div>
                {[...statusLogs].reverse().map((entry) => (
                  <article key={entry.id} data-tone={entry.tone}>
                    <time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
                    <strong>{entry.event}</strong>
                    <span>{entry.message}{entry.count > 1 ? ` ×${entry.count}` : ""}</span>
                    {entry.detail && <code>{entry.detail}</code>}
                  </article>
                ))}
                {!statusLogs.length && <small>暂无日志</small>}
              </div>
            </section>
          )}
        </div>

        {panel === "station" && (
          <div className="gs-agent-body">
            <section className="gs-connect-section">
              <button
                type="button"
                className={`gs-connect-button ${bfState.connected ? "connected" : ""}`}
                disabled={!mirrorAvailable || !frameSecured || (!bfState.connected && Boolean(busy))}
                onClick={handleConnectionClick}
              >
                <span className="gs-connect-dot" />
                <span>{bfState.connected ? (busy ? "强制断开" : "断开飞控") : "连接飞控"}</span>
                <small>{bfState.connected ? bfState.boardIdentifier : "Chrome / Edge · USB"}</small>
              </button>

              {bfState.connected && (
                <dl className="gs-device-strip">
                  {DEVICE_INFO_FIELDS.filter((field) => (
                    (displayForm.deviceFields || []).includes(field.key)
                  )).map((field) => {
                    const values = {
                      boardIdentifier: bfState.boardIdentifier || "—",
                      deviceUid: bfState.deviceUid || "—",
                      firmwareVersion: bfState.firmwareVersion || "—",
                      firmwareBuildKey: bfState.buildKey || bfState.firmwareBuildKey || "—",
                      kernel: (bfState.kernel || activeKernelId) === "legacy" ? "Legacy 10.10" : "Modern 2026.6",
                      ownerName: device?.aircraft?.ownerName || "未指定",
                      serialNumber: device?.aircraft?.serialNumber || (registrationNeeded ? "未登记" : "访客设备"),
                    };
                    return <div key={field.key}><dt>{field.label}</dt><dd>{values[field.key]}</dd></div>;
                  })}
                </dl>
              )}
            </section>

            {agentCliMode ? (
              <section className="gs-agent-cli">
                <div className="gs-section-heading">
                  <div><strong>Agent CLI</strong><span>原生 BF CLI 由 Agent 转发</span></div>
                  <button type="button" onClick={closeAgentCli}>退出 CLI</button>
                </div>
                <pre className="gs-agent-cli-output">{agentCliOutput || "#"}</pre>
                <form className="gs-agent-cli-form" onSubmit={runAgentCliCommand}>
                  <textarea
                    autoFocus
                    rows="3"
                    value={agentCliCommand}
                    placeholder="输入 BF CLI 命令，例如：diff all"
                    onChange={(event) => setAgentCliCommand(event.target.value)}
                  />
                  <div>
                    <button type="button" onClick={() => setAgentCliOutput("")}>清空</button>
                    <button type="submit" className="gs-primary" disabled={busy === "cli"}>发送</button>
                  </div>
                </form>
              </section>
            ) : registrationNeeded ? (
              <form className="gs-register-form" onSubmit={createAircraft}>
                <h2>登记新飞机</h2>
                <label>机主<input required list="ground-station-owner-options" placeholder="选择飞手或直接输入新人姓名" value={aircraftForm.ownerDisplayName} onChange={(event) => updateAircraftOwner(event.target.value)} /></label>
                <label>个人飞机序号<input required value={aircraftForm.serialNumber} onChange={(event) => setAircraftForm({ ...aircraftForm, serialNumber: event.target.value })} /></label>
                <label>机型<input value={aircraftForm.model} onChange={(event) => setAircraftForm({ ...aircraftForm, model: event.target.value })} /></label>
                <button type="submit" className="gs-primary" disabled={busy === "register"}>保存并开始</button>
              </form>
            ) : (
              <>
                <section className="gs-config-preview">
                  <div className="gs-preview-block gs-preview-match">
                    <span>匹配版本</span>
                    <strong>
                      {!configurationPreview
                        ? (
                          bfState.connected
                            ? (busy === "snapshot" || busy === "preview" ? "正在扫描…" : "点击“刷新检查”读取")
                            : "连接后扫描"
                        )
                        : configurationPreview.matchType === "none"
                          ? "没有同 target / 固件预设"
                          : [
                              configurationPreview.preset?.useCaseCategory,
                              configurationPreview.preset?.variantCategory,
                              configurationPreview.preset?.versionLabel || configurationPreview.preset?.name,
                            ].filter(Boolean).join(" — ")}
                    </strong>
                    {configurationPreview?.preset && <small>
                      {configurationPreview.matchType === "exact"
                        ? "完全一致"
                        : `最接近，差 ${configurationPreview.differenceCount} 项`}
                      {" · "}
                      {configurationPreview.preset.createdBy || "coach"}
                    </small>}
                  </div>

                  <div className="gs-preview-block gs-critical-block">
                    <div className="gs-critical-head"><span>关键参数</span></div>
                    <div className="gs-preview-grid">
                      {mergeVtxCriticalFields(
                        configurationPreview?.configuredDisplay?.critical || [],
                        configurationPreview?.important,
                      ).map((field) => (
                        <div key={field.path} title={field.path}>
                          <small>{field.label}</small>
                          <b>{field.available ? field.formattedValue : "不支持"}</b>
                        </div>
                      ))}
                      {!configurationPreview?.configuredDisplay?.critical?.length && (
                        <div className="wide"><small>未配置</small><b>请由教练在设置页选择字段</b></div>
                      )}
                    </div>
                    {(displayForm.showPidTable || displayForm.showRateTable) && (() => {
                      const pidList = configurationPreview?.configuredDisplay?.tables?.pidProfiles || [];
                      const rateList = configurationPreview?.configuredDisplay?.tables?.rateProfiles || [];
                      const indexes = [...new Set([...pidList, ...rateList].map((profile) => Number(profile.index)))].sort((a, b) => a - b);
                      if (!indexes.length) return <div className="gs-empty">连接飞机并刷新后显示常用表格</div>;
                      const activeIndex = indexes[0];
                      const pidProfile = pidList.find((profile) => Number(profile.index) === activeIndex);
                      const rateProfile = rateList.find((profile) => Number(profile.index) === activeIndex);
                      const rateCols = rateProfile ? rateColumnLabels(rateProfile.ratesType) : null;
                      return (
                        <div className="gs-tuning-panel">
                          <div className="gs-tuning-tables">
                            {displayForm.showPidTable && pidProfile && (
                              <table className="gs-tuning-table">
                                <caption>PID Profile {activeIndex + 1}{pidProfile.name ? ` · ${pidProfile.name}` : ""}</caption>
                                <thead><tr><th>轴</th><th>P</th><th>I</th><th>D</th><th title="Feedforward 前馈">前馈</th></tr></thead>
                                <tbody>
                                  {["roll", "pitch", "yaw"].map((axis) => (
                                    <tr key={`pid-${activeIndex}-${axis}`}>
                                      <th>{axis === "roll" ? "横滚" : axis === "pitch" ? "俯仰" : "偏航"}</th>
                                      <td>{pidProfile.axes?.[axis]?.p ?? "—"}</td>
                                      <td>{pidProfile.axes?.[axis]?.i ?? "—"}</td>
                                      <td>{pidProfile.axes?.[axis]?.d ?? "—"}</td>
                                      <td>{pidProfile.axes?.[axis]?.f ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {displayForm.showRateTable && rateProfile && (
                              <table className="gs-tuning-table">
                                <caption>
                                  Rate Profile {activeIndex + 1}
                                  {rateProfile.name ? ` · ${rateProfile.name}` : ""}
                                  {" · "}{rateProfile.ratesTypeDisplay}
                                  {" · 油门限制 "}{rateProfile.throttleLimitTypeDisplay}
                                  {rateProfile.throttle?.limitPercent != null ? ` ${rateProfile.throttle.limitPercent}%` : ""}
                                </caption>
                                <thead><tr><th>轴</th><th>{rateCols.rcRate}</th><th>{rateCols.superRate}</th><th>{rateCols.expo}</th></tr></thead>
                                <tbody>
                                  {["roll", "pitch", "yaw"].map((axis) => (
                                    <tr key={`rate-${activeIndex}-${axis}`}>
                                      <th>{axis === "roll" ? "横滚" : axis === "pitch" ? "俯仰" : "偏航"}</th>
                                      <td>{rateProfile.axes?.[axis]?.rcRate ?? "—"}</td>
                                      <td>{rateProfile.axes?.[axis]?.superRate ?? "—"}</td>
                                      <td>{rateProfile.axes?.[axis]?.expo ?? "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                  <div className="gs-preview-block">
                    <span>配置差异</span>
                    <div className="gs-configuration-differences">
                      <ConfigurationDifference
                        label="匹配预设"
                        comparison={configurationPreview?.differences?.baseline}
                        emptyLabel="无同版本基线"
                      />
                      <ConfigurationDifference
                        label="上次调参"
                        comparison={configurationPreview?.differences?.previous}
                      />
                      {(configurationPreview?.differences?.otherAircraft || []).map((item) => (
                        item.comparable
                          ? <ConfigurationDifference key={item.aircraftId} label={`其他飞机 · 序号 ${item.serialNumber}`} comparison={item.diff ? item : null} />
                          : (
                            <div className="gs-difference-unavailable" key={item.aircraftId}>
                              <b>其他飞机 · 序号 {item.serialNumber}</b>
                              <small>{item.boardIdentifier || "未识别 target"} — {item.firmwareVersion || "未识别固件"} · 不可跨版本比较</small>
                            </div>
                          )
                      ))}
                      {!configurationPreview?.differences?.otherAircraft?.length && (
                        <div className="gs-difference-unavailable"><b>其他飞机</b><small>没有其他飞机</small></div>
                      )}
                    </div>
                  </div>

                  <div className="gs-preview-block">
                    <span>检查单</span>
                    <div className="gs-checklist">
                      <div>
                        <b>Profile一致</b>
                        <em data-state={configurationPreview?.checklist?.profileConsistency?.matches}>
                          {configurationPreview?.checklist?.profileConsistency?.matches == null
                            ? "未读取"
                            : configurationPreview.checklist.profileConsistency.matches ? "通过" : "不通过"}
                        </em>
                      </div>
                      {(configurationPreview?.configuredDisplay?.checks || []).map((check) => (
                        <div key={check.id}>
                          <b>{check.label || check.path}</b>
                          <em data-state={check.passed}>
                            {!check.available ? "当前固件不支持" : check.passed ? "通过" : `不通过 · 当前 ${check.actualDisplay}`}
                          </em>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="gs-actions">
                  <button type="button" disabled={!bfState.connected || busy} onClick={openAgentCli}>CLI 控制台</button>
                  <button type="button" disabled={!bfState.connected || busy} onClick={() => setQuickOpen(!quickOpen)}>快捷设置</button>
                  <button type="button" disabled={!bfState.connected || busy} onClick={refreshConfigurationPreview}>刷新检查</button>
                </section>

                {quickOpen && (
                  <section className="gs-quick-form">
                    <div className="gs-quick-row">
                      <label>飞行器名称<input placeholder="CRAFT_NAME" value={quickForm.craftName} onChange={(event) => setQuickForm({ ...quickForm, craftName: event.target.value })} /></label>
                      <button type="button" className="gs-primary" disabled={!bfState.connected || busy === "quick" || !quickForm.craftName.trim()} onClick={() => applyQuickSettings({
                        craftName: quickForm.craftName,
                        craftNameField: configurationPreview?.important?.craftNameField,
                      }, "修改飞行器名称")}>修改</button>
                    </div>
                    <div className="gs-quick-row">
                      <label>图传频点<select value={quickForm.vtxSelection} onChange={(event) => setQuickForm({ ...quickForm, vtxSelection: event.target.value })}>
                        <option value="">选择频点</option>
                        {(configurationPreview?.important?.vtxOptions || []).map((option) => (
                          <option key={option.value} value={option.value}>{option.label} · {option.frequency} MHz</option>
                        ))}
                      </select></label>
                      <button type="button" className="gs-primary" disabled={!bfState.connected || busy === "quick" || !quickForm.vtxSelection} onClick={applyQuickVtx}>修改</button>
                    </div>
                    <div className="gs-quick-row">
                      <label>快速配置预设<select value={quickForm.presetId} onChange={(event) => setQuickForm({ ...quickForm, presetId: event.target.value })}>
                        <option value="">选择可用版本</option>
                        {applicablePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {[preset.useCaseCategory, preset.variantCategory, preset.versionLabel || preset.name].filter(Boolean).join(" — ")}
                          </option>
                        ))}
                      </select></label>
                      <button type="button" className="gs-primary" disabled={!bfState.connected || busy === "quick-preset" || !quickForm.presetId} onClick={applyQuickPreset}>套用</button>
                    </div>
                    <div className="gs-quick-row">
                      <label>所有 Profile 油门限制<input type="number" min="25" max="100" step="1" placeholder="25~100%" value={quickForm.throttleLimit} onChange={(event) => setQuickForm({ ...quickForm, throttleLimit: event.target.value })} /></label>
                      <button type="button" className="gs-primary" disabled={!bfState.connected || busy === "quick-throttle" || !quickForm.throttleLimit} onClick={applyQuickThrottleLimit}>应用</button>
                    </div>
                    <div className="gs-quick-row">
                      <label><span>Profile 1 同步至全部 Profile</span></label>
                      <button type="button" disabled={!bfState.connected || busy === "quick-sync"} onClick={syncProfilesToFirst}>同步</button>
                    </div>
                  </section>
                )}

              </>
            )}
          </div>
        )}

        {panel === "auth" && (
          <div className="gs-agent-body gs-list-panel">
            <div className="gs-panel-title"><strong>访问权限</strong><span>当前：{role}</span></div>
            <label>操作人<input value={operatorLabel} onChange={(event) => setOperatorLabel(event.target.value)} placeholder="姓名 / 代号" /></label>
            <label>队伍密码<input type="password" value={teamPassword} onChange={(event) => setTeamPassword(event.target.value)} /></label>
            <button type="button" className="gs-primary" onClick={() => login("team")}>队员登录</button>
            <label>教练密码<input type="password" value={coachPassword} onChange={(event) => setCoachPassword(event.target.value)} /></label>
            <button type="button" onClick={() => login("coach")}>教练登录</button>
            {role !== "guest" && <button type="button" className="gs-danger-text" onClick={logout}>退出权限</button>}
          </div>
        )}

        {panel === "fleet" && (
          <div className="gs-agent-body gs-list-panel">
            <div className="gs-panel-title"><strong>机库</strong><span>{aircraft.length} 架</span></div>
            {editingAircraftId && <form className="gs-compact-form" onSubmit={saveAircraft}>
              <strong>编辑飞机</strong>
              <label>个人飞机序号<input required value={aircraftForm.serialNumber} onChange={(event) => setAircraftForm({ ...aircraftForm, serialNumber: event.target.value })} /></label>
              <label>机主<input required list="ground-station-owner-options" placeholder="选择飞手或直接输入新人姓名" value={aircraftForm.ownerDisplayName} onChange={(event) => updateAircraftOwner(event.target.value)} /></label>
              <label>机型<input value={aircraftForm.model} onChange={(event) => setAircraftForm({ ...aircraftForm, model: event.target.value })} /></label>
              <label>配置备注<input value={aircraftForm.configurationNote} onChange={(event) => setAircraftForm({ ...aircraftForm, configurationNote: event.target.value })} /></label>
              <div className="gs-inline-actions">
                <button type="submit" className="gs-primary" disabled={busy === "aircraft"}>保存</button>
                <button type="button" onClick={() => { setEditingAircraftId(""); setAircraftForm(emptyAircraftForm()); }}>取消</button>
              </div>
            </form>}
            {aircraft.map((item) => (
              <article
                className={`gs-list-item gs-collapsible ${expandedAircraftId === item.id ? "expanded" : ""}`}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => setExpandedAircraftId((current) => current === item.id ? "" : item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setExpandedAircraftId((current) => current === item.id ? "" : item.id);
                }}
              >
                <strong>{item.ownerName || "未指定机主"} · {item.serialNumber}</strong>
                <span>{item.controller?.boardIdentifier || item.controller?.boardName || "未绑定飞控"}</span>
                {expandedAircraftId === item.id && <>
                  <small>飞控 ID：{item.controller?.deviceUid || "未绑定"} · 固件：{item.controller?.firmwareVersion || "未知"}</small>
                  {item.configurationNote && <small>{item.configurationNote}</small>}
                  <div className="gs-inline-actions">
                    <button type="button" onClick={(event) => { event.stopPropagation(); editAircraft(item); }}>编辑</button>
                    {isCoach && <button type="button" className="gs-danger-text" onClick={(event) => { event.stopPropagation(); deleteAircraft(item); }}>删除</button>}
                  </div>
                </>}
              </article>
            ))}
            {!aircraft.length && <div className="gs-empty">暂无飞机</div>}

            <div className="gs-panel-title gs-sub-title"><strong>飞手库</strong><span>{pilots.fleetPilots.length} 人</span></div>
            {pilotForm.id && <form className="gs-compact-form" onSubmit={savePilot}>
              <strong>编辑飞手</strong>
              <label>姓名<input required value={pilotForm.name} onChange={(event) => setPilotForm({ ...pilotForm, name: event.target.value })} /></label>
              <div className="gs-inline-actions">
                <button type="submit" className="gs-primary" disabled={busy === "pilot"}>保存</button>
                <button type="button" onClick={() => setPilotForm({ id: "", name: "" })}>取消</button>
              </div>
            </form>}
            {pilots.fleetPilots.map((item) => (
              <article
                className={`gs-list-item gs-collapsible ${expandedPilotId === item.id ? "expanded" : ""}`}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => setExpandedPilotId((current) => current === item.id ? "" : item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setExpandedPilotId((current) => current === item.id ? "" : item.id);
                }}
              >
                <strong>{item.name}</strong>
                <span>{aircraft.filter((plane) => plane.ownerPilotId === item.id).length} 架飞机</span>
                {expandedPilotId === item.id && <>
                  <div className="gs-owned-aircraft">
                    {aircraft.filter((plane) => plane.ownerPilotId === item.id).map((plane) => (
                      <span key={plane.id}>{plane.serialNumber} · {plane.controller?.boardIdentifier || plane.controller?.boardName || "未绑定飞控"}</span>
                    ))}
                    {!aircraft.some((plane) => plane.ownerPilotId === item.id) && <span>暂无飞机</span>}
                  </div>
                  {!item.readOnly && <div className="gs-inline-actions">
                    <button type="button" onClick={(event) => { event.stopPropagation(); setPilotForm({ id: item.id, name: item.name }); }}>编辑</button>
                    {isCoach && <button type="button" className="gs-danger-text" onClick={(event) => { event.stopPropagation(); deletePilot(item); }}>删除</button>}
                  </div>}
                </>}
              </article>
            ))}
          </div>
        )}

        {panel === "history" && (
          <div className="gs-agent-body gs-list-panel">
            <div className="gs-panel-title"><strong>飞机配置版本</strong><span>{historyGroups.length} 架</span></div>
            {historyGroups.map((group) => (
              <details className="gs-history-aircraft" key={group.key}>
                <summary>
                  <div>
                    <strong>{group.title}</strong>
                    <small>{group.boardName || "未知飞控"} · {group.firmwareVersion || "未知固件"}</small>
                  </div>
                  <span>{group.records.length} 个版本</span>
                </summary>
                <div className="gs-history-versions">
                  {group.records.map((item, index) => (
                    <article
                      className={`gs-list-item gs-collapsible ${expandedHistoryId === item.id ? "expanded" : ""}`}
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedHistoryId((current) => current === item.id ? "" : item.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setExpandedHistoryId((current) => current === item.id ? "" : item.id);
                        }
                      }}
                    >
                      <strong>版本 {group.records.length - index}</strong>
                      <span>
                        {formatTime(item.createdAt || item.endedAt || item.startedAt)}
                        {" · "}
                        {item.source === "connection_scan" ? "连接扫描" : item.source === "msp_commit" ? "保存后验证" : "手动刷新"}
                        {" · "}
                        变化 {item.diff?.summary?.total ?? 0} 项
                        {item.diff?.summary?.unmapped ? ` · ${item.diff.summary.unmapped} 项未映射` : ""}
                      </span>
                      {expandedHistoryId === item.id && <>
                        <small>固件：{item.firmwareVersion || "未知"} · 操作人：{item.operatorLabel || item.operatorRole}</small>
                        {!!item.changedDomains?.length && (
                          <small>修改范围：{item.changedDomains.map(configurationDomainLabel).join(" / ")}</small>
                        )}
                        <div className="gs-history-diff">
                          {diffRows(item.diff).map((row) => (
                            <div key={`${row.state}-${row.key}`}>
                              <strong title={`原始字段：${row.rawKey}\n统一路径：${row.canonicalPath}`}>
                                <em className={`gs-change-${row.state}`}>{row.state}</em>
                                <small className="gs-param-category">
                                  {row.profileLabel || row.categoryLabel}
                                </small>
                                {row.label}
                                {!row.mapped && <u>未映射</u>}
                              </strong>
                              <span title={`${row.reference} → ${row.current}`}>{row.reference} → {row.current}</span>
                            </div>
                          ))}
                          {!diffRows(item.diff).length && <small>没有参数变化</small>}
                        </div>
                        {isCoach && <div className="gs-inline-actions">
                          <button type="button" className="gs-danger-text" onClick={(event) => { event.stopPropagation(); deleteHistory(item); }}>删除版本</button>
                        </div>}
                      </>}
                    </article>
                  ))}
                </div>
              </details>
            ))}
            {!historyGroups.length && <div className="gs-empty">暂无飞机配置版本</div>}
          </div>
        )}

        {panel === "settings" && (
          <form className="gs-agent-body gs-list-panel gs-settings-panel" onSubmit={saveDisplaySettings}>
            <div className="gs-panel-title">
              <strong>显示设置</strong>
              <span>{availableConfigurationFields.length ? `${availableConfigurationFields.length} 个当前可用字段` : "连接飞机后生成字段目录"}</span>
            </div>
            <fieldset className="gs-field-checklist">
              <legend>设备信息</legend>
              {DEVICE_INFO_FIELDS.map((field) => (
                <label key={field.key}>
                  <input
                    type="checkbox"
                    disabled={!isCoach}
                    checked={(displayForm.deviceFields || []).includes(field.key)}
                    onChange={(event) => toggleDisplayField("deviceFields", field.key, event.target.checked)}
                  />
                  <span>{field.label}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="gs-field-checklist">
              <legend>关键参数</legend>
              <label className="gs-settings-toggle">
                <input
                  type="checkbox"
                  disabled={!isCoach}
                  checked={Boolean(displayForm.showPidTable)}
                  onChange={(event) => setDisplayForm((current) => ({ ...current, showPidTable: event.target.checked }))}
                />
                <span>在预览区显示 PID 常用表格</span>
              </label>
              <label className="gs-settings-toggle">
                <input
                  type="checkbox"
                  disabled={!isCoach}
                  checked={Boolean(displayForm.showRateTable)}
                  onChange={(event) => setDisplayForm((current) => ({ ...current, showRateTable: event.target.checked }))}
                />
                <span>在预览区显示 Rate 常用表格</span>
              </label>
              {profileConfigurationFieldGroups.length > 0 && (
                <label className="gs-profile-filter">
                  Profile 分类
                  <select
                    value={selectedProfileConfigurationGroup?.id || ""}
                    onChange={(event) => setDisplayProfileFilter(event.target.value)}
                  >
                    {profileConfigurationFieldGroups.map((group) => (
                      <option key={group.id} value={group.id}>{group.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {selectedProfileConfigurationGroup && (
                <details className="gs-field-category" key={selectedProfileConfigurationGroup.id} open>
                  <summary><strong>{selectedProfileConfigurationGroup.label}</strong><span>{selectedProfileConfigurationGroup.fields.length} 项</span></summary>
                  <div>
                    {selectedProfileConfigurationGroup.fields.map((field) => (
                      <label key={`critical-${field.path}`} title={field.path}>
                        <input
                          type="checkbox"
                          disabled={!isCoach}
                          checked={(displayForm.criticalFields || []).includes(field.path)}
                          onChange={(event) => toggleDisplayField("criticalFields", field.path, event.target.checked)}
                        />
                        <span>{field.label}</span>
                      </label>
                    ))}
                  </div>
                  {!selectedProfileConfigurationGroup.fields.length && (
                    <div className="gs-empty">该 Profile 暂无额外可配置字段</div>
                  )}
                </details>
              )}
              {configurationFieldGroups.map((group) => (
                <details className="gs-field-category" key={group.category}>
                  <summary><strong>{group.category}</strong><span>{group.fields.length} 项</span></summary>
                  <div>
                    {group.fields.map((field) => (
                      <label key={`critical-${field.path}`} title={field.path}>
                        <input
                          type="checkbox"
                          disabled={!isCoach}
                          checked={(displayForm.criticalFields || []).includes(field.path)}
                          onChange={(event) => toggleDisplayField("criticalFields", field.path, event.target.checked)}
                        />
                        <span>{field.label}</span>
                      </label>
                    ))}
                  </div>
                </details>
              ))}
              {!availableConfigurationFields.length && <small>请先连接飞机并完成 MSP 扫描</small>}
            </fieldset>
            <fieldset className="gs-field-checklist">
              <legend>自定义检查{isCoach && <button type="button" className="gs-add-check" onClick={addDisplayCheck}>添加条件</button>}</legend>
            {displayForm.checks.map((check) => (
              <article className="gs-setting-check" key={check.id}>
                <input
                  disabled={!isCoach}
                  value={check.label}
                  placeholder="检查名称"
                  onChange={(event) => updateDisplayCheck(check.id, { label: event.target.value })}
                />
                <select
                  disabled={!isCoach}
                  value={check.path}
                  onChange={(event) => updateDisplayCheck(check.id, { path: event.target.value })}
                >
                  <option value="">选择变量</option>
                  {availableConfigurationFields.map((field) => (
                    <option key={`${check.id}-${field.path}`} value={field.path}>{field.category} · {field.label}</option>
                  ))}
                </select>
                <select
                  disabled={!isCoach}
                  value={check.operator}
                  onChange={(event) => updateDisplayCheck(check.id, { operator: event.target.value })}
                >
                  <option value="eq">等于</option>
                  <option value="neq">不等于</option>
                  <option value="gt">大于</option>
                  <option value="gte">大于等于</option>
                  <option value="lt">小于</option>
                  <option value="lte">小于等于</option>
                  <option value="includes">包含</option>
                  <option value="enabled">已启用</option>
                </select>
                {check.operator !== "enabled" && (
                  <input
                    disabled={!isCoach}
                    value={check.value}
                    placeholder="目标值"
                    onChange={(event) => updateDisplayCheck(check.id, { value: event.target.value })}
                  />
                )}
                {isCoach && <button type="button" className="gs-danger-text" onClick={() => setDisplayForm((current) => ({
                  ...current,
                  checks: current.checks.filter((item) => item.id !== check.id),
                }))}>删除</button>}
              </article>
            ))}
            {!displayForm.checks.length && <div className="gs-empty">暂无自定义检查条件</div>}
            </fieldset>
            <fieldset className="gs-field-checklist">
              <legend>不对比项目</legend>
              <p className="gs-field-hint">勾选的参数将从“配置差异”中忽略，不再计入差异数量。</p>
              {configurationFieldGroups.map((group) => (
                <details className="gs-field-category" key={"exclude-" + group.category}>
                  <summary><strong>{group.category}</strong><span>{group.fields.length} 项</span></summary>
                  <div>
                    {group.fields.map((field) => (
                      <label key={"exclude-" + field.path} title={field.path}>
                        <input
                          type="checkbox"
                          disabled={!isCoach}
                          checked={(displayForm.excludedDiffFields || []).includes(field.path)}
                          onChange={(event) => toggleDisplayField("excludedDiffFields", field.path, event.target.checked)}
                        />
                        <span>{field.label}</span>
                      </label>
                    ))}
                  </div>
                </details>
              ))}
              {!availableConfigurationFields.length && <small>请先连接飞机并完成 MSP 扫描</small>}
            </fieldset>
            <div className="gs-settings-footer">
            {isCoach && <button type="submit" className="gs-primary">保存设置</button>}
            </div>
          </form>
        )}

        {panel === "presets" && (
          <div className="gs-agent-body gs-list-panel">
            <div className="gs-panel-title"><strong>预设版本</strong><span>{presets.length} 个</span></div>
            {presetDirectory.map((target) => (
              <details className="gs-preset-group gs-directory-target" key={target.target} defaultOpen={target.target === bfState.boardIdentifier}>
                <summary><strong>{target.target}</strong><span>{target.useCases.length} 类</span></summary>
                <div className="gs-directory-level">
                  {target.useCases.map((useCase) => (
                    <details key={`${target.target}-${useCase.useCase}`} open>
                      <summary><strong>{useCase.useCase}</strong><span>用途</span></summary>
                      <div className="gs-directory-level">
                        {useCase.firmwares.map((firmware) => (
                          <details key={`${target.target}-${useCase.useCase}-${firmware.firmware}`} open={firmware.firmware === bfState.firmwareVersion}>
                            <summary><strong>{firmware.firmware}</strong><span>固件</span></summary>
                            <div className="gs-directory-level">
                              {firmware.variants.map((variant) => (
                                <details key={`${target.target}-${useCase.useCase}-${firmware.firmware}-${variant.variant}`} open>
                                  <summary><strong>{variant.variant}</strong><span>{variant.versions.length} 个版本</span></summary>
                                  <div>
                                    {variant.versions.map((preset) => (
                                      <article className="gs-preset-version gs-preset-version-card" key={preset.id}>
                                        <header>
                                          <strong title={preset.versionLabel || preset.name}>{preset.versionLabel || preset.name || formatDate(preset.createdAt)}</strong>
                                          <time dateTime={new Date(preset.createdAt).toISOString()}>{formatDate(preset.createdAt)}</time>
                                          <small>{preset.createdBy || "coach"}</small>
                                        </header>
                                        <div className="gs-preset-assets-status">
                                          <b data-ready={preset.hasRawCli}>CLI</b>
                                          <b data-ready={preset.hasCanonicalSnapshot}>MSP</b>
                                          <b data-ready={preset.hasFirmware}>固件</b>
                                          {preset.hasRawCli && preset.hasCanonicalSnapshot && (
                                            <em data-state={preset.consistency?.status === "consistent"}>
                                              {preset.consistency?.status === "different"
                                                ? `可解析差异 ${preset.consistency.different?.length || 0}`
                                                : `对照 ${preset.consistency?.comparable || 0} 项`}
                                            </em>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          className="gs-preset-assets-toggle"
                                          aria-expanded={expandedPresetAssetsId === preset.id}
                                          onClick={() => setExpandedPresetAssetsId((current) => current === preset.id ? "" : preset.id)}
                                        >
                                          管理 <span aria-hidden="true">{expandedPresetAssetsId === preset.id ? "⌃" : "⌄"}</span>
                                        </button>
                                        {expandedPresetAssetsId === preset.id && (
                                          <div className="gs-preset-assets">
                                          {preset.hasRawCli && preset.hasCanonicalSnapshot && preset.consistency?.status === "different" && (
                                            <div className="gs-consistency-diff">
                                              <strong>CLI / MSP 差异</strong>
                                              <div className="gs-history-diff">
                                                {(preset.consistency.different || []).map((item) => (
                                                  <div key={item.path}>
                                                    <strong><em className="gs-change-不同">{item.path}</em></strong>
                                                    <span title={`CLI ${item.cli} → MSP ${item.msp}`}>CLI {item.cli} → MSP {item.msp}</span>
                                                  </div>
                                                ))}
                                              </div>
                                              {preset.consistency.missingInMsp?.length > 0 && (
                                                <small>CLI 有但 MSP 未映射：{preset.consistency.missingInMsp.length} 项</small>
                                              )}
                                              {preset.consistency.unmapped?.length > 0 && (
                                                <small>CLI 未映射：{preset.consistency.unmapped.length} 项</small>
                                              )}
                                            </div>
                                          )}
                                          <div>
                                            {preset.hasRawCli && <button type="button" onClick={() => downloadPreset(preset)}>下载 CLI</button>}
                                            {isCoach && (
                                              <label className="gs-file-picker">
                                                <span>{preset.hasRawCli ? "替换 CLI" : "上传 CLI"}</span>
                                                <input type="file" accept=".txt,text/plain" onChange={(event) => attachCliToPreset(preset, event)} />
                                              </label>
                                            )}
                                            {isCoach && (
                                              <button
                                                type="button"
                                                disabled={!bfState.connected
                                                  || busy
                                                  || preset.boardIdentifier !== bfState.boardIdentifier
                                                  || preset.firmwareVersion !== bfState.firmwareVersion
                                                  || (preset.firmwareBuildKey && preset.firmwareBuildKey !== bfState.buildKey)}
                                                onClick={() => calibratePresetWithCurrentMsp(preset)}
                                              >
                                                {preset.hasCanonicalSnapshot ? "从当前飞机更新" : "从当前飞机建立 MSP"}
                                              </button>
                                            )}
                                            {isCoach && (
                                              <select value={preset.firmwareFileId} onChange={(event) => attachFirmwareToPreset(preset, event.target.value)}>
                                                <option value="">未关联固件</option>
                                                {firmwareFiles.filter((item) => (
                                                  item.boardIdentifier === preset.boardIdentifier
                                                  && item.firmwareVersion === preset.firmwareVersion
                                                )).map((item) => (
                                                  <option key={item.id} value={item.id}>
                                                    {item.sourceType === "cloud" ? "云编译" : "本地"} · {item.fileName}
                                                  </option>
                                                ))}
                                              </select>
                                            )}
                                            {preset.hasFirmware && <small>
                                              {preset.firmwareSource === "cloud"
                                                ? `云编译 · Build Key ${preset.firmwareBuildKey || "缺失"}`
                                                : `本地/厂家 · ${preset.firmwareBuildTime ? formatTime(preset.firmwareBuildTime) : "时间未知"}`}
                                            </small>}
                                            {isCoach && <button type="button" className="gs-danger-text" onClick={() => deletePreset(preset)}>删除版本</button>}
                                          </div>
                                          </div>
                                        )}
                                      </article>
                                    ))}
                                  </div>
                                </details>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
            {!presetDirectory.length && <div className="gs-empty">暂无预设版本</div>}
            {isCoach && (
              <details className="gs-preset-publish" onToggle={(event) => {
                if (!event.currentTarget.open) return;
                setPresetForm((current) => ({
                  ...current,
                  boardIdentifier: current.boardIdentifier || bfState.boardIdentifier,
                  firmwareVersion: current.firmwareVersion || bfState.firmwareVersion,
                }));
              }}>
                <summary>发布 TXT 版本</summary>
                <form className="gs-preset-form" onSubmit={createPreset}>
                  <div className="gs-two-fields">
                    <input required placeholder={bfState.boardIdentifier || "飞控 target"} value={presetForm.boardIdentifier} onChange={(event) => setPresetForm({ ...presetForm, boardIdentifier: event.target.value })} />
                    <input required placeholder={bfState.firmwareVersion || "固件版本"} value={presetForm.firmwareVersion} onChange={(event) => setPresetForm({ ...presetForm, firmwareVersion: event.target.value })} />
                  </div>
                  <div className="gs-two-fields">
                    <input required placeholder="用途分类，例如：高清 / 模拟 / 练习" value={presetForm.useCaseCategory} onChange={(event) => setPresetForm({ ...presetForm, useCaseCategory: event.target.value })} />
                    <input required placeholder="子类，例如：基准 / 个性化 / 短赛道" value={presetForm.variantCategory} onChange={(event) => setPresetForm({ ...presetForm, variantCategory: event.target.value })} />
                  </div>
                  <input required placeholder="版本标识，例如：260805" value={presetForm.versionLabel} onChange={(event) => setPresetForm({ ...presetForm, versionLabel: event.target.value })} />
                  <label className="gs-file-picker">
                    <span>{presetForm.sourceFileName || "选择配置 TXT"}</span>
                    <input required type="file" accept=".txt,text/plain" onChange={readPresetTextFile} />
                  </label>
                  <select value={presetForm.firmwareFileId} onChange={(event) => setPresetForm({ ...presetForm, firmwareFileId: event.target.value })}>
                    <option value="">固件层暂不关联</option>
                    {firmwareFiles.filter((item) => (
                      item.boardIdentifier === presetForm.boardIdentifier
                      && item.firmwareVersion === presetForm.firmwareVersion
                    )).map((item) => (
                      <option key={item.id} value={item.id}>{item.sourceType === "cloud" ? "云编译" : "本地"} · {item.fileName}</option>
                    ))}
                  </select>
                  <button type="submit" className="gs-primary">发布新版本</button>
                </form>
              </details>
            )}

            {isMember && (
              <details className="gs-firmware-drawer">
                <summary><strong>自定义固件</strong><span>{firmwareFiles.length} 个</span></summary>
                <div className="gs-firmware-drawer-body">
                  {firmwareFiles.map((item) => (
                    <article className="gs-list-item" key={item.id}>
                      <strong>{item.fileName}</strong>
                      <span>{item.boardIdentifier || "未指定 target"} · {item.firmwareVersion || "未标注版本"}</span>
                      <small>
                        {item.sourceType === "cloud" ? `云编译 · ${item.buildKey || "无 Build Key"}` : "本地/厂家"}
                        {" · "}{item.hasBinary ? `${Math.ceil(item.sizeBytes / 1024)} KB HEX` : "MSP 识别资产"}
                        {" · "}{formatTime(item.buildTime || item.createdAt)}
                      </small>
                      <div className="gs-inline-actions">
                        {item.hasBinary && <button type="button" onClick={() => downloadFirmware(item)}>下载 HEX</button>}
                        {isCoach && <button type="button" className="gs-danger-text" onClick={() => deleteFirmware(item)}>删除</button>}
                      </div>
                    </article>
                  ))}
                  {!firmwareFiles.length && <div className="gs-empty">暂无自定义固件</div>}
                  {isCoach && <form className="gs-preset-form" onSubmit={uploadFirmware}>
                    <h2>上传自定义 HEX</h2>
                    <label>HEX 文件<input required type="file" accept=".hex,text/plain" onChange={(event) => setFirmwareForm({ ...firmwareForm, file: event.target.files?.[0] || null })} /></label>
                    <label>飞控 target<input required placeholder={bfState.boardIdentifier || "例如 JHEF7DUAL"} value={firmwareForm.boardIdentifier} onChange={(event) => setFirmwareForm({ ...firmwareForm, boardIdentifier: event.target.value })} /></label>
                    <label>固件版本<input required value={firmwareForm.firmwareVersion} onChange={(event) => setFirmwareForm({ ...firmwareForm, firmwareVersion: event.target.value })} /></label>
                    <label>来源<select value={firmwareForm.sourceType} onChange={(event) => setFirmwareForm({ ...firmwareForm, sourceType: event.target.value, buildKey: "" })}>
                      <option value="local">本地 / 自定义 / 厂家</option>
                      <option value="cloud">Betaflight 云编译</option>
                    </select></label>
                    {firmwareForm.sourceType === "cloud" && <label>Build Key<input required value={firmwareForm.buildKey} onChange={(event) => setFirmwareForm({ ...firmwareForm, buildKey: event.target.value })} /></label>}
                    <label>构建时间<input type="datetime-local" value={firmwareForm.buildTime} onChange={(event) => setFirmwareForm({ ...firmwareForm, buildTime: event.target.value })} /></label>
                    <button type="submit" className="gs-primary" disabled={busy === "firmware"}>上传 HEX</button>
                  </form>}
                </div>
              </details>
            )}
          </div>
        )}
        </div>
      </aside>

      <button
        type="button"
        className="gs-sidebar-resizer"
        aria-label="调整 Agent 侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={AGENT_MIN_WIDTH}
        aria-valuemax={agentMaxWidth}
        aria-valuenow={agentWidth}
        onPointerDown={startAgentResize}
        onKeyDown={resizeByKeyboard}
        onDoubleClick={() => {
          const resetWidth = Math.min(390, agentMaxWidth);
          setAgentWidth(resetWidth);
          sessionStorage.setItem(AGENT_WIDTH_KEY, String(resetWidth));
        }}
      />

      <main className="gs-betaflight">
        {mirrorAvailable ? (
          <iframe
            key={activeKernelId}
            ref={iframeRef}
            title="Betaflight Configurator"
            src={activeKernel.url}
            allow="serial; usb; bluetooth"
            className={frameSecured ? "secured" : ""}
            onLoad={handleFrameLoad}
          />
        ) : (
          <div className="gs-mirror-missing">
            <strong>BETAF<span>LIGHT</span></strong>
            <p>将 BF 构建产物放入 <code>/app/betaflight-dist</code> 后重启应用。</p>
          </div>
        )}
        {(agentCliMode || agentOperation) && (
          <div className="gs-betaflight-cli-mask" role="status" aria-live="polite">
            <i aria-hidden="true" />
            <strong>{agentCliMode ? "CLI 由左侧 Agent 控制" : agentOperation}</strong>
            {!agentCliMode && <small>请稍等，不要拔出 USB</small>}
          </div>
        )}
      </main>
    </div>
  );
}
