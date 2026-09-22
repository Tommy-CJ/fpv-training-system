const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  NAME: 10,
  UID: 160,
};

function ascii(bytes) {
  return new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim();
}

function version(bytes) {
  return [...bytes.slice(0, 3)].map(Number).join(".");
}

function uid(bytes) {
  if (bytes.length >= 12) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [0, 4, 8].map((offset) => view.getUint32(offset, true).toString(16).padStart(8, "0")).join("");
  }
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function makeMspV1Request(command, payload = new Uint8Array()) {
  if (payload.length > 255 || command > 254) throw new Error("MSP v1 请求超出支持范围");
  const frame = new Uint8Array(6 + payload.length);
  frame.set([36, 77, 60, payload.length, command], 0); // $M<
  frame.set(payload, 5);
  let checksum = payload.length ^ command;
  payload.forEach((value) => { checksum ^= value; });
  frame[frame.length - 1] = checksum;
  return frame;
}

export class MspSerialAgent {
  constructor({ onState, onError } = {}) {
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.port = null;
    this.reader = null;
    this.reading = false;
    this.buffer = new Uint8Array();
    this.pending = new Map();
  }

  emit(state) {
    this.onState(state);
  }

  async connect() {
    if (!("serial" in navigator)) throw new Error("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge");
    if (this.port) await this.disconnect();
    this.emit({ phase: "requesting", message: "等待选择飞控串口" });
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200, bufferSize: 65536 });
    this.reading = true;
    this.readLoopPromise = this.readLoop();
    this.emit({ phase: "identifying", message: "正在通过 MSP 识别飞控" });

    try {
      const apiBytes = await this.request(MSP.API_VERSION);
      const variantBytes = await this.request(MSP.FC_VARIANT);
      const firmwareBytes = await this.request(MSP.FC_VERSION);
      const boardBytes = await this.request(MSP.BOARD_INFO);
      const uidBytes = await this.request(MSP.UID);
      let nameBytes = new Uint8Array();
      try {
        nameBytes = await this.request(MSP.NAME, new Uint8Array(), 1200);
      } catch {
        // Craft name is optional and unsupported by some older firmware.
      }

      const info = this.port.getInfo?.() || {};
      const identity = {
        deviceUid: uid(uidBytes),
        apiVersion: apiBytes.length >= 3 ? `${apiBytes[1]}.${apiBytes[2]}` : "",
        firmwareVariant: ascii(variantBytes.slice(0, 4)),
        firmwareVersion: version(firmwareBytes),
        boardIdentifier: ascii(boardBytes.slice(0, 4)),
        boardName: ascii(nameBytes) || ascii(boardBytes.slice(0, 4)),
        usbVendorId: info.usbVendorId ?? null,
        usbProductId: info.usbProductId ?? null,
      };
      this.emit({ phase: "connected", message: "飞控已连接", identity });
      return identity;
    } catch (error) {
      await this.disconnect();
      throw new Error(`飞控 MSP 识别失败：${error.message}`, { cause: error });
    }
  }

  async request(command, payload = new Uint8Array(), timeoutMs = 2500) {
    if (!this.port?.writable) throw new Error("串口尚未连接");
    const response = new Promise((resolve, reject) => {
      const queue = this.pending.get(command) || [];
      const entry = {};
      const timer = window.setTimeout(() => {
        const current = this.pending.get(command) || [];
        const remaining = current.filter((item) => item !== entry);
        if (remaining.length) this.pending.set(command, remaining);
        else this.pending.delete(command);
        reject(new Error(`MSP ${command} 响应超时`));
      }, timeoutMs);
      entry.resolve = (value) => {
        window.clearTimeout(timer);
        resolve(value);
      };
      entry.reject = (error) => {
        window.clearTimeout(timer);
        reject(error);
      };
      queue.push(entry);
      this.pending.set(command, queue);
    });

    const writer = this.port.writable.getWriter();
    try {
      await writer.write(makeMspV1Request(command, payload));
    } finally {
      writer.releaseLock();
    }
    return response;
  }

  async readLoop() {
    try {
      while (this.reading && this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          while (this.reading) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.consume(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      if (this.reading) {
        this.onError(error);
        this.emit({ phase: "error", message: `串口读取异常：${error.message}` });
      }
    }
  }

  consume(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= 6) {
      let start = -1;
      for (let index = 0; index <= this.buffer.length - 3; index += 1) {
        if (this.buffer[index] === 36 && this.buffer[index + 1] === 77 && [33, 62].includes(this.buffer[index + 2])) {
          start = index;
          break;
        }
      }
      if (start < 0) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 2));
        return;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 6) return;

      const failed = this.buffer[2] === 33;
      const length = this.buffer[3];
      const command = this.buffer[4];
      const frameLength = 6 + length;
      if (this.buffer.length < frameLength) return;
      const payload = this.buffer.slice(5, 5 + length);
      const receivedChecksum = this.buffer[frameLength - 1];
      let checksum = length ^ command;
      payload.forEach((value) => { checksum ^= value; });
      this.buffer = this.buffer.slice(frameLength);
      if (checksum !== receivedChecksum) continue;

      const queue = this.pending.get(command) || [];
      const pending = queue.shift();
      if (queue.length) this.pending.set(command, queue);
      else this.pending.delete(command);
      if (!pending) continue;
      if (failed) pending.reject(new Error(`飞控拒绝 MSP ${command}`));
      else pending.resolve(payload);
    }
  }

  async disconnect() {
    this.reading = false;
    for (const queue of this.pending.values()) {
      queue.forEach(({ reject }) => reject(new Error("串口已断开")));
    }
    this.pending.clear();
    try {
      await this.reader?.cancel();
    } catch {
      // Reader may already be closed by the device.
    }
    try {
      await this.readLoopPromise;
    } catch {
      // readLoop reports unexpected failures through onError.
    }
    try {
      await this.port?.close();
    } catch {
      // A physically disconnected device can reject close().
    }
    this.reader = null;
    this.readLoopPromise = null;
    this.port = null;
    this.buffer = new Uint8Array();
    this.emit({ phase: "idle", message: "尚未连接飞控" });
  }
}
