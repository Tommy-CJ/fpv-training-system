const COACH_PASSWORD_STORAGE_KEY = "bracketDemoCoachPassword";

export function getCoachPassword() {
  return sessionStorage.getItem(COACH_PASSWORD_STORAGE_KEY) || "";
}

export function setCoachPassword(password) {
  sessionStorage.setItem(COACH_PASSWORD_STORAGE_KEY, String(password || ""));
  window.dispatchEvent(new CustomEvent("coach-auth-changed", { detail: { authenticated: Boolean(password) } }));
}

export function clearCoachPassword() {
  sessionStorage.removeItem(COACH_PASSWORD_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent("coach-auth-changed", { detail: { authenticated: false } }));
}

export async function validateCoachPassword(password) {
  const response = await fetch("/api/coach/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-coach-password": String(password || "") },
  });
  if (response.ok) return true;
  const text = await response.text();
  let message = "密码不正确";
  try {
    const payload = JSON.parse(text);
    message = payload.error || payload.message || message;
  } catch {
    if (text) message = text;
  }
  throw new Error(message);
}
