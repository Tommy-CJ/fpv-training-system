export const buttonStyle = {
  height: 38,
  borderRadius: 10,
  border: "1px solid #d4d4d8",
  padding: "0 14px",
  background: "#fff",
  cursor: "pointer",
  fontWeight: 800,
};

export const primaryButtonStyle = {
  ...buttonStyle,
  border: "1px solid #2563eb",
  background: "#2563eb",
  color: "#fff",
};

export const dangerButtonStyle = {
  ...buttonStyle,
  border: "1px solid #ef4444",
  color: "#b91c1c",
};

export const inputStyle = {
  width: "100%",
  height: 38,
  borderRadius: 10,
  border: "1px solid #d4d4d8",
  padding: "0 10px",
  boxSizing: "border-box",
  background: "#fff",
};

export const textareaStyle = {
  ...inputStyle,
  height: 74,
  padding: 10,
  resize: "vertical",
};

export const panelStyle = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 16,
  boxShadow: "0 10px 24px rgba(15,23,42,.06)",
};

export const defaultChannelConfig = {
  ch5: [{ name: "Arm", type: "arm", min: 1500, max: 1998 }],
  ch6: [
    { name: "Angle", type: "mode", min: 1500, max: 1800 },
    { name: "Air", type: "mode", min: 1800, max: 1998 },
  ],
  ch7: [{ name: "Turtle", type: "turtle", min: 1500, max: 1998 }],
  ch8: [],
};

export const channelTypes = ["mode", "turtle", "empty", "custom"];

export const videoChannels = {
  all: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "E1", "F1", "F2", "F4", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"],
};

export async function apiGet(path, fallback) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error("request failed");
    return await response.json();
  } catch {
    return fallback;
  }
}

function errorMessageFromResponseText(text, status) {
  if (!text) return `HTTP ${status}`;
  try {
    const payload = JSON.parse(text);
    return payload.error || payload.message || text;
  } catch {
    return text;
  }
}

export async function apiPost(path, data) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorMessageFromResponseText(text, response.status));
  }
  return response.json();
}

export async function apiPut(path, data) {
  const response = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorMessageFromResponseText(text, response.status));
  }
  return response.json();
}

export async function apiDelete(path) {
  const response = await fetch(path, { method: "DELETE" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorMessageFromResponseText(text, response.status));
  }
  return response.json();
}

export function isValueInRanges(value, ranges) {
  return ranges?.some((range) => value >= Number(range.min) && value <= Number(range.max));
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return "0秒";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}
