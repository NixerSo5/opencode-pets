/**
 * electron-main.ts
 *
 * Standalone desktop pet app: an original-style transparent, frameless,
 * always-on-top pet window plus the Pets management tab (管理端 → 宠物,
 * only that tab) in a normal management window.
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createPetPageHtml } from "./desktop-render.js";
import { getConfiguredSpriteStates, isLoopingSpriteState, resolveReactionSpriteState } from "./reaction-animation-mapping.js";
import { createManagementHtml, type PetListItem } from "./management-render.js";
import { getCatalogPage, getCatalogAllPets, type CatalogPetEntry } from "./catalog-client.js";
import { installCatalogPet } from "./catalog-install.js";
import {
  builtInPetEntry,
  resolveDefaultPet,
  importPetFolder,
  listInstalledPets,
  readManagedState,
  writeManagedState,
  type PetStoreEntry,
} from "./pet-store.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { pickReactionMessage } from "./reaction-messages.js";
import {
  activeSessions,
  createSession,
  discoverService,
  interruptSession,
  readTimeline,
  sendPrompt,
  type ServiceEndpoint,
} from "./opencode-client.js";
import { OpenCodeWatch } from "./opencode-watch.js";
import { parseSummonRequest, placeAtCursor, type SummonRequest } from "./summon.js";

const scale = 0.75;
// Reaction schedule mirroring the original `reactionAnimationMetadata` order
// (advanced manually via the tray "切换下一个表情"; no automatic polling).
const reactionSchedule: readonly OpenPetsReaction[] = [
  "idle", "thinking", "working", "testing", "waiting", "success", "error", "celebrating", "waving", "idle",
];

const stateRows = getConfiguredSpriteStates(1010);

let mainWindow: BrowserWindow | null = null;
let managementWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let revertTimer: NodeJS.Timeout | null = null;
let scheduleIndex = 0;
let lastSpriteState: string = "idle";
let currentPetEntry: PetStoreEntry = { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
/** Chat carrier state (original expandedPetWindowSize behavior). */
let chatExpanded = false;
let collapsedAnchor: { x: number; y: number } | null = null;

/** OpenCode wiring: one pet window, one session (milestone 1). */
let endpoint: ServiceEndpoint | undefined;
let activeSessionID: string | undefined;
let activeSessionTitle: string | undefined;
let watch: OpenCodeWatch | undefined;
let pendingSummon: SummonRequest | undefined;

const collapsedWindowSize = { width: 320, height: 300 };
const expandedWindowSize = { width: 420, height: 640 };

const distDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(distDir, "..");
const spritesheetPath = join(projectRoot, "assets", "assets", "default-pet-spritesheet.webp");
const trayIconPath = join(projectRoot, "assets", "assets", "tray-icon.png");

function oneShotRevertMs(spriteState: string): number | null {
  if (isLoopingSpriteState(spriteState as never, stateRows)) return null;
  const row = stateRows[spriteState as keyof typeof stateRows];
  return row.durationMs * (("iterations" in row && typeof row.iterations === "number") ? row.iterations : 1);
}

function applyReaction(reaction: OpenPetsReaction | undefined, message?: string): void {
  const spriteState = resolveReactionSpriteState(reaction);
  lastSpriteState = spriteState;
  const settledMessage = message ?? (reaction ? pickReactionMessage(reaction) : undefined);
  mainWindow?.webContents.send("openpets:pet-state", { state: spriteState, reaction, message: settledMessage });
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
  const revert = oneShotRevertMs(spriteState);
  if (revert !== null) {
    revertTimer = setTimeout(() => {
      lastSpriteState = "idle";
      mainWindow?.webContents.send("openpets:pet-state", { state: "idle" });
    }, revert + 200);
    revertTimer.unref?.();
  }
}

function advanceSchedule(): void {
  const reaction = reactionSchedule[scheduleIndex % reactionSchedule.length];
  scheduleIndex += 1;
  applyReaction(reaction);
}

/** Welcome message: pet waves, says hello, and shows the "Hi" badge (original startup greeting). */
function sayWelcome(): void {
  applyReaction("waving", pickReactionMessage("waving"));
  // Welcome waving is a looping pose; without the poll loop we must revert to idle ourselves.
  if (idleRevertTimer) clearTimeout(idleRevertTimer);
  idleRevertTimer = setTimeout(() => {
    if (lastSpriteState === resolveReactionSpriteState("waving")) {
      lastSpriteState = "idle";
      mainWindow?.webContents.send("openpets:pet-state", { state: "idle" });
    }
  }, 4200);
  idleRevertTimer.unref?.();
}

