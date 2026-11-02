// Dev runner: watch src/**/*.ts, recompile with tsc, restart Electron.
// Usage: npm run dev
//
// Keeps a single Electron child process alive; when a .ts file under src/
// changes we debounce, run `tsc`, then kill + respawn the child.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electronBin = join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
let child = null;
let building = false;
let pending = false;

function startElectron() {
  if (child !== null) {
    try { child.kill(); } catch { /* already gone */ }
    child = null;
  }
  child = spawn(electronBin, [projectRoot], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, OPENPETS_DEV: "1" },
  });
  child.on("exit", (code, signal) => {
    // If Electron quits on its own (not because we killed it for a rebuild),
    // stop the watcher too so the terminal returns.
    if (!building) {
      console.log(`[dev] electron exited (code=${code ?? "null"} signal=${signal ?? "null"}), stopping watcher`);
      process.exit(code ?? 0);
    }
  });
}

function build() {
  if (building) { pending = true; return; }
  building = true;
  console.log("[dev] tsc...");
  const tsc = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  tsc.on("exit", (code) => {
    building = false;
    if (code === 0) {
      console.log("[dev] build ok, restarting electron");
      startElectron();
    } else {
      console.error(`[dev] tsc failed with code ${code}; keeping previous electron running`);
    }
    if (pending) { pending = false; build(); }
  });
}

let debounceTimer = null;
watch(join(projectRoot, "src"), { recursive: true }, (_event, filename) => {
  if (filename === null || !filename.endsWith(".ts")) return;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; build(); }, 200);
});

process.on("SIGINT", () => {
  console.log("[dev] SIGINT, shutting down");
  if (child !== null) { try { child.kill(); } catch { /* ignore */ } }
  process.exit(0);
});

console.log("[dev] initial build");
build();
