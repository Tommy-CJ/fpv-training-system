import { listUnclaimedAuthorizedSerialPorts } from "../serialPortClaim.js";

const DEFAULT_BAUD_RATE = 115200;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function serialUnsupported() {
  return !("serial" in navigator);
}

function endsWithCliPrompt(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) return lines[index].trim() === "#";
  }
  return false;
}

/**
 * A deliberately small raw-serial CLI client.  It is used only while the
 * embedded Betaflight App has released the port, so the two applications
 * never read from the flight controller at the same time.
 */
export class AgentCliSession {
  constructor({ onOutput = () => {} } = {}) {
    this.onOutput = onOutput;
    this.port = null;
    this.reader = null;
    this.reading = false;
    this.readLoopPromise = null;
    this.output = "";
  }

  get isOpen() {
    return Boolean(this.port?.readable && this.port?.writable);
  }

  async open() {
    if (serialUnsupported()) {
      throw new Error("当前浏览器不支持 Web Serial；请使用桌面版 Chrome 或 Edge");
    }
    if (this.isOpen) return;

    const ports = await listUnclaimedAuthorizedSerialPorts();
    if (!ports.length) {
      throw new Error("Agent 没有可用的飞控串口；训练接收阵列已被自动排除，请先在 BF 中明确选择飞控");
    }
    if (ports.length > 1) {
      throw new Error("检测到多个可用飞控串口，无法自动判断目标；请在 BF 中只连接当前飞控后再进入 CLI");
    }

    this.port = ports[0];
    const deadline = Date.now() + 8_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.port.open({ baudRate: DEFAULT_BAUD_RATE, bufferSize: 65_536 });
        break;
      } catch (error) {
        lastError = error;
        await wait(180);
      }
    }
    if (!this.port.readable || !this.port.writable) {
      this.port = null;
      throw new Error(`无法接管飞控串口：${lastError?.message || "端口仍被占用"}`);
    }

    try {
      this.output = "";
      this.reading = true;
      this.readLoopPromise = this.readLoop();

      // The official BF CLI waits 250 ms after the serial reader is installed
      // before it sends '#'.  Older boards frequently discard an earlier byte
      // while their USB serial endpoint is still settling after a reconnect.
      await wait(350);
      let entered = false;
      for (let attempt = 0; attempt < 3 && !entered; attempt += 1) {
        const start = this.output.length;
        await this.write("#");
        entered = await this.waitForPrompt(3_000, start);
        if (!entered) await wait(300);
      }
      if (!entered) {
        throw new Error("飞控没有进入 CLI 模式；串口已释放但未收到 # 提示符");
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async write(value) {
    if (!this.port?.writable) throw new Error("Agent CLI 串口尚未连接");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(value));
    } finally {
      writer.releaseLock();
    }
  }

  async command(command, timeoutMs = 75_000) {
    const value = String(command || "").trim();
    if (!value) throw new Error("请输入 CLI 命令");
    const start = this.output.length;
    await this.write(`${value}\r`);
    const completed = await this.waitForPrompt(timeoutMs, start);
    if (!completed) {
      throw new Error(`CLI 命令在规定时间内没有完成：${value}`);
    }
    return this.output.slice(start).trim();
  }

  async executeCommandsFast(commands, {
    lineDelayMs = 15,
    profileDelayMs = 100,
    timeoutMs = 90_000,
    onProgress = () => {},
  } = {}) {
    const lines = (Array.isArray(commands) ? commands : [])
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    if (!lines.length) throw new Error("没有可执行的 CLI 命令");
    const startedAt = Date.now();
    const outputStart = this.output.length;

    for (let index = 0; index < lines.length; index += 1) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`CLI 批量写入超时：${index}/${lines.length}`);
      }
      const line = lines[index];
      await this.write(`${line}\r`);

      // Match Betaflight Configurator's CliEngine: queue lines back-to-back
      // with a short pacing gap. The caller sends `save` after the queue is
      // flushed, so waiting for another prompt here only delays and can hang.
      await wait(/^rate?profile\b/i.test(line) ? profileDelayMs : lineDelayMs);
      onProgress(index + 1, lines.length, line);
    }

    return this.output.slice(outputStart).trim();
  }

  async waitForPrompt(timeoutMs, start = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const received = this.output.slice(start);
      // Prompt is emitted at the end of a completed CLI command. Checking the
      // final non-empty line avoids mistaking a commented `#` in `diff all`
      // for completion.
      if (endsWithCliPrompt(received)) return true;
      await wait(80);
    }
    return false;
  }

  async readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this.reading && this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (this.reading) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (!value?.length) continue;
            const text = decoder.decode(value, { stream: true });
            if (text) {
              this.output += text;
              this.onOutput(text);
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      if (this.reading) throw error;
    }
  }

  async close() {
    this.reading = false;
    try {
      await this.reader?.cancel();
    } catch {
      // The reader may already have been released by a board reboot.
    }
    try {
      await this.readLoopPromise;
    } catch {
      // The caller gets command/open errors; close must always release the port.
    }
    try {
      await this.port?.close();
    } catch {
      // A rebooted or unplugged board can reject close().
    }
    this.reader = null;
    this.readLoopPromise = null;
    this.port = null;
  }
}
