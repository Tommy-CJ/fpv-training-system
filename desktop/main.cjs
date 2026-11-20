const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog } = require("electron");
const { SerialPort } = require("serialport");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { findConfiguredPort, isTrainingHub, portIdentity, portLabel, portReadyToOpen, sortPorts } = require("./portInfo.cjs");

const CLOUD_ORIGIN = "https://app.1.gzfpv.cn";
const BAUD_RATE = 115200;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("in-process-gpu");
const demoMode = process.argv.includes("--demo");
if (demoMode) {
  const demoData = path.join(app.getPath("temp"), "fpv-training-collector-demo");
  fs.mkdirSync(demoData, { recursive: true });
  app.setPath("userData", demoData);
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => showMonitor());
}

let tray = null;
let monitorWindow = null;
let monitorTimer = null;
let collector = null;
let port = null;
let ports = [];
let checkingPort = false;
let connectRequested = false;
let stopping = false;
let configPath = "";
let config = { portPath: "", portIdentity: "", startWithWindows: true };
let portSelectionError = "";
let lastStatus = null;
let lastMenuAt = 0;
let portScanTimer = null;
let demoTimer = null;

function log(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "collector.log");
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
      fs.renameSync(logPath, `${logPath}.old`);
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Console still receives diagnostics when disk logging is unavailable.
  }
  console.log(message);
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function setStartWithWindows(enabled) {
  config.startWithWindows = Boolean(enabled);
  saveConfig();
  if (app.isPackaged && process.platform === "win32") {
    try {
      app.setLoginItemSettings({ openAtLogin: config.startWithWindows, args: ["--hidden"] });
    } catch (error) {
      log(`Windows login registration failed: ${error.message}`);
    }
  }
  updateMenu(true);
}

function monitorSnapshot() {
  return {
    ...(collector?.getMonitorSnapshot() || {}),
    activePortPath: port?.isOpen ? port.path : "",
    selectedPortPath: findConfiguredPort(ports, config)?.path || "",
    connectRequested,
    portSelectionError,
    ports: ports.map((info) => ({ path: info.path, label: portLabel(info), trainingHub: isTrainingHub(info), selectable: Boolean(portIdentity(info)) })),
  };
}

function sendMonitorSnapshot() {
  if (monitorWindow && !monitorWindow.isDestroyed() && monitorWindow.isVisible()) {
    monitorWindow.webContents.send("collector:snapshot", monitorSnapshot());
  }
}

function showMonitor() {
  if (!app.isReady()) return;
  if (!monitorWindow || monitorWindow.isDestroyed()) {
    monitorWindow = new BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 760,
      minHeight: 560,
      backgroundColor: "#f5f7fb",
      title: "FPV 训练采集监控",
      icon: path.join(__dirname, "icon.png"),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    monitorWindow.loadFile(path.join(__dirname, "dashboard.html"));
    monitorWindow.on("close", (event) => {
      if (stopping) return;
      event.preventDefault();
      monitorWindow.hide();
    });
  }
  monitorWindow.show();
  monitorWindow.focus();
  sendMonitorSnapshot();
}

function updateMenu(force = false) {
  if (!tray || !collector || (!force && Date.now() - lastMenuAt < 1000)) return;
  lastMenuAt = Date.now();
  const status = lastStatus || collector.getStatus();
  const network = status.serverConnected ? "云端已连接" : "云端重连中";
  const serial = status.serialConnected ? "串口已连接" : connectRequested ? "串口重连中" : config.portIdentity ? "等待手动连接" : "等待选择串口";
  tray.setToolTip(`FPV 训练采集 · ${serial} · ${network} · 待发送 ${status.cachedPackets} · 拒收保留 ${status.rejectedPackets || 0}`);
  const portItems = ports.map((info) => ({
    label: portIdentity(info) ? portLabel(info) : `${portLabel(info)} · 无法核验设备身份`,
    type: "radio",
    enabled: Boolean(portIdentity(info)),
    checked: config.portPath === info.path && config.portIdentity === portIdentity(info),
    click: () => {
      config.portPath = info.path;
      config.portIdentity = portIdentity(info);
      connectRequested = false;
      portSelectionError = config.portIdentity ? "" : "此串口缺少设备身份，无法安全自动重连";
      saveConfig();
      closePort();
      updateMenu(true);
    },
  }));
  const menu = Menu.buildFromTemplate([
    { label: "打开实时监控", click: showMonitor },
    { type: "separator" },
    { label: `采集：${serial}`, enabled: false },
    { label: `上行：${network}`, enabled: false },
    { label: `待发送缓存：${status.cachedPackets} 帧；拒收保留：${status.rejectedPackets || 0} 帧`, enabled: false },
    { label: `实时帧：${status.liveSent}，最近 ACK：${status.lastAckAt ? new Date(status.lastAckAt).toLocaleTimeString() : "暂无"}`, enabled: false },
    ...((portSelectionError || status.lastError) ? [{ label: `提示：${(portSelectionError || status.lastError).slice(0, 75)}`, enabled: false }] : []),
    { type: "separator" },
    { label: "选择接收阵列串口", submenu: portItems.length ? portItems : [{ label: "没有发现串口", enabled: false }] },
    { label: "连接所选串口", enabled: Boolean(config.portIdentity) && !connectRequested, click: () => {
      connectRequested = true;
      portSelectionError = "";
      updateMenu(true);
      void checkPort();
    } },
    { label: "断开串口", enabled: connectRequested || Boolean(port), click: () => {
      connectRequested = false;
      closePort();
    } },
    { label: "断开并清除串口选择", click: () => {
      connectRequested = false;
      config.portPath = "";
      config.portIdentity = "";
      portSelectionError = "";
      saveConfig();
      closePort();
    } },
    { type: "separator" },
    { label: "打开教练网页", click: () => void shell.openExternal(`${CLOUD_ORIGIN}/?nativeCollector=1`) },
    { label: "打开日志目录", click: () => void shell.openPath(app.getPath("userData")) },
    { label: "随 Windows 登录启动", type: "checkbox", checked: config.startWithWindows, click: (item) => setStartWithWindows(item.checked) },
    { type: "separator" },
    { label: "退出采集程序", click: () => {
      shutdown();
      app.exit(0);
    } },
  ]);
  tray.setContextMenu(menu);
}

