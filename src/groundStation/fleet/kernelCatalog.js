import { FLEET_KERNELS } from "./contract.js";

const DEFAULT_KERNELS = Object.freeze({
  [FLEET_KERNELS.MODERN]: {
    id: FLEET_KERNELS.MODERN,
    label: "Betaflight 2026.6",
    url: "/betaflight/",
    available: false,
    apiMin: "1.44.0",
    apiMax: "1.48.0",
  },
  [FLEET_KERNELS.LEGACY]: {
    id: FLEET_KERNELS.LEGACY,
    label: "Betaflight Configurator 10.10",
    url: "/betaflight-legacy/",
    available: false,
    apiMin: "1.41.0",
    apiMax: "1.46.0",
  },
});

export function normalizeKernelCatalog(betaflight = {}) {
  const supplied = Array.isArray(betaflight.kernels) ? betaflight.kernels : [];
  const catalog = Object.fromEntries(
    Object.entries(DEFAULT_KERNELS).map(([id, entry]) => [id, { ...entry }]),
  );

  for (const entry of supplied) {
    if (!entry?.id || !catalog[entry.id]) continue;
    catalog[entry.id] = {
      ...catalog[entry.id],
      ...entry,
      available: Boolean(entry.available),
    };
  }

  // Compatibility with deployments that only expose the original single mirror.
  if (!supplied.length && betaflight.url) {
    catalog.modern = {
      ...catalog.modern,
      url: betaflight.url,
      available: Boolean(betaflight.available),
    };
  }

  return catalog;
}
export function initialKernelId(catalog) {
  if (catalog?.modern?.available) return FLEET_KERNELS.MODERN;
  if (catalog?.legacy?.available) return FLEET_KERNELS.LEGACY;
  return FLEET_KERNELS.MODERN;
}
