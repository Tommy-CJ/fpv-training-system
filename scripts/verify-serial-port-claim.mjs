import assert from "node:assert/strict";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
};

function mockPort(usbVendorId, usbProductId) {
  return { getInfo: () => ({ usbVendorId, usbProductId }) };
}

const receiverOne = mockPort(0x0483, 0x5740);
const receiverTwo = mockPort(0x0483, 0x5740);
const flightController = mockPort(0x2e8a, 0x000a);
const ports = [receiverOne, receiverTwo, flightController];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    serial: {
      async getPorts() {
        return ports;
      },
    },
  },
});

const {
  claimBetaflightSerialPort,
  claimTrainingSerialPort,
  findPreferredTrainingSerialPort,
  isBetaflightSerialPortClaimed,
  isTrainingSerialPortClaimed,
  listUnclaimedAuthorizedSerialPorts,
  readBetaflightSerialClaim,
  readTrainingSerialClaim,
  releaseBetaflightSerialPortClaim,
  releaseTrainingSerialPortClaim,
  rememberTrainingSerialPort,
  TRAINING_SERIAL_CLAIM_HEARTBEAT_MS,
  TRAINING_SERIAL_CLAIM_TTL_MS,
} = await import("../src/serialPortClaim.js");

const claim = await claimTrainingSerialPort(receiverTwo, "test-owner");
assert.equal(claim.ordinal, 1, "identical VID/PID ports must be distinguished by ordinal");
assert.ok(
  TRAINING_SERIAL_CLAIM_TTL_MS > 60_000,
  "serial ownership must survive Chromium's one-minute background timer throttling",
);
assert.ok(
  TRAINING_SERIAL_CLAIM_HEARTBEAT_MS * 2 < TRAINING_SERIAL_CLAIM_TTL_MS,
  "serial claim heartbeat must have ample scheduling margin before expiry",
);
assert.ok(readTrainingSerialClaim(claim.updatedAt + TRAINING_SERIAL_CLAIM_TTL_MS - 1));
assert.equal(
  readTrainingSerialClaim(claim.updatedAt + TRAINING_SERIAL_CLAIM_TTL_MS + 1),
  null,
  "a crashed owner must eventually release its advisory claim",
);
await claimTrainingSerialPort(receiverTwo, "test-owner");
assert.equal(await isTrainingSerialPortClaimed(receiverOne), false);
assert.equal(await isTrainingSerialPortClaimed(receiverTwo), true);
assert.deepEqual(await listUnclaimedAuthorizedSerialPorts(), [receiverOne, flightController]);

await rememberTrainingSerialPort(receiverTwo);
assert.equal(findPreferredTrainingSerialPort(ports), receiverTwo, "preferred array port must survive reconnect selection");

const bfClaim = await claimBetaflightSerialPort(receiverOne, "bf-owner");
assert.equal(bfClaim.ordinal, 0);
assert.equal(await isBetaflightSerialPortClaimed(receiverOne), true);
assert.equal(await isBetaflightSerialPortClaimed(receiverTwo), false);
releaseBetaflightSerialPortClaim("different-owner");
assert.ok(readBetaflightSerialClaim(), "another BF tab must not release the active claim");
releaseBetaflightSerialPortClaim("bf-owner");
assert.equal(readBetaflightSerialClaim(), null);

releaseTrainingSerialPortClaim("different-owner");
assert.ok(readTrainingSerialClaim(), "another tab must not release the active claim");
releaseTrainingSerialPortClaim("test-owner");
assert.equal(readTrainingSerialClaim(), null);
assert.deepEqual(await listUnclaimedAuthorizedSerialPorts(), ports);

console.log("serial-port-claim-ok");