function sendBind(receiverId) {
  if (!port?.isOpen) return;
  port.write(`BIND:${receiverId}\n`, (error) => {
    if (error) {
      log(`BIND:${receiverId} failed: ${error.message}`);
      dialog.showErrorBox("接收机绑定失败", error.message);
    } else {
      log(`BIND:${receiverId} sent`);
    }
  });
}

function closePort() {
  const oldPort = port;
  const attached = collector?.serialPort === oldPort;
  port = null;
  collector?.detachSerial();
  if (oldPort?.isOpen && !attached) oldPort.close();
  updateMenu(true);
  sendMonitorSnapshot();
}

async function checkPort() {
  if (stopping || checkingPort || !collector) return;
  checkingPort = true;
  try {
    ports = sortPorts(await SerialPort.list());
    const configuredPort = config.portPath
      ? ports.find((info) => info.path === config.portPath) : null;
    const target = portReadyToOpen(ports, config, connectRequested);
    portSelectionError = configuredPort && config.portIdentity && !findConfiguredPort(ports, config)
      ? `${config.portPath} 的设备身份已变化，请重新手动选择接收阵列`
      : config.portPath && !config.portIdentity
        ? "旧串口设置缺少设备身份，请重新手动选择接收阵列"
        : connectRequested && config.portPath && !configuredPort
          ? `${config.portPath} 当前未接入，请检查 USB 连接`
        : "";
    if (!connectRequested || !target) {
      if (port) closePort();
      updateMenu();
      sendMonitorSnapshot();
      return;
    }
    if (port?.path === target.path && port.isOpen) return;
    if (port) closePort();
    const opening = new SerialPort({ path: target.path, baudRate: BAUD_RATE, autoOpen: false, highWaterMark: 8 * 1024 * 1024 });
    port = opening;
    opening.open((error) => {
      if (port !== opening || stopping) {
        if (opening.isOpen) opening.close();
        return;
      }
      if (error) {
        log(`Open ${target.path} failed: ${error.message}`);
        portSelectionError = `${target.path} 连接失败：${error.message}`;
        port = null;
        updateMenu(true);
        sendMonitorSnapshot();
        return;
      }
      portSelectionError = "";
      log(`Connected ${target.path} at ${BAUD_RATE} baud`);
      opening.on("close", () => {
        if (port === opening) {
          port = null;
          collector.detachSerial();
          log(`Serial ${target.path} disconnected`);
          updateMenu(true);
        }
      });
      collector.attachSerial(opening);
      updateMenu(true);
      sendMonitorSnapshot();
    });
  } catch (error) {
    log(`Serial discovery failed: ${error.message}`);
  } finally {
    checkingPort = false;
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (portScanTimer) clearInterval(portScanTimer);
  if (monitorTimer) clearInterval(monitorTimer);
  if (demoTimer) clearInterval(demoTimer);
  closePort();
  collector?.stop();
}

app.on("before-quit", shutdown);

if (isPrimaryInstance) app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  configPath = path.join(userData, "config.json");
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  } catch {
    saveConfig();
  }
  if (!demoMode && app.isPackaged && process.platform === "win32") {
    try {
      app.setLoginItemSettings({ openAtLogin: config.startWithWindows, args: ["--hidden"] });
    } catch (error) {
      log(`Windows login registration failed: ${error.message}`);
    }
  }
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.on("click", showMonitor);
  tray.on("double-click", showMonitor);
  ipcMain.handle("collector:get-snapshot", () => monitorSnapshot());
  ipcMain.handle("collector:select-port", (_event, requestedPath) => {
    const nextPath = String(requestedPath || "");
    const selectedInfo = ports.find((info) => info.path === nextPath);
    if (nextPath && !selectedInfo) throw new Error("所选串口不存在");
    if (selectedInfo && !portIdentity(selectedInfo)) throw new Error("该设备没有可验证的身份，无法安全连接");
    config.portPath = nextPath;
    config.portIdentity = selectedInfo ? portIdentity(selectedInfo) : "";
    connectRequested = false;
    portSelectionError = "";
    saveConfig();
    closePort();
    return monitorSnapshot();
  });
  ipcMain.handle("collector:connect-port", async () => {
    if (!config.portPath || !config.portIdentity) throw new Error("请先选择接收阵列串口");
    connectRequested = true;
    portSelectionError = "";
    await checkPort();
    if (portSelectionError) throw new Error(portSelectionError);
    return monitorSnapshot();
  });
  ipcMain.handle("collector:disconnect-port", () => {
    connectRequested = false;
    portSelectionError = "";
    closePort();
    return monitorSnapshot();
  });
  ipcMain.handle("collector:bind", (_event, receiverId) => {
    const id = Number(receiverId);
    if (!Number.isInteger(id) || id < 1 || id > 16 || !port?.isOpen) throw new Error("串口未连接或接收机编号无效");
    sendBind(id);
    return true;
  });
  ipcMain.handle("collector:open-coach", () => shell.openExternal(`${CLOUD_ORIGIN}/?nativeCollector=1`));
  const { NativeTrainingCollector } = await import("./collector.mjs");
  collector = new NativeTrainingCollector({
    dbPath: demoMode ? ":memory:" : path.join(userData, "collector.sqlite"),
    remoteOrigin: CLOUD_ORIGIN,
    onStatus: (status) => {
      lastStatus = status;
      updateMenu();
    },
  });
  if (demoMode) {
    ports = [{
      path: "COM16", vendorId: "0483", productId: "5740",
      serialNumber: "TRAINING_HUB_001", pnpId: "USB\\VID_0483&PID_5740\\TRAINING_HUB_001",
      friendlyName: "USB 串行设备 (COM16)",
    }];
    config.portPath = "COM16";
    config.portIdentity = portIdentity(ports[0]);
    connectRequested = true;
    collector.activeEvent = { id: "event-demo", name: "周末训练 · 演示", active: true,
      participants: Array.from({ length: 4 }, (_, index) => ({ pilotId: `pilot-${index + 1}`, receiverId: index + 1 })) };
    collector.pilotsById = new Map([["pilot-1", "张晨"], ["pilot-2", "李博"], ["pilot-3", "王宁"], ["pilot-4", "赵琳"]]);
    collector.setEventId("event-demo");
    const demoPort = new EventEmitter();
    demoPort.path = "COM16";
    demoPort.isOpen = true;
    demoPort.close = () => { demoPort.isOpen = false; };
    port = demoPort;
    collector.socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: () => {}, close: () => {} };
    collector.attachSerial(port);
    let tick = 0;
    demoTimer = setInterval(() => {
      tick += 1;
      const packet = {
        type: "rx_batch", v: 1, t: tick * 33,
        items: Array.from({ length: 4 }, (_, index) => ({
          rx: index + 1,
          ch: [992 + Math.round(Math.sin(tick / 8 + index) * 500), 992,
            172 + (tick * 15 + index * 250) % 1639, 992, 1811, 992, 992, 992],
          lq: 98 - index, rssi: -42 - index,
        })),
      };
      port.emit("data", Buffer.from(JSON.stringify(packet) + "\n"));
    }, 33);
  } else {
    collector.start();
    await checkPort();
    portScanTimer = setInterval(() => void checkPort(), 2000);
  }
  monitorTimer = setInterval(sendMonitorSnapshot, 100);
  updateMenu(true);
  if (!process.argv.includes("--hidden") || demoMode) showMonitor();
  if (demoMode && process.env.FPV_COLLECTOR_SCREENSHOT_PATH) {
    monitorWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const screenshot = await monitorWindow.webContents.capturePage();
        fs.writeFileSync(process.env.FPV_COLLECTOR_SCREENSHOT_PATH, screenshot.toPNG());
        const visibleCount = await monitorWindow.webContents.executeJavaScript(
          "document.querySelectorAll('.receiver-card').length",
        );
        log(`Demo dashboard receivers: ${visibleCount}`);
        shutdown();
        app.exit(0);
      }, 2500);
    });
  }
  log("FPV native collector started");
}).catch((error) => {
  log(`Startup failed: ${error.stack || error.message}`);
  dialog.showErrorBox("FPV 采集程序启动失败", error.message);
  app.quit();
});
