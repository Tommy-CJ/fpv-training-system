const BRIDGE_STYLE_ID = "fleet-ground-station-overrides";
const EXTERNAL_LINK_SELECTOR = 'a[href^="http://"], a[href^="https://"], a[target="_blank"]';
const SNAPSHOT_TIMEOUT_MS = 75_000;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function supportsMspCli(version) {
  const match = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return true;
  const current = match.slice(1).map(Number);
  const minimum = [4, 5, 4];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}

function isTimeout(error) {
  return /timed out/i.test(String(error?.message || error));
}

async function waitForElement(doc, selector, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = doc.querySelector(selector);
    if (element) return element;
    await wait(100);
  }
  throw new Error(`BF 页面未找到 ${selector}`);
}

function sidebarNavigationNodes(doc) {
  return [...doc.querySelectorAll(".sidebar-nav button, .sidebar-nav a, .sidebar-nav [role='menuitem']")];
}

function navigationNodeByIcon(doc, iconName) {
  const icon = doc.querySelector([
    `.sidebar-nav .i-lucide-${iconName}`,
    `.sidebar-nav [class*="lucide-${iconName}"]`,
    `.sidebar-nav [class*="lucide:${iconName}"]`,
    `.sidebar-nav [data-icon*="${iconName}"]`,
  ].join(", "));
  return icon?.closest("button, a, [role='menuitem']") || null;
}

function clickSidebarItem(doc, matcher, iconName = "") {
  const byIcon = iconName ? navigationNodeByIcon(doc, iconName) : null;
  if (byIcon) {
    byIcon.click();
    return true;
  }
  const items = sidebarNavigationNodes(doc);
  const item = items.find((node) => matcher.test([
    node.textContent,
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
  ].filter(Boolean).join(" ")));
  if (!item) return false;
  item.click();
  return true;
}

function hideNativeCliNavigation(doc) {
  // The official App has changed its Vue navigation markup several times.
  // Do not depend on a particular sidebar wrapper: hide the complete clickable
  // CLI item wherever its label or terminal icon is rendered.
  const items = [
    ...sidebarNavigationNodes(doc),
    ...doc.querySelectorAll("button, a, [role='menuitem'], [role='button']"),
  ];
  const hidden = new Set();
  for (const icon of doc.querySelectorAll(".i-lucide-terminal, .i-lucide-square-terminal, [class*='lucide-terminal'], svg[data-lucide='terminal'], svg[data-lucide='square-terminal']")) {
    const item = icon.closest("button, a, [role='menuitem'], [role='button'], li, [data-key='cli'], [data-value='cli']");
    if (item) hidden.add(item);
  }
  for (const item of items) {
    const label = [item.textContent, item.getAttribute("aria-label"), item.getAttribute("title")]
      .filter(Boolean)
      .join(" ");
    if (/\bcli\b|命令行|命令列|command\s*line/i.test(label)) {
      hidden.add(item);
    }
  }
  for (const item of hidden) {
    item.style.display = "none";
    item.setAttribute("data-fleet-agent-cli-hidden", "true");
  }
}

async function submitCliCommand(input, command) {
  const frameWindow = input.ownerDocument.defaultView;
  input.focus();
  input.value = command;
  input.dispatchEvent(new frameWindow.Event("input", { bubbles: true }));
  await wait(0);
  const event = new frameWindow.KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  // Vue's legacy handler uses event.which. Chromium exposes it as read-only,
  // but it can be provided on a synthetic event for this same-origin bridge.
  Object.defineProperty(event, "which", { value: 13 });
  input.dispatchEvent(event);
}

function readNativeCliText(output) {
  const chunks = [];
  const blockTags = new Set(["DIV", "P", "LI", "PRE"]);

  const visit = (node) => {
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === "BR") {
      chunks.push("\n");
      return;
    }

    const isBlock = blockTags.has(node.tagName);
    const startLength = chunks.length;
    node.childNodes.forEach(visit);
    if (isBlock && chunks.length > startLength && !String(chunks.at(-1)).endsWith("\n")) {
      chunks.push("\n");
    }
  };

  output.childNodes.forEach(visit);
  return chunks.join("").replace(/\u00a0/g, " ");
}

