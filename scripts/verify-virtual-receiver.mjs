import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const port = 32000 + (process.pid % 1000);
const workDir = mkdtempSync(path.join(tmpdir(), "fpv-virtual-receiver-"));
const server = spawn(process.execPath, [path.join(root, "server.js")], {
  cwd: workDir,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

function waitForServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("test server startup timed out")), 10000);
    const inspect = (chunk) => {
      if (!String(chunk).includes("Server running:")) return;
      clearTimeout(timeout);
      resolve();
    };
    server.stdout.on("data", inspect);
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.once("exit", (code) => reject(new Error(`test server exited early: ${code}`)));
  });
}

function waitForVirtualBatch(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("virtual batch timed out")), 10000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== "live_batch" || message.source !== "virtual_receiver") return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

let socket;
let generator;
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

try {
  await waitForServer();
  socket = new WebSocket(`ws://127.0.0.1:${port}/live-ws`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ type: "publish_live", room: "default" }));
  const batchPromise = waitForVirtualBatch(socket);
  generator = spawn(process.execPath, [
    path.join(root, "scripts", "virtual-receiver-array.mjs"),
    "--relay", `ws://127.0.0.1:${port}/live-ws`,
    "--receivers", "3",
    "--rate", "30",
    "--count", "3",
  ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  generator.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const message = await batchPromise;
  if (message.batch?.type !== "rx_batch" || message.batch?.items?.length !== 3) {
    throw new Error("unexpected virtual receiver batch");
  }
  console.log(JSON.stringify({ ok: true, source: message.source, receivers: message.batch.items.length }));
} finally {
  socket?.close();
  await stopChild(generator);
  await stopChild(server);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