function clampPointToWorkArea(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.min(Math.max(point.x, area.x + 2), area.x + area.width - size.width - 2),
    y: Math.min(Math.max(point.y, area.y + 2), area.y + area.height - size.height - 2),
  };
}

/** Anchor-preserving bounds: the pet stays at its spot while the window grows upward/sideways. */
function expandedBoundsFor(collapsed: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
  const raw = {
    x: collapsed.x - Math.round((expandedWindowSize.width - collapsedWindowSize.width) / 2),
    y: collapsed.y - (expandedWindowSize.height - collapsedWindowSize.height),
  };
  return {
    ...clampPointToWorkArea(raw, expandedWindowSize),
    width: expandedWindowSize.width,
    height: expandedWindowSize.height,
  };
}

function publishPanelState(): void {
  mainWindow?.webContents.send("openpets:pet-panel-state", { chatExpanded });
}

/** Human-readable pet label for a session, e.g. "my-project". */
function sessionLabel(directory: string): string {
  const name = basename(directory);
  return name.length > 0 ? name : directory;
}

/** Push a plain message to the pet bubble without changing its pose. */
function say(text: string): void {
  mainWindow?.webContents.send("openpets:pet-state", { state: lastSpriteState, message: text });
}

/**
 * Map OpenCode session events onto pet reactions. Only the session this pet
 * owns is animated, so a busy TUI session elsewhere stays invisible here.
 */
function handleWatchStatus(update: { sessionID: string; status: "running" | "idle"; kind: "started" | "succeeded" | "failed" | "interrupted" | "enqueued" | "waiting"; tool?: string }): void {
  if (activeSessionID === undefined || update.sessionID !== activeSessionID) return;
  const label = activeSessionTitle ?? "session";
  switch (update.kind) {
    case "enqueued":
      applyReaction("waving", `${label}: 收到你的消息`);
      return;
    case "started":
      applyReaction(update.tool === undefined ? "working" : "running", update.tool === undefined ? undefined : `${label}: ${update.tool}`);
      return;
    case "succeeded":
      applyReaction("success", `${label}: 完成`);
      return;
    case "failed":
      applyReaction("error", `${label}: 失败`);
      return;
    case "interrupted":
      applyReaction("idle", `${label}: 已中断`);
      return;
    case "waiting":
      applyReaction("waiting", update.tool === undefined ? `${label}: 需要你批准` : `${label}: 等你批准 ${update.tool}`);
      return;
  }
}

/** Start the SSE watcher once; it reconnects on its own afterwards. */
function startWatch(): void {
  if (watch !== undefined) return;
  watch = new OpenCodeWatch({
    onStatus: handleWatchStatus,
    onEvent: (event) => {
      // The step/text events are high-frequency; only surface the ones that
      // give the pet something meaningful to say, and only for its session.
      if (activeSessionID === undefined || event.sessionID !== activeSessionID) return;
      if (event.type === "session.step.started") applyReaction("thinking", "想了想下一步");
      if (event.type === "session.step.ended") applyReaction("working", "推进了一步");
    },
    onConnected: () => console.log("[opencode] SSE connected"),
    onDisconnected: (reason) => {
      console.log(`[opencode] SSE disconnected: ${reason}`);
      if (activeSessionID !== undefined) say("OpenCode 连接断开，正在重连…");
    },
  });
  watch.start();
}

/**
 * Attach the pet to an OpenCode session for `directory`: reuse the current one
 * when it already points at the same folder, otherwise create a fresh session.
 */