async function readNativeCliOutput(output, beforeText, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const frameWindow = output.ownerDocument.defaultView;
    let changed = false;
    let lastChangeAt = Date.now();
    const observer = new frameWindow.MutationObserver(() => {
      if (readNativeCliText(output) !== beforeText) {
        changed = true;
        lastChangeAt = Date.now();
      }
    });
    const timer = frameWindow.setInterval(() => {
      if (changed && Date.now() - lastChangeAt >= 1_200) {
        cleanup();
        const currentText = readNativeCliText(output);
        resolve((currentText.startsWith(beforeText) ? currentText.slice(beforeText.length) : currentText).trim());
      } else if (Date.now() - startedAt >= timeoutMs) {
        cleanup();
        reject(new Error("BF 原生 CLI 在规定时间内没有完成 diff all"));
      }
    }, 200);
    const startedAt = Date.now();
    const cleanup = () => {
      observer.disconnect();
      frameWindow.clearInterval(timer);
    };
    observer.observe(output, { childList: true, subtree: true, characterData: true });
  });
}

async function enterNativeCli(iframe) {
  const { doc } = frameContext(iframe);
  if (!doc.querySelector(".tab-cli") && !clickSidebarItem(doc, /\bcli\b|命令行|命令列|command\s*line/i, "terminal")) {
    throw new Error("BF 页面未找到原生 CLI 入口；请升级 Agent 兼容规则后重试");
  }
  const input = await waitForElement(doc, ".tab-cli textarea[name='commands']", 12_000);
  const output = await waitForElement(doc, ".tab-cli .cli-wrapper", 12_000);

  // The official CLI tab sends '#' shortly after mounting. Wait for its prompt
  // before submitting so legacy firmware receives a normal raw-serial command.
  const promptDeadline = Date.now() + 8_000;
  while (Date.now() < promptDeadline && !readNativeCliText(output).includes("#")) {
    await wait(100);
  }
  if (!readNativeCliText(output).includes("#")) {
    throw new Error("BF 原生 CLI 未进入就绪状态");
  }

  return { doc, input, output };
}

async function runNativeCliCommand(iframe, command) {
  const { output } = await enterNativeCli(iframe);
  const input = await waitForElement(output.ownerDocument, ".tab-cli textarea[name='commands']", 1_000);
  const beforeText = readNativeCliText(output);
  await submitCliCommand(input, command);
  return readNativeCliOutput(output, beforeText);
}

function exitNativeCli(iframe) {
  const { doc } = frameContext(iframe);
  if (doc.querySelector(".tab-cli")) {
    clickSidebarItem(doc, /\bsetup\b|设置|配置/i, "sliders-horizontal");
  }
}

function hasConnectedController(state) {
  return Boolean(
    state.connected
    && (state.deviceUid || state.boardIdentifier || state.boardName || state.firmwareVersion),
  );
}

async function waitForBetaflightConnectionState(iframe, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = readBetaflightState(iframe);
      if (expected ? hasConnectedController(state) : !state.connected) return state;
    } catch {
      // BF briefly tears down and rebuilds its Vue state while reconnecting.
    }
    await wait(120);
  }
  throw new Error(expected ? "BF 未能重新连接飞控" : "BF 未能释放飞控串口");
}

async function reconnectBetaflightWhenReady(iframe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastClickAt = 0;
  while (Date.now() < deadline) {
    try {
      const state = readBetaflightState(iframe);
      if (hasConnectedController(state)) return state;

      const { doc } = frameContext(iframe);
      const connectButton = doc.querySelector(".sidebar-connect__main");
      if (connectButton && !connectButton.disabled && Date.now() - lastClickAt >= 2_500) {
        connectButton.click();
        lastClickAt = Date.now();
      }
    } catch {
      // Port discovery and the BF Vue tree can both be transient here.
    }
    await wait(150);
  }
  throw new Error("BF 未能重新连接飞控");
}

async function waitForNativeCliReturn(iframe, timeoutMs = 20_000, previousTimestamp = null) {
  const deadline = Date.now() + timeoutMs;
  let sawDisconnected = false;
  while (Date.now() < deadline) {
    try {
      const { doc } = frameContext(iframe);
      const state = readBetaflightState(iframe);
      if (!state.connected) sawDisconnected = true;
      const connectionWasRebuilt = (
        !previousTimestamp
        || sawDisconnected
        || (state.timestamp && state.timestamp !== previousTimestamp)
      );
      if (!doc.querySelector(".tab-cli") && hasConnectedController(state) && connectionWasRebuilt) {
        await wait(500);
        return;
      }
    } catch {
      // BF briefly tears down and rebuilds its connection after leaving CLI.
    }
    await wait(120);
  }
  throw new Error("BF 退出 CLI 后未能恢复调参连接");
}

