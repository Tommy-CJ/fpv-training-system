import fs from "node:fs";
import path from "node:path";
import { importPKCS8, SignJWT } from "jose";

let cachedPrivateKey = null;
let cachedJwt = null;
let cachedJwtExp = 0;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function privateKeyPem() {
  const base64 = String(process.env.QWEATHER_PRIVATE_KEY_BASE64 || "").trim();
  if (base64) return Buffer.from(base64, "base64").toString("utf8");

  const inline = String(process.env.QWEATHER_PRIVATE_KEY || "").trim();
  if (inline) return inline.replace(/\\n/g, "\n");

  const privateKeyPath = String(process.env.QWEATHER_PRIVATE_KEY_PATH || "").trim();
  if (privateKeyPath) return fs.readFileSync(path.resolve(privateKeyPath), "utf8");

  throw new Error(
    "Missing QWEATHER_PRIVATE_KEY_BASE64, QWEATHER_PRIVATE_KEY or QWEATHER_PRIVATE_KEY_PATH",
  );
}

async function getPrivateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  cachedPrivateKey = await importPKCS8(privateKeyPem(), "EdDSA");
  return cachedPrivateKey;
}

async function getQWeatherJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwtExp - now >= 300) return cachedJwt;

  const projectId = requiredEnv("QWEATHER_PROJECT_ID");
  const credentialId = requiredEnv("QWEATHER_CREDENTIAL_ID");
  const privateKey = await getPrivateKey();
  const exp = now + 3600;

  cachedJwt = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: credentialId })
    .setSubject(projectId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);
  cachedJwtExp = exp;
  return cachedJwt;
}

export async function qweatherGet(apiPath, params = {}) {
  const host = requiredEnv("QWEATHER_API_HOST");
  if (!apiPath.startsWith("/")) throw new Error("QWeather path must start with /");
  const url = new URL(`https://${host}${apiPath}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const jwt = await getQWeatherJwt();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const data = await response.json().catch(() => ({}));
  if (data.code !== "200") {
    const error = new Error(`QWeather request failed: ${data.code || response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
