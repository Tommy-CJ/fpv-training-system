const TRAINING_SERIAL_CLAIM_KEY = "fpv-training-active-serial-port-v1";
const BETAFLIGHT_SERIAL_CLAIM_KEY = "fpv-betaflight-active-serial-port-v1";
const PREFERRED_TRAINING_SERIAL_PORT_KEY = "fpv-training-preferred-serial-port-v1";
// Hidden Chromium tabs may coalesce ordinary Window timers to roughly one
// callback per minute. A five-second claim therefore expired even though the
// Dedicated Worker still owned and consumed the serial port, allowing another
// page to mistake a healthy connection for an abandoned one. Keep the claim
// comfortably beyond the background throttle interval while still allowing a
// crashed tab to become recoverable without a browser restart.
const TRAINING_SERIAL_CLAIM_TTL_MS = 90_000;
const TRAINING_SERIAL_CLAIM_HEARTBEAT_MS = 15_000;

function safePortInfo(port) {
  const info = port?.getInfo?.() || {};
  return {
    usbVendorId: Number(info.usbVendorId) || 0,
    usbProductId: Number(info.usbProductId) || 0,
  };
}

export function describeSerialPort(port, ports = []) {
  const info = safePortInfo(port);
  const matchingPorts = ports.filter((candidate) => {
    const candidateInfo = safePortInfo(candidate);
    return candidateInfo.usbVendorId === info.usbVendorId
      && candidateInfo.usbProductId === info.usbProductId;
  });
  return {
    ...info,
    ordinal: Math.max(0, matchingPorts.indexOf(port)),
    authorizedIndex: Math.max(0, ports.indexOf(port)),
  };
}

function readLiveClaim(key, now = Date.now()) {
  try {
    const claim = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!claim?.ownerId || now - Number(claim.updatedAt || 0) > TRAINING_SERIAL_CLAIM_TTL_MS) return null;
    return claim;
  } catch {
    return null;
  }
}

function matchesDescriptor(port, descriptor, ports) {
  if (!descriptor || !port) return false;
  const current = describeSerialPort(port, ports);
  return current.usbVendorId === Number(descriptor.usbVendorId)
    && current.usbProductId === Number(descriptor.usbProductId)
    && current.ordinal === Number(descriptor.ordinal);
}

async function claimSerialPort(key, port, ownerId) {
  if (!port || !ownerId || !navigator.serial) return null;
  try {
    const ports = await navigator.serial.getPorts();
    const claim = { ...describeSerialPort(port, ports), ownerId, updatedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(claim));
    return claim;
  } catch {
    return null;
  }
}

function releaseSerialPortClaim(key, ownerId) {
  try {
    const claim = readLiveClaim(key);
    if (!claim || claim.ownerId === ownerId) window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened browser profiles.
  }
}

async function isSerialPortClaimed(key, port) {
  const claim = readLiveClaim(key);
  if (!claim || !port || !navigator.serial) return false;
  const ports = await navigator.serial.getPorts();
  return matchesDescriptor(port, claim, ports);
}

export function readTrainingSerialClaim(now = Date.now()) {
  return readLiveClaim(TRAINING_SERIAL_CLAIM_KEY, now);
}

export function readBetaflightSerialClaim(now = Date.now()) {
  return readLiveClaim(BETAFLIGHT_SERIAL_CLAIM_KEY, now);
}

export async function claimTrainingSerialPort(port, ownerId) {
  return claimSerialPort(TRAINING_SERIAL_CLAIM_KEY, port, ownerId);
}

export async function claimBetaflightSerialPort(port, ownerId) {
  return claimSerialPort(BETAFLIGHT_SERIAL_CLAIM_KEY, port, ownerId);
}

export function releaseTrainingSerialPortClaim(ownerId) {
  releaseSerialPortClaim(TRAINING_SERIAL_CLAIM_KEY, ownerId);
}

export function releaseBetaflightSerialPortClaim(ownerId) {
  releaseSerialPortClaim(BETAFLIGHT_SERIAL_CLAIM_KEY, ownerId);
}

export async function isTrainingSerialPortClaimed(port) {
  return isSerialPortClaimed(TRAINING_SERIAL_CLAIM_KEY, port);
}

export async function isBetaflightSerialPortClaimed(port) {
  return isSerialPortClaimed(BETAFLIGHT_SERIAL_CLAIM_KEY, port);
}

export async function rememberTrainingSerialPort(port) {
  if (!port || !navigator.serial) return null;
  try {
    const ports = await navigator.serial.getPorts();
    const descriptor = describeSerialPort(port, ports);
    window.localStorage.setItem(PREFERRED_TRAINING_SERIAL_PORT_KEY, JSON.stringify(descriptor));
    return descriptor;
  } catch {
    return null;
  }
}

export function readPreferredTrainingSerialPort() {
  try {
    return JSON.parse(window.localStorage.getItem(PREFERRED_TRAINING_SERIAL_PORT_KEY) || "null");
  } catch {
    return null;
  }
}

export function findPreferredTrainingSerialPort(ports = []) {
  const preferred = readPreferredTrainingSerialPort();
  return preferred ? ports.find((port) => matchesDescriptor(port, preferred, ports)) || null : null;
}

export async function listUnclaimedAuthorizedSerialPorts() {
  if (!navigator.serial) return [];
  const ports = await navigator.serial.getPorts();
  const claim = readTrainingSerialClaim();
  if (!claim) return ports;
  return ports.filter((port) => {
    const descriptor = describeSerialPort(port, ports);
    return descriptor.usbVendorId !== Number(claim.usbVendorId)
      || descriptor.usbProductId !== Number(claim.usbProductId)
      || descriptor.ordinal !== Number(claim.ordinal);
  });
}

export {
  BETAFLIGHT_SERIAL_CLAIM_KEY,
  PREFERRED_TRAINING_SERIAL_PORT_KEY,
  TRAINING_SERIAL_CLAIM_HEARTBEAT_MS,
  TRAINING_SERIAL_CLAIM_KEY,
  TRAINING_SERIAL_CLAIM_TTL_MS,
};
