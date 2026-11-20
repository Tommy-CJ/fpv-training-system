import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import packager from "@electron/packager";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = path.join(desktopDir, "out", process.argv[2] || "manual-connect");
const localElectronDir = path.join(desktopDir, "electron-dist");
const destinations = await packager({
  dir: desktopDir,
  out: output,
  name: "FPV-Training-Collector",
  platform: "win32",
  arch: "x64",
  overwrite: true,
  prune: true,
  asar: false,
  ...(existsSync(path.join(localElectronDir, "electron-v44.4.3-win32-x64.zip"))
    ? { electronZipDir: localElectronDir } : {}),
  ignore: [
    /^\/out(\/|$)/,
    /^\/scripts(\/|$)/,
    /^\/\.npm-cache(\/|$)/,
    /^\/Codenpm-cache(\/|$)/,
    /^\/electron-dist(\/|$)/,
    /^\/README\.md$/,
  ],
});
console.log(`Windows tray collector: ${path.join(destinations[0], "FPV-Training-Collector.exe")}`);