async function leaveNativeCliAndRestoreConnection(iframe) {
  const { doc } = frameContext(iframe);
  const input = doc.querySelector(".tab-cli textarea[name='commands']");
  const previousTimestamp = readBetaflightState(iframe).timestamp;

  // Do not depend on the Setup navigation being available while CLI is active.
  // Return the controller to MSP mode first, then let BF run its normal CLI
  // cleanup by selecting Setup.
  if (input) {
    await submitCliCommand(input, "exit");
    await wait(650);
  }
  exitNativeCli(iframe);

  try {
    await waitForNativeCliReturn(iframe, 5_000, previousTimestamp);
    return;
  } catch {
    // Some legacy targets leave BF's UI in CLI after accepting `exit`. Reset
    // only BF's serial lifecycle; the already-authorized port is reused.
  }

  let state = readBetaflightState(iframe);
  if (state.connected) {
    triggerBetaflightDisconnect(iframe);
    await waitForBetaflightConnectionState(iframe, false, 10_000);
  }

  await wait(350);
  state = await reconnectBetaflightWhenReady(iframe, 20_000);
  if (!hasConnectedController(state)) {
    throw new Error("BF 重连后未能读取飞控信息");
  }

  // BF may remember CLI as its last tab. Switch to Setup after its connected
  // navigation has been rebuilt so ordinary tuning is visible again.
  const setupDeadline = Date.now() + 8_000;
  while (Date.now() < setupDeadline) {
    const { doc: currentDocument } = frameContext(iframe);
    if (!currentDocument.querySelector(".tab-cli")) break;
    exitNativeCli(iframe);
    await wait(250);
  }
  await waitForNativeCliReturn(iframe, 8_000);
}

async function leaveNativeCliAndDisconnect(iframe) {
  const { doc } = frameContext(iframe);
  const input = doc.querySelector(".tab-cli textarea[name='commands']");
  if (input) {
    await submitCliCommand(input, "exit");
    await wait(400);
  }
  if (readBetaflightState(iframe).connected) {
    triggerBetaflightDisconnect(iframe);
    await waitForBetaflightConnectionState(iframe, false, 10_000);
  }
}

async function captureWithNativeCli(iframe, { disconnectAfterCapture = false } = {}) {
  const content = await runNativeCliCommand(iframe, "diff all");
  let vtxTable = "";
  try {
    vtxTable = await runNativeCliCommand(iframe, "vtxtable");
  } catch {
    // Older firmware without configurable VTX tables can still be archived.
  }
  const normalized = normalizeSnapshotContent([
    content,
    /\bvtxtable\s+band\s+\d+/i.test(vtxTable)
      ? `# agent-vtxtable-begin\n${vtxTable}\n# agent-vtxtable-end`
      : "",
  ].filter(Boolean).join("\n"));
  if (!normalized || !/\b(set|feature|resource|serial|aux|profile|rateprofile)\b/i.test(normalized)) {
    throw new Error("BF 原生 CLI 未返回可用配置");
  }
  await wait(250);
  if (disconnectAfterCapture) await leaveNativeCliAndDisconnect(iframe);
  else await leaveNativeCliAndRestoreConnection(iframe);
  return normalized;
}

function frameContext(iframe) {
  if (!iframe?.contentWindow) throw new Error("Betaflight 尚未载入");
  try {
    return {
      win: iframe.contentWindow,
      doc: iframe.contentDocument || iframe.contentWindow.document,
    };
  } catch {
    throw new Error("Betaflight 必须与地面站同源部署");
  }
}

function cleanLine(line) {
  return String(line || "")
    .split(String.fromCharCode(0)).join("")
    .replace(/\r/g, "")
    .trimEnd();
}

function normalizeCliOutput(lines) {
  return (Array.isArray(lines) ? lines : [lines])
    .map(cleanLine)
    .filter((line) => line && !/^Entering CLI Mode/i.test(line))
    .join("\n")
    .trim();
}

