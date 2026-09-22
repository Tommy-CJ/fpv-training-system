import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function loadLocalEnvFile(filePath, targetEnv) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && targetEnv[key] === undefined) targetEnv[key] = value;
  }
}

const nodeCommand = process.execPath;
const viteEntry = path.join("node_modules", "vite", "bin", "vite.js");
const childEnv = { ...process.env };
loadLocalEnvFile(path.resolve(process.cwd(), ".env"), childEnv);
loadLocalEnvFile(path.resolve(process.cwd(), ".env.local"), childEnv);

function start(name, command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: childEnv,
    shell: false,
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopAll();
    const label = signal ? `${signal}` : `${code}`;
    console.log(`[dev] ${name} exited: ${label}`);
    process.exit(code || 0);
  });

  return child;
}

let shuttingDown = false;
const children = [
  start("api", nodeCommand, ["server.js"]),
  start("vite", nodeCommand, [viteEntry, "--host", "127.0.0.1"]),
];

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on("SIGINT", () => {
  shuttingDown = true;
  stopAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  stopAll();
  process.exit(0);
});
