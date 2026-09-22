import { webSerialDevices } from "./serial_devices";

const trainingSerialClaimKey = "fpv-training-active-serial-port-v1";
const betaflightSerialClaimKey = "fpv-betaflight-active-serial-port-v1";
const trainingSerialClaimTtlMs = 5000;

function portDescriptor(port, ports = []) {
    const info = port?.getInfo?.() || {};
    const usbVendorId = Number(info.usbVendorId) || 0;
    const usbProductId = Number(info.usbProductId) || 0;
    const matchingPorts = ports.filter((candidate) => {
        const candidateInfo = candidate?.getInfo?.() || {};
        return (Number(candidateInfo.usbVendorId) || 0) === usbVendorId
            && (Number(candidateInfo.usbProductId) || 0) === usbProductId;
    });
    return {
        usbVendorId,
        usbProductId,
        ordinal: Math.max(0, matchingPorts.indexOf(port)),
    };
}

function readTrainingSerialClaim(now = Date.now()) {
    try {
        const claim = JSON.parse(window.localStorage.getItem(trainingSerialClaimKey) || "null");
        if (!claim?.ownerId || now - Number(claim.updatedAt || 0) > trainingSerialClaimTtlMs) return null;
        return claim;
    } catch {
        return null;
    }
}

function isTrainingSerialPort(port, ports = []) {
    const claim = readTrainingSerialClaim();
    if (!claim || !port) return false;
    const descriptor = portDescriptor(port, ports);
    return descriptor.usbVendorId === Number(claim.usbVendorId)
        && descriptor.usbProductId === Number(claim.usbProductId)
        && descriptor.ordinal === Number(claim.ordinal);
}

async function writeBetaflightSerialClaim(port, ownerId) {
    if (!port || !ownerId) return;
    try {
        const ports = await navigator.serial.getPorts();
        window.localStorage.setItem(betaflightSerialClaimKey, JSON.stringify({
            ...portDescriptor(port, ports),
            ownerId,
            updatedAt: Date.now(),
        }));
    } catch (error) {
        console.warn("SERIAL: Unable to publish Betaflight serial ownership", error);
    }
}

function releaseBetaflightSerialClaim(ownerId) {
    try {
        const claim = JSON.parse(window.localStorage.getItem(betaflightSerialClaimKey) || "null");
        if (!claim || claim.ownerId === ownerId) window.localStorage.removeItem(betaflightSerialClaimKey);
    } catch {
        // Storage may be unavailable in hardened browser profiles.
    }
}

async function* streamAsyncIterable(reader, keepReadingFlag) {
    try {
        while (keepReadingFlag()) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    } finally {
        try {
            reader.releaseLock();
        } catch (error) {
            console.warn("SERIAL: Failed to release reader lock", error);
        }
    }
}

