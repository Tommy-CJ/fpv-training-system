function isTrainingHub(info) {
  return String(info?.vendorId || "").toLowerCase() === "0483"
    && String(info?.productId || "").toLowerCase() === "5740";
}

function portIdentity(info) {
  const pnpId = String(info?.pnpId || "").trim().toLowerCase();
  if (pnpId) return `pnp:${pnpId}`;
  const serialNumber = String(info?.serialNumber || "").trim().toLowerCase();
  if (serialNumber) {
    return `serial:${String(info?.vendorId || "").toLowerCase()}:${String(info?.productId || "").toLowerCase()}:${serialNumber}`;
  }
  return "";
}

function portLabel(info) {
  const port = String(info?.path || "");
  const friendlyName = String(info?.friendlyName || "").trim();
  const serialNumber = String(info?.serialNumber || "").trim();
  const hubName = isTrainingHub(info) && serialNumber ? serialNumber : "";
  if (hubName && friendlyName) {
    return `${hubName} · ${friendlyName.includes(port) ? friendlyName : `${friendlyName} (${port})`}`;
  }
  if (hubName) return `${hubName} (${port})`;
  if (friendlyName) return friendlyName.includes(port) ? friendlyName : `${friendlyName} (${port})`;
  if (isTrainingHub(info)) return `STM32 接收阵列 (${port})`;
  const manufacturer = String(info?.manufacturer || "").trim();
  return manufacturer && manufacturer.toLowerCase() !== "microsoft"
    ? `${manufacturer} (${port})` : `串口 (${port})`;
}

function sortPorts(ports) {
  return [...ports].sort((left, right) => {
    const priority = Number(isTrainingHub(right)) - Number(isTrainingHub(left));
    return priority || String(left.path || "").localeCompare(String(right.path || ""), undefined, { numeric: true });
  });
}

function findConfiguredPort(ports, config) {
  if (!config?.portPath || !config?.portIdentity) return null;
  return ports.find((info) => info.path === config.portPath
    && portIdentity(info) === config.portIdentity) || null;
}

function portReadyToOpen(ports, config, connectRequested) {
  return connectRequested ? findConfiguredPort(ports, config) : null;
}

module.exports = { findConfiguredPort, isTrainingHub, portIdentity, portLabel, portReadyToOpen, sortPorts };
