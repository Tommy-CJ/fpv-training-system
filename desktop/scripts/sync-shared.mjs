import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sharedDir = path.join(desktopDir, "shared");
mkdirSync(sharedDir, { recursive: true });
for (const file of ["serialCaptureClock.js", "serialJsonStream.js", "livePersistence.js"]) {
  copyFileSync(path.resolve(desktopDir, "../src", file), path.join(sharedDir, file));
}
copyFileSync(path.resolve(desktopDir, "../logo_single.png"), path.join(desktopDir, "icon.png"));