class WebSerial extends EventTarget {
    constructor() {
        super();
        this.connected = false;
        this.openRequested = false;
        this.openCanceled = false;
        this.transmitting = false;
        this.connectionInfo = null;

        this.bitrate = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.failed = 0;

        this.logHead = "SERIAL: ";

        this.port = null;
        this.reader = null;
        this.writer = null;
        this.reading = false;
        this.hadAuthorizedConnection = false;
        this.claimTimer = null;
        this.claimOwnerId = typeof window.crypto?.randomUUID === "function"
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`;

        this.connect = this.connect.bind(this);
        this.handlePageHide = this.handlePageHide.bind(this);
        window.addEventListener("pagehide", this.handlePageHide);
    }

    handleReceiveBytes(info) {
        this.bytesReceived += info.detail.byteLength;
    }

    handleDisconnect() {
        this.removeEventListener('receive', this.handleReceiveBytes);
        this.removeEventListener('disconnect', this.handleDisconnect);
    }

    handlePageHide() {
        this.stopSerialClaim();
    }

    async startSerialClaim(port) {
        this.stopSerialClaim();
        await writeBetaflightSerialClaim(port, this.claimOwnerId);
        this.claimTimer = window.setInterval(() => {
            if (this.connected && this.port === port) {
                void writeBetaflightSerialClaim(port, this.claimOwnerId);
            }
        }, 2000);
    }

    stopSerialClaim() {
        if (this.claimTimer !== null) window.clearInterval(this.claimTimer);
        this.claimTimer = null;
        releaseBetaflightSerialClaim(this.claimOwnerId);
    }

    async confirmFlightController() {
        if (this.connected && this.port) await this.startSerialClaim(this.port);
    }

    async connect(options) {
        this.openRequested = true;
        const authorizedPorts = await navigator.serial.getPorts();
        const availablePorts = authorizedPorts.filter((port) => !isTrainingSerialPort(port, authorizedPorts));
        this.port = availablePorts.find((port) => {
            const info = port.getInfo();
            return webSerialDevices.some(
                (device) => device.usbVendorId === info.usbVendorId
                    && device.usbProductId === info.usbProductId,
            );
        }) || availablePorts[0] || null;

        // During a controller reboot the authorized port can temporarily vanish
        // from getPorts(). Do not open a chooser in that window: report a failed
        // automatic attempt and let the Agent retry after USB re-enumeration.
        if (!this.port && this.hadAuthorizedConnection) {
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return;
        }

        // A fleet kernel handoff already has permission for this origin. Reuse
        // that port so automatic fallback does not need another user gesture.
        if (!this.port) {
            try {
                this.port = await navigator.serial.requestPort({
                    filters: webSerialDevices,
                });
            } catch (error) {
                console.info(`${this.logHead}Serial chooser was cancelled`, error);
                this.port = null;
                this.openRequested = false;
                this.openCanceled = false;
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return;
            }
            const refreshedPorts = await navigator.serial.getPorts();
            if (isTrainingSerialPort(this.port, refreshedPorts)) {
                console.error(`${this.logHead}Refusing to open the active training receiver array`);
                this.port = null;
                this.openRequested = false;
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return;
            }
        }

        try {
            await this.port.open(options);
        } catch (error) {
            console.error(`${this.logHead}Failed to open serial port`, error);
            this.port = null;
            this.reader = null;
            this.writer = null;
            this.connectionInfo = null;
            this.openRequested = false;
            this.openCanceled = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return;
        }
        let connectionInfo;
        try {
            connectionInfo = this.port.getInfo();
            this.connectionInfo = connectionInfo;
            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();
        } catch (error) {
            console.error(`${this.logHead}Failed to initialize serial streams`, error);
            await this.releasePortResources();
            this.connectionInfo = null;
            this.openRequested = false;
            this.openCanceled = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return;
        }

        if (connectionInfo && !this.openCanceled) {
            this.connected = true;
            this.hadAuthorizedConnection = true;
            this.connectionId = connectionInfo.connectionId;
            this.bitrate = options.baudrate;
            this.bytesReceived = 0;
            this.bytesSent = 0;
            this.failed = 0;
            this.openRequested = false;
            this.addEventListener("receive", this.handleReceiveBytes);
            this.addEventListener('disconnect', this.handleDisconnect);

            console.log(
                `${this.logHead} Connection opened with ID: ${connectionInfo.connectionId}, Baud: ${options.baudRate}`,
            );

            this.dispatchEvent(
                new CustomEvent("connect", { detail: connectionInfo }),
            );
            // Check if we need the helper function or could polyfill
            // the stream async iterable interface:
            // https://web.dev/streams/#asynchronous-iteration


            this.reading = true;
            try {
                for await (let value of streamAsyncIterable(this.reader, () => this.reading)) {
                    this.dispatchEvent(
                        new CustomEvent("receive", { detail: value }),
                    );
                }
            } catch (error) {
                console.error(`${this.logHead}Serial read failed`, error);
                if (this.connected) await this.disconnect();
            }
        } else if (connectionInfo && this.openCanceled) {
            this.connectionId = connectionInfo.connectionId;

            console.log(
                `${this.logHead} Connection opened with ID: ${connectionInfo.connectionId}, but request was canceled, disconnecting`,
            );
            // some bluetooth dongles/dongle drivers really doesn't like to be closed instantly, adding a small delay
            setTimeout(async () => {
                this.openRequested = false;
                this.openCanceled = false;
                await this.disconnect();
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            }, 150);
        } else if (this.openCanceled) {
            console.log(
                `${this.logHead} Connection didn't open and request was canceled`,
            );
            this.openRequested = false;
            this.openCanceled = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
        } else {
            this.openRequested = false;
            console.log(`${this.logHead} Failed to open serial port`);
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
        }
    }

    async releasePortResources() {
        const reader = this.reader;
        const writer = this.writer;
        const port = this.port;
        this.reader = null;
        this.writer = null;
        this.port = null;

        if (reader) {
            try {
                await reader.cancel();
            } catch (error) {
                console.warn(`${this.logHead}Reader cancel error`, error);
            }
            try {
                reader.releaseLock();
            } catch (error) {
                console.warn(`${this.logHead}Reader release error`, error);
            }
        }
        if (writer) {
            try {
                writer.releaseLock();
            } catch (error) {
                console.warn(`${this.logHead}Writer release error`, error);
            }
        }
        if (port) {
            try {
                await port.close();
            } catch (error) {
                console.warn(`${this.logHead}Port close error`, error);
            }
        }
    }

    async disconnect() {
        this.stopSerialClaim();
        this.connected = false;
        this.transmitting = false;
        this.reading = false;
        this.bytesReceived = 0;
        this.bytesSent = 0;

        try {
            await this.releasePortResources();

            console.log(
                `${this.logHead}Connection with ID: ${this.connectionId} closed, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );

            this.connectionId = false;
            this.bitrate = 0;
            this.connectionInfo = null;
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
        } catch (error) {
            console.error(error);
            console.error(
                `${this.logHead}Failed to close connection with ID: ${this.connectionId} closed, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );
            this.dispatchEvent(new CustomEvent("disconnect", { detail: false }));
        } finally {
            if (this.openCanceled) {
                this.openCanceled = false;
            }
        }
    }

    async send(data) {
        // TODO: previous serial implementation had a buffer of 100, do we still need it with streams?
        if (this.writer) {
            await this.writer.write(data);
            this.bytesSent += data.byteLength;
        } else {
            console.error(
                `${this.logHead}Failed to send data, serial port not open`,
            );
        }
        return {
            bytesSent: this.bytesSent,
        };
    }
}

export default new WebSerial();