function normalizeSnapshotContent(content) {
  return String(content || "")
    .split("\n")
    .map(cleanLine)
    .filter((line) => !/^#?\s*diff\s+all\s*$/i.test(line))
    .filter((line) => !/^#?\s*vtxtable\s*$/i.test(line))
    .filter((line) => line !== "#")
    .join("\n")
    .trim();
}

function cliErrorMessage(error) {
  return error?.message || String(error || "CLI 命令执行失败");
}

function queueBetaflightSave(iframe) {
  const { win } = frameContext(iframe);
  const msp = win.vm?.MSP;
  if (typeof msp?.send_cli_command !== "function") {
    throw new Error("飞控已断开，配置尚未保存，请重新连接后再写入");
  }
  // `save` reboots the controller and normally closes the serial link before a
  // response arrives, so the callback is not awaited. Surface only the
  // synchronous dispatch failure; the expected link drop after a queued save is
  // handled by the reconnect flow, not treated as a failed write.
  msp.send_cli_command("save", () => {}, { timeoutMs: 12_000 });
}

export function customizeBetaflightFrame(iframe) {
  const { win, doc } = frameContext(iframe);

  let style = doc.getElementById(BRIDGE_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = BRIDGE_STYLE_ID;
    style.textContent = `
      /* The fleet Agent is the only visible entry point for connection control. */
      .sidebar-connect { display: none !important; }
      /* Cover both current Nuxt UI and older BF navigation markup. */
      .sidebar-nav > *:has(.i-lucide-terminal),
      .sidebar-nav > *:has(.i-lucide-square-terminal),
      .sidebar-nav li:has(.i-lucide-terminal),
      .sidebar-nav li:has(.i-lucide-square-terminal),
      .sidebar-nav [role='menuitem']:has(.i-lucide-terminal),
      .sidebar-nav [role='menuitem']:has(.i-lucide-square-terminal),
      .sidebar-nav [aria-label*='CLI' i],
      .sidebar-nav [aria-label*='命令行'],
      .sidebar-nav [title*='CLI' i],
      .sidebar-nav [title*='命令行'],
      [data-key='cli'], [data-value='cli'] { display: none !important; }
      ${EXTERNAL_LINK_SELECTOR},
      #button-documentation { display: none !important; }
    `;
    doc.head.appendChild(style);
  }

  if (!win.__fleetGroundStationExternalLinkGuard) {
    const guard = (event) => {
      const anchor = event.target?.closest?.(EXTERNAL_LINK_SELECTOR);
      if (!anchor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    doc.addEventListener("click", guard, true);
    win.__fleetGroundStationExternalLinkGuard = guard;
  }
  hideNativeCliNavigation(doc);
  if (!win.__fleetGroundStationCliObserver && doc.body) {
    const observer = new win.MutationObserver(() => hideNativeCliNavigation(doc));
    observer.observe(doc.body, { childList: true, subtree: true });
    win.__fleetGroundStationCliObserver = observer;
  }
}

export async function enterBetaflightAgentCli(iframe) {
  await enterNativeCli(iframe);
}

export async function runBetaflightAgentCliCommand(iframe, command) {
  const value = String(command || "").trim();
  if (!value) throw new Error("请输入 CLI 命令");
  return runNativeCliCommand(iframe, value);
}

export async function exitBetaflightAgentCli(iframe) {
  await leaveNativeCliAndRestoreConnection(iframe);
}

export function readBetaflightState(iframe) {
  const { win } = frameContext(iframe);
  const vm = win.vm;
  const config = vm?.FC?.CONFIG || {};
  const vtx = vm?.FC?.VTX_CONFIG || {};
  const connected = Boolean(vm?.CONNECTION?.timestamp);
  // Canonical fleet target: the target shown after "/" in BF firmware info.
  const targetName = String(config.boardName || config.targetName || config.boardIdentifier || "");

  return {
    ready: Boolean(vm?.FC && vm?.MSP),
    connected,
    timestamp: vm?.CONNECTION?.timestamp || null,
    deviceUid: String(config.deviceIdentifier || ""),
    boardIdentifier: targetName,
    boardName: targetName,
    firmwareVariant: String(config.flightControllerIdentifier || ""),
    firmwareVersion: String(config.flightControllerVersion || ""),
    apiVersion: String(config.apiVersion || ""),
    craftName: String(config.craftName || config.name || ""),
    vtxBand: Number(vtx.vtx_band) || "",
    vtxChannel: Number(vtx.vtx_channel) || "",
    vtxPower: Number(vtx.vtx_power) || "",
  };
}

export function triggerBetaflightConnection(iframe) {
  const { doc } = frameContext(iframe);
  const connectButton = doc.querySelector(".sidebar-connect__main, a.connect");
  if (!connectButton) throw new Error("BF 连接入口尚未就绪");
  connectButton.click();
}

export function triggerBetaflightDisconnect(iframe) {
  const { doc } = frameContext(iframe);
  const disconnectButton = doc.querySelector(".sidebar-connect > button, a.connect");
  if (!disconnectButton) throw new Error("BF 断开入口尚未就绪");
  disconnectButton.click();
}

export function sendBetaflightCli(iframe, command, timeoutMs = 15_000) {
  const { win } = frameContext(iframe);
  const msp = win.vm?.MSP;
  if (!win.vm?.CONNECTION?.timestamp) throw new Error("请先连接飞控");
  if (typeof msp?.send_cli_command !== "function") throw new Error("当前 BF 镜像不支持 Agent CLI");

  return new Promise((resolve, reject) => {
    msp.send_cli_command(
      command,
      (lines, error) => {
        if (error) reject(new Error(cliErrorMessage(error)));
        else resolve(normalizeCliOutput(lines));
      },
      { timeoutMs },
    );
  });
}

export async function captureBetaflightConfiguration(
  iframe,
  { onCliFallback, disconnectAfterCapture = false } = {},
) {
  const state = readBetaflightState(iframe);
  if (!state.firmwareVersion || !supportsMspCli(state.firmwareVersion)) {
    if (onCliFallback) return onCliFallback();
    return captureWithNativeCli(iframe, { disconnectAfterCapture });
  }

  // CONNECTION.timestamp is assigned before BF finishes its startup MSP reads.
  // Sending a CLI request immediately races that initialization on some boards.
  await wait(2_500);
  try {
    const diff = await sendBetaflightCli(iframe, "diff all", SNAPSHOT_TIMEOUT_MS);
    let vtxTable = "";
    try {
      vtxTable = await sendBetaflightCli(iframe, "vtxtable", 15_000);
    } catch {
      // VTX tables are optional on older targets.
    }
    const content = normalizeSnapshotContent([
      diff,
      /\bvtxtable\s+band\s+\d+/i.test(vtxTable)
        ? `# agent-vtxtable-begin\n${vtxTable}\n# agent-vtxtable-end`
        : "",
    ].filter(Boolean).join("\n"));
    if (!content) throw new Error("飞控未返回配置");
    return content;
  } catch (error) {
    if (isTimeout(error)) {
      if (onCliFallback) return onCliFallback();
      return captureWithNativeCli(iframe, { disconnectAfterCapture });
    }
    throw error;
  }
}

function validateInteger(value, label, minimum, maximum) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label}必须是 ${minimum}–${maximum} 的整数`);
  }
  return number;
}

export async function applyBetaflightQuickSettings(iframe, settings) {
  const commands = [];
  const craftName = String(settings.craftName || "").trim();
  if (craftName) {
    if (!/^[A-Za-z0-9 _.-]{1,32}$/.test(craftName)) {
      throw new Error("飞行器名称限 1–32 位字母、数字、空格、点、横线或下划线");
    }
    const requestedField = String(settings.craftNameField || "craftname").trim();
    const craftNameField = /^[a-z0-9_]+$/i.test(requestedField) ? requestedField : "craftname";
    commands.push(`set ${craftNameField} = ${craftName}`);
  }

  const band = validateInteger(settings.vtxBand, "图传频段", 1, 8);
  const channel = validateInteger(settings.vtxChannel, "图传频道", 1, 8);
  const power = validateInteger(settings.vtxPower, "图传功率档", 1, 8);
  if (band !== null) commands.push(`set vtx_band = ${band}`);
  if (channel !== null) commands.push(`set vtx_channel = ${channel}`);
  if (power !== null) commands.push(`set vtx_power = ${power}`);
  if (!commands.length) throw new Error("没有需要修改的项目");

  for (const command of commands) {
    await sendBetaflightCli(iframe, command);
  }

  // `save` reboots the controller and normally closes the serial link before a
  // response arrives. Once queued successfully, the expected link drop is not
  // treated as a failed setting operation.
  queueBetaflightSave(iframe);
  return commands;
}

export function extractBetaflightPresetCommands(content) {
  const allowedCommand = /^(set|feature|beeper|map|mixer|mmix|smix|servo|resource|timer|dma|serial|led|color|mode_color|aux|adjrange|rxrange|rxfail|vtxtable|vtx|profile|rateprofile)\b/i;
  return String(content || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => allowedCommand.test(line));
}

export async function applyBetaflightPreset(iframe, content) {
  const commands = extractBetaflightPresetCommands(content);
  if (!commands.length) throw new Error("这个预设没有可写入的 Betaflight 配置");

  for (const command of commands) {
    await sendBetaflightCli(iframe, command, 30_000);
  }

  queueBetaflightSave(iframe);
  return commands.length;
}