async function attachSession(directory: string): Promise<{ ok: boolean; message?: string }> {
  const discovered = await discoverService();
  if (discovered === undefined) return { ok: false, message: "没找到正在运行的 OpenCode 服务（service.json 缺失）" };
  endpoint = discovered;
  startWatch();
  if (activeSessionID !== undefined) {
    const state = watch?.get(activeSessionID);
    if (state?.directory === directory) return { ok: true, message: `沿用会话：${activeSessionTitle ?? ""}` };
  }
  try {
    const session = await createSession(discovered, directory, sessionLabel(directory));
    activeSessionID = session.id;
    activeSessionTitle = session.title ?? sessionLabel(directory);
    watch?.track({ id: session.id, title: activeSessionTitle, directory });
    return { ok: true, message: `已创建会话：${activeSessionTitle}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wait for the agent to answer a prompt we just sent, then return the newest
 * assistant text. Polls the projected transcript until a new assistant row
 * appears after `promptText`, or the timeout expires.
 */
async function followReply(target: ServiceEndpoint, sessionID: string, promptText: string, timeoutMs = 120_000): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let sawUser = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const timeline = await readTimeline(target, sessionID).catch(() => undefined);
    if (timeline === undefined) continue;
    if (!sawUser) sawUser = timeline.some((entry) => entry.role === "user" && entry.text.includes(promptText));
    const last = timeline.at(-1);
    if (sawUser && last !== undefined && last.role === "assistant") return { ok: true, reply: last.text };
  }
  return { ok: false, error: "等待 OpenCode 回复超时" };
}

/**
 * Execute a pending summon: attach a session for the requested folder, place
 * the pet at the cursor and greet. Safe to call again on second-instance.
 */
async function runSummon(request: SummonRequest): Promise<void> {
  pendingSummon = undefined;
  const win = mainWindow;
  if (win !== null && !win.isDestroyed()) {
    const area = screen.getDisplayNearestPoint({ x: request.x ?? 0, y: request.y ?? 0 }).workArea;
    const placed = placeAtCursor(request, area, collapsedWindowSize);
    win.setPosition(placed.x, placed.y);
    if (!win.isVisible()) win.show();
    win.focus();
  }
  sayWelcome();
  const result = await attachSession(request.directory);
  say(result.ok ? `${sessionLabel(request.directory)} · ${result.message ?? ""}` : `召唤失败：${result.message ?? "未知错误"}`);
}

/** Expand/collapse the pet window carrier for the chat panel (anchors the pet in place). */
function setChatExpanded(next: boolean): void {
  if (chatExpanded === next) return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  chatExpanded = next;
  const wasResizable = win.isResizable();
  win.setResizable(true);
  try {
    if (next) {
      const collapsed = win.getBounds();
      collapsedAnchor = { x: collapsed.x, y: collapsed.y };
      win.setBounds(expandedBoundsFor({ x: collapsed.x, y: collapsed.y }), false);
    } else {
      const anchor = collapsedAnchor ?? (() => {
        const bounds = win.getBounds();
        return clampPointToWorkArea({ x: bounds.x, y: bounds.y + (collapsedWindowSize.height - bounds.height) }, collapsedWindowSize);
      })();
      win.setBounds({ ...anchor, width: collapsedWindowSize.width, height: collapsedWindowSize.height }, false);
    }
  } finally {
    win.setResizable(wasResizable);
  }
  publishPanelState();
}

// The 5s reaction polling loop (表情轮询) was removed per product request:
// the pet only plays reactions on explicit events (welcome on load, tray
// 「切换下一个表情」, future OpenCode session events).
let idleRevertTimer: NodeJS.Timeout | null = null;

async function writePetPage(): Promise<string> {
  const dir = join(app.getPath("userData"), "rendered-pets");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "standalone-pet.html");
  const spriteUrl = currentPetEntry.builtIn
    ? pathToFileURL(spritesheetPath).toString()
    : pathToFileURL(currentPetEntry.spritesheetPath).toString();
  const html = createPetPageHtml({
    scale,
    spritesheetUrl: spriteUrl,
    atlasRows: currentPetEntry.spriteVersionNumber === 2 ? 11 : 9,
    petName: currentPetEntry.displayName,
  });
  await writeFile(filePath, html, "utf8");
  return filePath;
}

function bottomRightPosition(width: number, height: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    x: display.x + display.width - width - 24,
    y: display.y + display.height - height - 8,
  };
}

function createPetWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    void writePetPage().then((filePath) => mainWindow?.loadFile(filePath));
    return;
  }
  const width = 320;
  const height = 300;
  const window = new BrowserWindow({
    title: "OpenPets pet",
    width,
    height,
    ...bottomRightPosition(width, height),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(projectRoot, "pet-preload.cjs"),
      zoomFactor: 1,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setMenu(null);
  // Re-show the welcome greeting whenever the pet page loads (startup and
  // every later reload, e.g. switching the default pet).
  window.webContents.on("did-finish-load", () => {
    sayWelcome();
    publishPanelState();
  });
  void writePetPage().then((filePath) => window.loadFile(filePath)).then(() => {
    window.show();
  }).catch((error) => {
    console.error("pet page load failed", error);
  });
  mainWindow = window;
  window.on("closed", () => {
    mainWindow = null;
  });
  const queued = pendingSummon;
  if (queued !== undefined) {
    window.webContents.once("did-finish-load", () => {
      void runSummon(queued);
    });
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("OpenPets standalone pet");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "打开宠物管理",
      type: "normal",
      click: () => openManagementWindow(),
    },
    {
      label: "切换下一个表情",
      type: "normal",
      click: () => advanceSchedule(),
    },
    { label: "退出", type: "normal", click: () => app.quit() },
  ]));
}

async function petListItems(): Promise<PetListItem[]> {
  const userData = app.getPath("userData");
  const [installed, state] = [await listInstalledPets(userData), readManagedState(userData)];
  const items: PetListItem[] = [
    {
      id: builtInPetEntry.id,
      displayName: builtInPetEntry.displayName,
      description: builtInPetEntry.description,
      spriteVersionNumber: builtInPetEntry.spriteVersionNumber,
      spritesheetFileUrl: pathToFileURL(spritesheetPath).toString(),
      builtIn: true,
      isDefault: state.defaultPetId === builtInPetEntry.id,
    },
  ];
  for (const entry of installed) {
    items.push({
      id: entry.id,
      displayName: entry.displayName,
      description: entry.description,
      spriteVersionNumber: entry.spriteVersionNumber,
      spritesheetFileUrl: pathToFileURL(entry.spritesheetPath).toString(),
      builtIn: false,
      isDefault: entry.id === state.defaultPetId,
    });
  }
  return items;
}

function openManagementWindow(): void {
  if (managementWindow && !managementWindow.isDestroyed()) {
    void refreshManagementWindow();
    if (managementWindow.isMinimized()) managementWindow.restore();
    managementWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    title: "宠物",
    width: 880,
    height: 620,
    autoHideMenuBar: true,
    backgroundColor: "#0b1220",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: join(projectRoot, "management-preload.cjs"),
    },
  });
  managementWindow = window;
  window.on("closed", () => {
    managementWindow = null;
  });
  void refreshManagementWindow();
}

async function refreshManagementWindow(): Promise<void> {
  if (!managementWindow || managementWindow.isDestroyed()) return;
  const dir = join(app.getPath("userData"), "rendered-pets");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "management-pets.html");
  await writeFile(filePath, createManagementHtml({ items: await petListItems() }), "utf8");
  await managementWindow.loadFile(filePath);
}

async function decorateCatalogPets(pets: readonly CatalogPetEntry[]): Promise<CatalogPetEntry[]> {
  const [installed, state] = [await listInstalledPets(app.getPath("userData")), readManagedState(app.getPath("userData"))];
  const installedIds = new Set(installed.map((entry) => entry.id));
  return pets.map((entry) => ({ ...entry, installed: installedIds.has(entry.id), isDefault: entry.id === state.defaultPetId }));
}

function installIpc(): void {
  ipcMain.on("openpets:pet-message", (event, message: unknown) => {
    if (typeof message !== "string" || message.length === 0) return;
    event.sender.send("openpets:pet-state", { state: lastSpriteState, message });
  });
  ipcMain.on("openpets:pet-chat-toggle", () => {
    setChatExpanded(!chatExpanded);
  });
  // Full projected transcript for the bound session, oldest first. The panel
  // calls this on open so the first paint shows real OpenCode history.
  ipcMain.handle("openpets:pet-chat-history", async () => {
    if (endpoint === undefined) return { ok: false, error: "OpenCode 未连接", messages: [] };
    if (activeSessionID === undefined) return { ok: false, error: "当前宠物还没有绑定会话", messages: [] };
    const messages = await readTimeline(endpoint, activeSessionID).catch(() => undefined);
    if (messages === undefined) return { ok: false, error: "读取会话历史失败", messages: [] };
    return { ok: true, sessionTitle: activeSessionTitle ?? "", messages };
  });
  ipcMain.handle("openpets:pet-chat-send", async (_event, raw: unknown) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { ok: false, error: "消息为空" };
    if (text.length > 4000) return { ok: false, error: "消息太长（上限 4000 字）" };
    if (endpoint === undefined) return { ok: false, error: "OpenCode 未连接，请先右键召唤宠物" };
    if (activeSessionID === undefined) return { ok: false, error: "当前宠物还没有绑定会话" };
    try {
      await sendPrompt(endpoint, activeSessionID, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // Follow the reply in the transcript; polling stops once the agent idles.
    return await followReply(endpoint, activeSessionID, text);
  });
  ipcMain.on("openpets:pet-drag-move", (_event, payload: unknown) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    const dx = typeof (payload as { dx?: unknown } | null)?.dx === "number" ? Math.round((payload as { dx: number }).dx) : 0;
    const dy = typeof (payload as { dy?: unknown } | null)?.dy === "number" ? Math.round((payload as { dy: number }).dy) : 0;
    if (dx === 0 && dy === 0) return;
    win.setPosition(win.getBounds().x + dx, win.getBounds().y + dy);
  });
  ipcMain.handle("pets:catalog-page", async (_event, page: unknown) => {
    try {
      const result = await getCatalogPage(typeof page === "number" ? page : 0);
      const pets = (await decorateCatalogPets(result.pets)) as (CatalogPetEntry & { readonly installed: boolean; readonly isDefault: boolean })[];
      return { ok: true, page: result.page, pageCount: result.pageCount, total: result.total, pets, filters: result.filters };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("pets:catalog-search", async () => {
    try {
      const pets = (await decorateCatalogPets(await getCatalogAllPets())) as (CatalogPetEntry & { readonly installed: boolean; readonly isDefault: boolean })[];
      return { ok: true, pets };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), pets: [] };
    }
  });
  ipcMain.handle("pets:catalog-install", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || petId.length === 0 || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(petId)) return { ok: false, message: "非法的宠物 id" };
    const result = await installCatalogPet(app.getPath("userData"), petId);
    await refreshManagementWindow();
    return result;
  });
  ipcMain.handle("pets:select", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || petId.length === 0) return { ok: false, message: "非法的宠物 id" };
    const userData = app.getPath("userData");
    if (petId !== builtInPetEntry.id) {
      const installed = await listInstalledPets(userData);
      if (!installed.some((entry) => entry.id === petId)) return { ok: false, message: `未安装 ${petId}` };
    }
    await writeManagedState(userData, { defaultPetId: petId });
    currentPetEntry = await resolveDefaultPet(userData);
    createPetWindow(); // rebuilds in place: same window reloads the new page
    return { ok: true, message: "已设为默认" };
  });
  ipcMain.handle("pets:import-folder", async () => {
    const result = await dialog.showOpenDialog(managementWindow ?? new BrowserWindow(), {
      title: "选择宠物包文件夹",
      properties: ["openDirectory"],
      message: "文件夹应包含 pet.json 和精灵图",
    });
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, message: "已取消" };
    return importPetFolder(app.getPath("userData"), result.filePaths[0]);
  });
}

/** Handle a summon request, waiting for the pet window to exist if needed. */
function dispatchSummon(request: SummonRequest): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    pendingSummon = request;
    createPetWindow();
    return;
  }
  void runSummon(request);
}

// Explorer invokes one process per click; a second launch forwards its request
// to the running instance instead of stacking duplicate pets.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const request = parseSummonRequest(argv);
    if (request === undefined) {
      mainWindow?.show();
      mainWindow?.focus();
      return;
    }
    dispatchSummon(request);
  });
}

void app.whenReady().then(async () => {
  installIpc();
  currentPetEntry = await resolveDefaultPet(app.getPath("userData"));
  createTray();
  const startupSummon = parseSummonRequest(process.argv);
  if (startupSummon !== undefined) pendingSummon = startupSummon;
  createPetWindow();
});

app.on("window-all-closed", () => {
  // The pet window is the app; closing it exits like quitting the pet.
  app.quit();
});

app.on("quit", () => {
  if (revertTimer) clearTimeout(revertTimer);
  watch?.stop();
  // Quitting the pet ends its session's running work, per product decision.
  if (endpoint !== undefined && activeSessionID !== undefined) {
    void interruptSession(endpoint, activeSessionIdOrEmpty());
  }
});

function activeSessionIdOrEmpty(): string {
  return activeSessionID ?? "";
}
