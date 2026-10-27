/**
 * electron-main.ts
 *
 * Standalone desktop pet app: an original-style transparent, frameless,
 * always-on-top pet window plus the Pets management tab (管理端 → 宠物,
 * only that tab) in a normal management window.
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog } from "electron";
import { mkdir, rename, writeFile } from "node:fs/promises";
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
  getSession,
  getSessionAfterModelSwitch,
  interruptSession,
  listModels,
  listSessions,
  parseFormCreated,
  readTimeline,
  replyForm,
  abortRunPrompt,
  runPrompt,
  sendPrompt,
  setSessionModel,
  turnResultAfter,
  type ServiceEndpoint,
} from "./opencode-client.js";
import { OpenCodeWatch } from "./opencode-watch.js";
import { desktopDirectory, parseSummonRequest, placeAtCursor, type SummonRequest } from "./summon.js";

const scale = 0.75;
// Reaction schedule mirroring the original `reactionAnimationMetadata` order
// (advanced manually via the tray "切换下一个表情"; no automatic polling).
const reactionSchedule: readonly OpenPetsReaction[] = [
  "idle", "thinking", "working", "testing", "waiting", "success", "error", "celebrating", "waving", "idle",
];

const stateRows = getConfiguredSpriteStates(1010);

let managementWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let scheduleIndex = 0;
let currentPetEntry: PetStoreEntry = { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
/** Rotating counter so each newly summoned pet picks a different appearance. */
let nextPetEntryIndex = 0;

/**
 * One pet window owns exactly one OpenCode session. Every piece of state that
 * used to be global (window, bound session, chat carrier geometry, sprite
 * pose) lives on the instance so several pets can coexist.
 */
interface PetInstance {
  readonly window: BrowserWindow;
  /** The sprite set this particular pet renders. */
  petEntry: PetStoreEntry;
  endpoint: ServiceEndpoint | undefined;
  sessionID: string | undefined;
  sessionTitle: string | undefined;
  directory: string;
  lastSpriteState: string;
  revertTimer: NodeJS.Timeout | null;
  idleRevertTimer: NodeJS.Timeout | null;
  /** Chat carrier state (original expandedPetWindowSize behavior). */
  chatExpanded: boolean;
  collapsedAnchor: { x: number; y: number } | null;
}

/** Keyed by `webContents.id`, which every IPC event carries. */
const pets = new Map<number, PetInstance>();

/** Shared SSE watcher: fans every session event out to the pet that owns it. */
let watch: OpenCodeWatch | undefined;
/** Summons that arrived before their window finished loading. */
const pendingSummons = new Map<number, SummonRequest>();

function petById(id: number): PetInstance | undefined {
  return pets.get(id);
}

/** Resolve the pet that sent an IPC message (undefined when the window is gone). */
function petForSender(sender: Electron.WebContents): PetInstance | undefined {
  return pets.get(sender.id);
}

function anyPet(): PetInstance | undefined {
  const first = pets.values().next();
  return first.done === true ? undefined : first.value;
}

/** The pet the user interacted with last, used by tray actions. */
let focusedPetId: number | undefined;

function focusedPet(): PetInstance | undefined {
  if (focusedPetId !== undefined) {
    const found = pets.get(focusedPetId);
    if (found !== undefined) return found;
  }
  return anyPet();
}

const collapsedWindowSize = { width: 320, height: 300 };
// Chat carrier: nominal 1.5x the original 420x640, but clamped to the work area
// so the pet never gets pushed off its spot on small screens.
const NOMINAL_EXPANDED_SIZE = { width: 630, height: 960 };

function computeExpandedWindowSize(): { width: number; height: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.min(NOMINAL_EXPANDED_SIZE.width, area.width - 8),
    height: Math.min(NOMINAL_EXPANDED_SIZE.height, area.height - 8),
  };
}

const distDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(distDir, "..");
// After packaging, `assets/` is copied to <install>/resources/assets by the
// electron-builder extraResources rule, so it must be read from there. When
// running from source it stays next to the project. Preloads are unaffected:
// they are packed into app.asar and still resolve through projectRoot.
const assetsRoot = app.isPackaged ? join(process.resourcesPath, "assets") : join(projectRoot, "assets");
const spritesheetPath = join(assetsRoot, "assets", "default-pet-spritesheet.webp");
const trayIconPath = join(assetsRoot, "assets", "tray-icon.png");

function oneShotRevertMs(spriteState: string): number | null {
  if (isLoopingSpriteState(spriteState as never, stateRows)) return null;
  const row = stateRows[spriteState as keyof typeof stateRows];
  return row.durationMs * (("iterations" in row && typeof row.iterations === "number") ? row.iterations : 1);
}

function applyReaction(pet: PetInstance | undefined, reaction: OpenPetsReaction | undefined, message?: string): void {
  if (pet === undefined || pet.window.isDestroyed()) return;
  const spriteState = resolveReactionSpriteState(reaction);
  pet.lastSpriteState = spriteState;
  const settledMessage = message ?? (reaction ? pickReactionMessage(reaction) : undefined);
  pet.window.webContents.send("openpets:pet-state", { state: spriteState, reaction, message: settledMessage });
  if (pet.revertTimer) {
    clearTimeout(pet.revertTimer);
    pet.revertTimer = null;
  }
  const revert = oneShotRevertMs(spriteState);
  if (revert !== null) {
    pet.revertTimer = setTimeout(() => {
      pet.lastSpriteState = "idle";
      if (!pet.window.isDestroyed()) pet.window.webContents.send("openpets:pet-state", { state: "idle" });
    }, revert + 200);
    pet.revertTimer.unref?.();
  }
}

function advanceSchedule(): void {
  const reaction = reactionSchedule[scheduleIndex % reactionSchedule.length];
  scheduleIndex += 1;
  applyReaction(focusedPet(), reaction);
}

/** Welcome message: pet waves, says hello, and shows the "Hi" badge (original startup greeting). */
function sayWelcome(pet: PetInstance): void {
  applyReaction(pet, "waving", pickReactionMessage("waving"));
  // Welcome waving is a looping pose; without the poll loop we must revert to idle ourselves.
  if (pet.idleRevertTimer) clearTimeout(pet.idleRevertTimer);
  pet.idleRevertTimer = setTimeout(() => {
    if (pet.lastSpriteState === resolveReactionSpriteState("waving")) {
      pet.lastSpriteState = "idle";
      if (!pet.window.isDestroyed()) pet.window.webContents.send("openpets:pet-state", { state: "idle" });
    }
  }, 4200);
  pet.idleRevertTimer.unref?.();
}

function clampPointToWorkArea(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.min(Math.max(point.x, area.x + 2), area.x + area.width - size.width - 2),
    y: Math.min(Math.max(point.y, area.y + 2), area.y + area.height - size.height - 2),
  };
}

/**
 * Anchor-preserving bounds: the pet stays at its spot while the window grows
 * upward/sideways. The pet is centred horizontally and sits at the bottom, so
 * the window origin moves by half the width delta and the full height delta.
 * When the work area forces a clamp, the resulting pet offset is reported back
 * so the caller can compensate instead of letting the pet drift.
 */
function expandedBoundsFor(collapsed: { x: number; y: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
  petOffset: { x: number; y: number };
} {
  const size = computeExpandedWindowSize();
  // The pet sits at the window's bottom-right corner, so that corner must not
  // move: keep the right and bottom edges fixed and grow left/up instead.
  const desired = {
    x: collapsed.x + collapsedWindowSize.width - size.width,
    y: collapsed.y + collapsedWindowSize.height - size.height,
  };
  const clamped = clampPointToWorkArea(desired, size);
  return {
    ...clamped,
    width: size.width,
    height: size.height,
    petOffset: { x: clamped.x - desired.x, y: clamped.y - desired.y },
  };
}

function publishPanelState(pet: PetInstance | undefined): void {
  if (pet === undefined || pet.window.isDestroyed()) return;
  // Include the bound session title so switching/creating a session refreshes
  // the panel header without a separate history round-trip.
  pet.window.webContents.send("openpets:pet-panel-state", {
    chatExpanded: pet.chatExpanded,
    sessionTitle: pet.sessionTitle ?? "",
  });
}

/** Human-readable pet label for a session, e.g. "my-project". */
function sessionLabel(directory: string): string {
  const name = basename(directory);
  return name.length > 0 ? name : directory;
}

/** Push a plain message to the pet bubble without changing its pose. */
function say(pet: PetInstance | undefined, text: string): void {
  if (pet === undefined || pet.window.isDestroyed()) return;
  pet.window.webContents.send("openpets:pet-state", { state: pet.lastSpriteState, message: text });
}

/**
 * Map OpenCode session events onto pet reactions. Only the session this pet
 * owns is animated, so a busy TUI session elsewhere stays invisible here.
 */
/** Find the pet that owns a session id (each session has at most one pet). */
function petForSession(sessionID: string): PetInstance | undefined {
  for (const pet of pets.values()) {
    if (pet.sessionID === sessionID) return pet;
  }
  return undefined;
}

/**
 * Forms (question tool calls) the agent is parked on, by form id. Route an
 * SSE `form.created` here, then answer through `openpets:pet-ask-reply`.
 * Removed as soon as a reply goes out or the turn is interrupted.
 */
interface PendingForm {
  readonly sessionID: string;
  readonly endpoint: ServiceEndpoint;
  readonly fieldKeys: readonly string[];
}
const pendingForms = new Map<string, PendingForm>();

/**
 * Resolvers waiting for a session's agent loop to reach a terminal state.
 * The SSE watcher fires them; turn sends fall back to timeline polling, but
 * the event is the primary, instant signal.
 */
type TurnCompletionKind = "succeeded" | "failed" | "interrupted";
const turnWaiters = new Map<string, Set<(kind: TurnCompletionKind) => void>>();

/** Resolve (and drop) every waiter parked on a session's terminal event. */
function resolveTurnWaiters(sessionID: string, kind: TurnCompletionKind): void {
  const waiters = turnWaiters.get(sessionID);
  if (waiters === undefined) return;
  turnWaiters.delete(sessionID);
  for (const waiter of waiters) waiter(kind);
}

function handleWatchStatus(update: { sessionID: string; status: "running" | "idle"; kind: "started" | "succeeded" | "failed" | "interrupted" | "enqueued" | "waiting"; tool?: string }): void {
  // Terminal states end waiting turns even when the pet is gone; reactions
  // below only matter for bound pets.
  if (update.kind === "succeeded" || update.kind === "failed" || update.kind === "interrupted") {
    resolveTurnWaiters(update.sessionID, update.kind);
  }
  const pet = petForSession(update.sessionID);
  if (pet === undefined) return;
  const label = pet.sessionTitle ?? "session";
  switch (update.kind) {
    case "enqueued":
      applyReaction(pet, "waving", `${label}: 收到你的消息`);
      return;
    case "started":
      applyReaction(pet, update.tool === undefined ? "working" : "running", update.tool === undefined ? undefined : `${label}: ${update.tool}`);
      return;
    case "succeeded":
      applyReaction(pet, "success", `${label}: 完成`);
      return;
    case "failed":
      applyReaction(pet, "error", `${label}: 失败`);
      return;
    case "interrupted":
      // A stopped turn leaves any pending question dead; the user never
      // answers a form whose agent loop is gone.
      for (const [formID, form] of pendingForms) {
        if (form.sessionID === update.sessionID) pendingForms.delete(formID);
      }
      applyReaction(pet, "idle", `${label}: 已中断`);
      return;
    case "waiting":
      applyReaction(pet, "waiting", update.tool === undefined ? `${label}: 需要你批准` : `${label}: 等你批准 ${update.tool}`);
      return;
  }
}

/** Start the shared SSE watcher once; it reconnects on its own afterwards. */
function startWatch(): void {
  if (watch !== undefined) return;
  watch = new OpenCodeWatch({
    onStatus: handleWatchStatus,
    onEvent: (event) => {
      // The step/text events are high-frequency; only surface the ones that
      // give the pet something meaningful to say, and only for its session.
      const sessionID = event.sessionID;
      if (event.type === "form.created") {
        // The agent parked on a question form. Route it to the pet bound to
        // that session; the panel renders the fields and replies through the
        // form endpoint, which is how the OpenCode web dock answers too.
        const ask = parseFormCreated(event.payload);
        if (ask === undefined) return;
        const pet = petForSession(ask.sessionID);
        if (pet === undefined || pet.endpoint === undefined || pet.window.isDestroyed()) return;
        pendingForms.set(ask.formID, {
          sessionID: ask.sessionID,
          endpoint: pet.endpoint,
          fieldKeys: ask.fieldKeys,
        });
        const { sessionID: _ignored, ...card } = ask;
        pet.window.webContents.send("openpets:pet-ask", card);
        applyReaction(pet, "waiting", `${pet.sessionTitle ?? "session"}: 需要你确认`);
        return;
      }
      if (sessionID === undefined) return;
      const pet = petForSession(sessionID);
      if (pet === undefined) return;
      if (event.type === "session.step.started") applyReaction(pet, "thinking", "想了想下一步");
      if (event.type === "session.step.ended") applyReaction(pet, "working", "推进了一步");
    },
    onConnected: () => console.log("[opencode] SSE connected"),
    onDisconnected: (reason) => {
      console.log(`[opencode] SSE disconnected: ${reason}`);
      for (const pet of pets.values()) say(pet, "OpenCode 连接断开，正在重连…");
    },
  });
  watch.start();
}

/**
 * Give this pet its own brand-new session for `directory`. Every pet owns
 * exactly one session, so this never reuses an existing one.
 */
async function attachSession(pet: PetInstance, directory: string): Promise<{ ok: boolean; message?: string }> {
  const discovered = await discoverService();
  if (discovered === undefined) return { ok: false, message: "没找到正在运行的 OpenCode 服务（service.json 缺失）" };
  pet.endpoint = discovered;
  pet.directory = directory;
  startWatch();
  try {
    const session = await createSession(discovered, directory, sessionLabel(directory));
    pet.sessionID = session.id;
    pet.sessionTitle = session.title ?? sessionLabel(directory);
    watch?.track({ id: session.id, title: pet.sessionTitle, directory });
    return { ok: true, message: `已创建会话：${pet.sessionTitle}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Interrupt the session's agent loop; throws when the server rejects it. */
async function requestInterrupt(target: ServiceEndpoint, sessionID: string): Promise<void> {
  const response = await fetch(`${target.url}/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`停止失败：HTTP ${response.status}`);
}

/** One idle-to-idle agent loop, bounded so a hung turn cannot park the panel forever. */
const HTTP_TURN_TIMEOUT_MS = 600_000;

/**
 * Run one turn over the direct HTTP path: `POST /prompt {text}` starts the
 * loop, and completion arrives as SSE `session.execution.*` for this session
 * (timeline polling is only the fallback for a missed event). The prompt body
 * never carries a model — the session's own model is the single source of
 * truth, so the pet cannot implicitly override model selection.
 */
async function runHttpTurn(endpoint: ServiceEndpoint, sessionID: string, text: string): Promise<{ kind: "send-failed"; error: string } | { kind: "done"; result: { ok: boolean; reply?: string; error?: string } }> {
  // Small slack: the server timestamps the user message, so a turn "starts" a
  // moment before the POST resolves.
  const startedAt = Date.now() - 2_000;
  try {
    await sendPrompt(endpoint, sessionID, text);
  } catch (error) {
    return { kind: "send-failed", error: error instanceof Error ? error.message : String(error) };
  }
  console.log(`[opencode-http] prompt sent session=${sessionID}`);
  return {
    kind: "done",
    result: await new Promise((resolve) => {
      let settled = false;
      const waiters = turnWaiters.get(sessionID) ?? new Set();
      turnWaiters.set(sessionID, waiters);
      const finish = (result: { ok: boolean; reply?: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        waiters.delete(waiter);
        if (waiters.size === 0) turnWaiters.delete(sessionID);
        resolve(result);
      };
      const waiter = (kind: TurnCompletionKind): void => {
        void (async () => {
          // Terminal event received: give the asynchronous message projection a
          // moment, then read the transcript for the finished answer.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const result = await turnResultAfter(endpoint, sessionID, startedAt).catch(() => undefined);
            if (result !== undefined) { finish(result); return; }
            // An interrupted turn never completes its message; report the stop
            // instead of waiting out the retries.
            if (kind === "interrupted") { finish({ ok: false, error: "已停止思考" }); return; }
            await new Promise((done) => setTimeout(done, 400));
          }
          finish({ ok: false, error: "回合已结束，但没有可显示的回复" });
        })();
      };
      waiters.add(waiter);
      // Fallback for a missed SSE event: poll the projected transcript.
      const poll = setInterval(() => {
        void turnResultAfter(endpoint, sessionID, startedAt)
          .then((result) => { if (result !== undefined) finish(result); })
          .catch(() => undefined);
      }, 2_500);
      poll.unref?.();
      const watchdog = setTimeout(() => finish({ ok: false, error: "回复超时（10 分钟）" }), HTTP_TURN_TIMEOUT_MS);
      watchdog.unref?.();
    }),
  };
}

/**
 * Wait for the agent to answer a prompt we just sent, then return the newest
 * assistant text. Polls the projected transcript until a new assistant row
 * appears after `promptText`, or the timeout expires.
 */
async function followReply(target: ServiceEndpoint, sessionID: string, promptText: string, timeoutMs = 30_000): Promise<{ ok: boolean; reply?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let sawUser = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const timeline = await readTimeline(target, sessionID).catch(() => undefined);
    if (timeline === undefined) continue;
    let userIndex = -1;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const entry = timeline[i];
      if (entry !== undefined && entry.role === "user" && entry.text.includes(promptText)) { userIndex = i; break; }
    }
    if (userIndex >= 0) sawUser = true;
    if (!sawUser) continue;
    // Only look at rows produced after our prompt: earlier turns (including
    // their failures) must not be mistaken for the answer to this one.
    const since = userIndex >= 0 ? timeline.slice(userIndex + 1) : [];
    const failure = since.find((entry) => entry.error !== undefined);
    if (failure !== undefined) {
      return { ok: false, error: `OpenCode 报错：${failure.error ?? "未知错误"}` };
    }
    let answer: { text: string } | undefined;
    for (const entry of since) {
      if (entry.role === "assistant" && entry.text.trim().length > 0) answer = entry;
    }
    if (answer !== undefined) return { ok: true, reply: answer.text };
  }
  return { ok: false, error: "30 秒内没等到回复，OpenCode 可能还在生成；稍后可在面板历史里看到结果" };
}

/**
 * Bind a session without moving the window, used on plain launch so the chat
 * panel works even when the pet was not summoned from Explorer. Silent on
 * failure: the user only learns about it when they try to send a message.
 */
async function connectDefault(pet: PetInstance): Promise<void> {
  const result = await attachSession(pet, desktopDirectory());
  if (result.ok) say(pet, `${pet.sessionTitle ?? ""} · 已连接`);
  else console.log(`[opencode] startup connect failed: ${result.message ?? "unknown"}`);
}

/**
 * Give `pet` a session for `directory`, place it at the requested spot and
 * greet. Each summon targets one pet window; nothing is shared globally.
 */
async function runSummon(pet: PetInstance, request: SummonRequest): Promise<void> {
  const win = pet.window;
  if (!win.isDestroyed()) {
    // The Explorer verb cannot report the click point, so a missing position
    // falls back to the live cursor location.
    const cursor = screen.getCursorScreenPoint();
    const target = { ...request, x: request.x ?? cursor.x, y: request.y ?? cursor.y };
    const area = screen.getDisplayNearestPoint({ x: target.x, y: target.y }).workArea;
    const placed = placeAtCursor(target, area, collapsedWindowSize);
    win.setPosition(placed.x, placed.y);
    if (!win.isVisible()) win.show();
    win.focus();
  }
  sayWelcome(pet);
  const result = await attachSession(pet, request.directory);
  say(pet, result.ok ? `${sessionLabel(request.directory)} · ${result.message ?? ""}` : `召唤失败：${result.message ?? "未知错误"}`);
  publishPanelState(pet);
}

/** Expand/collapse one pet's window carrier for its chat panel (anchors the pet in place). */
function setChatExpanded(pet: PetInstance, next: boolean): void {
  const win = pet.window;
  console.log(`[pet] setChatExpanded id=${win.webContents.id} next=${next} current=${pet.chatExpanded}`);
  if (pet.chatExpanded === next) return;
  if (win.isDestroyed()) return;
  pet.chatExpanded = next;
  const wasResizable = win.isResizable();
  win.setResizable(true);
  try {
    if (next) {
      const collapsed = win.getBounds();
      const bounds = expandedBoundsFor({ x: collapsed.x, y: collapsed.y });
      // Remember where the pet must reappear: its pre-expand origin plus any
      // clamp shift, so collapsing restores the exact original spot.
      pet.collapsedAnchor = { x: collapsed.x + bounds.petOffset.x, y: collapsed.y + bounds.petOffset.y };
      win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, false);
    } else {
      const anchor = pet.collapsedAnchor ?? (() => {
        const bounds = win.getBounds();
        return clampPointToWorkArea({ x: bounds.x, y: bounds.y + (collapsedWindowSize.height - bounds.height) }, collapsedWindowSize);
      })();
      win.setBounds({ ...anchor, width: collapsedWindowSize.width, height: collapsedWindowSize.height }, false);
    }
  } finally {
    win.setResizable(wasResizable);
  }
  console.log(`[pet] chat bounds now ${JSON.stringify(win.getBounds())}`);
  publishPanelState(pet);
}

// The 5s reaction polling loop (表情轮询) was removed per product request:
// the pet only plays reactions on explicit events (welcome on load, tray
// 「切换下一个表情」, future OpenCode session events).

/**
 * Render the page for one specific pet. Each instance gets its own file so
 * several pets with different spritesheets can load at the same time without
 * overwriting each other.
 */
async function writePetPage(petEntry: PetStoreEntry, instanceKey: number): Promise<string> {
  const dir = join(app.getPath("userData"), "rendered-pets");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `standalone-pet-${instanceKey}.html`);
  const spriteUrl = petEntry.builtIn
    ? pathToFileURL(spritesheetPath).toString()
    : pathToFileURL(petEntry.spritesheetPath).toString();
  const html = createPetPageHtml({
    scale,
    spritesheetUrl: spriteUrl,
    atlasRows: petEntry.spriteVersionNumber === 2 ? 11 : 9,
    petName: petEntry.displayName,
  });
  // Write to a temp file first, then rename: a partial write can never leave a
  // zero-byte page behind, which previously broke the pet window on startup.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, html, "utf8");
  await rename(tmpPath, filePath);
  return filePath;
}

/**
 * Pick the next appearance in rotation: the user's default pet first, then
 * every installed pet in turn. Pets already on screen are skipped, so a new
 * window never duplicates an existing look while another option exists.
 */
async function pickPetEntryForNewWindow(): Promise<PetStoreEntry> {
  const installed = await listInstalledPets(app.getPath("userData")).catch(() => []);
  const choices: PetStoreEntry[] = [
    currentPetEntry,
    ...installed.filter((entry) => entry.id !== currentPetEntry.id),
  ];
  const inUse = new Set<string>();
  for (const pet of pets.values()) inUse.add(pet.petEntry.id);
  const start = nextPetEntryIndex % choices.length;
  for (let offset = 0; offset < choices.length; offset += 1) {
    const candidate = choices[(start + offset) % choices.length];
    if (candidate === undefined) continue;
    if (inUse.has(candidate.id) && inUse.size < choices.length) continue;
    nextPetEntryIndex = (start + offset + 1) % choices.length;
    return candidate;
  }
  const fallback = choices[start] ?? currentPetEntry;
  nextPetEntryIndex = (start + 1) % choices.length;
  return fallback;
}

function bottomRightPosition(width: number, height: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    x: display.x + display.width - width - 24,
    y: display.y + display.height - height - 8,
  };
}

/**
 * Show one pet's own right-click menu. Items are built lazily so model and
 * session lists always reflect the live server state.
 */
async function showPetContextMenu(pet: PetInstance): Promise<void> {
  const win = pet.window;
  if (win.isDestroyed()) return;
  const target = pet.endpoint ?? (await discoverService());
  if (target !== undefined) pet.endpoint = target;

  const modelItems: Electron.MenuItemConstructorOptions[] = [];
  const sessionItems: Electron.MenuItemConstructorOptions[] = [];

  if (target === undefined) {
    modelItems.push({ label: "OpenCode 未连接", enabled: false });
    sessionItems.push({ label: "OpenCode 未连接", enabled: false });
  } else {
    const models = await listModels(target).catch(() => undefined);
    if (models === undefined) {
      modelItems.push({ label: "读取模型列表失败", enabled: false });
    } else if (models.length === 0) {
      modelItems.push({ label: "没有可用模型", enabled: false });
    } else {
      const current = await getSession(target, pet.sessionID ?? "").catch(() => undefined);
      const currentModel = current?.model;
      for (const model of models) {
        const checked = currentModel !== undefined && currentModel.providerID === model.providerID && currentModel.id === model.id;
        modelItems.push({
          label: `${model.name} (${model.providerID})`,
          type: "checkbox",
          checked,
          click: () => {
            void (async () => {
              const sessionID = pet.sessionID;
              if (sessionID === undefined) { say(pet, "还没有绑定会话"); return; }
              try {
                console.log(`[model] switch session=${sessionID} -> ${model.providerID}/${model.id}`);
                await setSessionModel(target, sessionID, { providerID: model.providerID, id: model.id });
                // Do not read the session back here: `ModelSelected` is projected
                // asynchronously, so a 204 is followed by a short window where the
                // row still holds the previous model. The switch itself is the
                // confirmation; the panel refreshes from the server on next open.
                console.log(`[model] switched session=${sessionID}`);
                // Confirm the switch took effect before the panel re-reads it.
                // The projection lands asynchronously; this waits for it.
                const confirmed = await getSessionAfterModelSwitch(target, sessionID, {
                  providerID: model.providerID,
                  id: model.id,
                }).catch(() => undefined);
                console.log(
                  `[model] confirmed=${confirmed?.model ? confirmed.model.providerID + "/" + confirmed.model.id : "null"} session=${sessionID}`,
                );
                say(pet, `模型已切换：${model.name}`);
                publishPanelState(pet);
              } catch (error) {
                say(pet, `切换模型失败：${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          },
        });
      }
    }

    const sessions = await listSessions(target).catch(() => undefined);
    if (sessions === undefined) {
      sessionItems.push({ label: "读取会话列表失败", enabled: false });
    } else if (sessions.length === 0) {
      sessionItems.push({ label: "没有会话", enabled: false });
    } else {
      for (const session of sessions.slice(0, 20)) {
        const directory = session.location?.directory ?? "";
        sessionItems.push({
          label: `${session.title ?? session.id} — ${basename(directory) || "?"}`,
          type: "radio",
          checked: session.id === pet.sessionID,
          click: () => {
            pet.sessionID = session.id;
            pet.sessionTitle = session.title ?? sessionLabel(directory);
            pet.directory = directory;
            watch?.track({ id: session.id, title: pet.sessionTitle, directory });
            say(pet, `已切换会话：${pet.sessionTitle}`);
            publishPanelState(pet);
          },
        });
      }
    }
  }

  const menu = Menu.buildFromTemplate([
    { label: "选择 model", submenu: modelItems },
    {
      label: "新建 session",
      click: () => {
        // A new session gets its own new pet window (one pet per session) and
        // the next appearance in rotation, so it does not look identical.
        void dispatchSummon({ directory: pet.directory ?? desktopDirectory() });
      },
    },
    { label: "选择 session", submenu: sessionItems },
    { type: "separator" },
    { label: "关闭宠物", click: () => { win.hide(); } },
  ]);
  menu.popup({ window: win });
}

/**
 * Create one new pet window and register its instance. Every call makes a new
 * window, so a new session always gets its own pet.
 */
function createPetWindow(options: { directory?: string; position?: { x: number; y: number }; petEntry?: PetStoreEntry } = {}): PetInstance {
  const width = 320;
  const height = 300;
  const petEntry = options.petEntry ?? currentPetEntry;
  const window = new BrowserWindow({
    title: "OpenPets pet",
    width,
    height,
    ...(options.position ?? bottomRightPosition(width, height)),
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
  const pet: PetInstance = {
    window,
    petEntry,
    endpoint: undefined,
    sessionID: undefined,
    sessionTitle: undefined,
    directory: options.directory ?? desktopDirectory(),
    lastSpriteState: "idle",
    revertTimer: null,
    idleRevertTimer: null,
    chatExpanded: false,
    collapsedAnchor: null,
  };
  pets.set(window.webContents.id, pet);
  focusedPetId = window.webContents.id;
  // Hide the chat panel when the pet window loses focus. `setChatExpanded`
  // returns early when already collapsed, so this is a no-op most of the time.
  window.on("blur", () => {
    if (pet.chatExpanded) setChatExpanded(pet, false);
  });
  window.on("focus", () => {
    focusedPetId = window.webContents.id;
  });
  // Pet's own right-click menu: model / new session / switch session / hide.
  window.webContents.on("context-menu", () => {
    void showPetContextMenu(pet);
  });
  // Forward renderer console output to the main process stdout so the chat
  // panel interactions can be diagnosed from the terminal.
  window.webContents.on("console-message", (_event, level, message) => {
    console.log(`[renderer:${level}] ${message}`);
  });
  // Re-show the welcome greeting whenever the pet page loads (startup and
  // every later reload, e.g. switching the default pet).
  window.webContents.on("did-finish-load", () => {
    sayWelcome(pet);
    publishPanelState(pet);
  });
  void writePetPage(petEntry, window.webContents.id).then((filePath) => window.loadFile(filePath)).then(() => {
    window.show();
  }).catch((error) => {
    console.error("pet page load failed", error);
  });
  window.on("closed", () => {
    if (pet.revertTimer) clearTimeout(pet.revertTimer);
    if (pet.idleRevertTimer) clearTimeout(pet.idleRevertTimer);
    pets.delete(window.webContents.id);
    if (focusedPetId === window.webContents.id) focusedPetId = undefined;
  });
  const queued = pendingSummons.get(window.webContents.id);
  if (queued !== undefined) {
    pendingSummons.delete(window.webContents.id);
    window.webContents.once("did-finish-load", () => {
      void runSummon(pet, queued);
    });
  }
  return pet;
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
    {
      // Diagnostic path: exercises prompt + followReply without the renderer.
      label: "测试发送 123",
      type: "normal",
      click: () => {
        void (async () => {
          const pet = focusedPet();
          const target = pet?.endpoint;
          const sessionID = pet?.sessionID;
          console.log(`[diag] tray send start endpoint=${String(target)} session=${String(sessionID)}`);
          if (target === undefined || sessionID === undefined) {
            console.log("[diag] tray send aborted: not connected");
            return;
          }
          try {
            await sendPrompt(target, sessionID, "123");
            console.log("[diag] tray sendPrompt ok");
          } catch (error) {
            console.log(`[diag] tray sendPrompt failed: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          const reply = await followReply(target, sessionID, "123").catch((error) => ({ ok: false, error: String(error) }));
          console.log(`[diag] tray reply ${JSON.stringify(reply).slice(0, 400)}`);
        })();
      },
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
    const pet = petForSender(event.sender);
    if (pet === undefined) return;
    event.sender.send("openpets:pet-state", { state: pet.lastSpriteState, message });
  });
  ipcMain.on("openpets:pet-chat-toggle", (event) => {
    const pet = petForSender(event.sender);
    if (pet === undefined) return;
    setChatExpanded(pet, !pet.chatExpanded);
  });
  // Full projected transcript for the bound session, oldest first. The panel
  // calls this on open so the first paint shows real OpenCode history.
  ipcMain.handle("openpets:pet-chat-history", async (event) => {
    // Always report the bound session's title so the panel header can show it
    // even when there is no history yet (a brand-new session).
    const pet = petForSender(event.sender);
    const sessionTitle = pet?.sessionTitle ?? "";
    if (pet === undefined) return { ok: false, error: "宠物已关闭", sessionTitle, messages: [] };
    if (pet.endpoint === undefined) return { ok: false, error: "OpenCode 未连接", sessionTitle, messages: [] };
    if (pet.sessionID === undefined) return { ok: false, error: "当前宠物还没有绑定会话", sessionTitle, messages: [] };
    const messages = await readTimeline(pet.endpoint, pet.sessionID).catch(() => undefined);
    if (messages === undefined) return { ok: false, error: "读取会话历史失败", sessionTitle, messages: [] };
    return { ok: true, sessionTitle, messages };
  });
  // The chat panel shows the model the bound session actually runs on, so the
  // user can tell whether a switch took effect without opening OpenCode.
  ipcMain.handle("openpets:pet-chat-model", async (event) => {
    const pet = petForSender(event.sender);
    if (pet === undefined) return { ok: false, label: "宠物已关闭" };
    if (pet.endpoint === undefined) return { ok: false, label: "OpenCode 未连接" };
    if (pet.sessionID === undefined) return { ok: false, label: "未绑定会话" };
    const session = await getSession(pet.endpoint, pet.sessionID).catch(() => undefined);
    const model = session?.model;
    if (model === undefined) return { ok: true, label: "默认模型（会话未指定）" };
    return { ok: true, label: `${model.providerID}/${model.id}` };
  });
  ipcMain.handle("openpets:pet-chat-send", async (event, raw: unknown) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) return { ok: false, error: "消息为空" };
    if (text.length > 4000) return { ok: false, error: "消息太长（上限 4000 字）" };
    const pet = petForSender(event.sender);
    if (pet === undefined) return { ok: false, error: "宠物已关闭" };
    const sessionID = pet.sessionID;
    if (sessionID === undefined) return { ok: false, error: "当前宠物还没有绑定会话，请稍候或重新召唤" };
    // Plan A: run the turn straight over the HTTP API the OpenCode web app uses.
    // The prompt never carries a model — the session's own model decides every
    // turn, so the pet cannot implicitly override model selection — and a
    // `question` form keeps the loop genuinely parked until the panel replies.
    if (pet.endpoint !== undefined) {
      const http = await runHttpTurn(pet.endpoint, sessionID, text);
      if (http.kind === "done") return http.result;
      console.log(`[opencode-http] send failed, falling back to CLI: ${http.error}`);
    }
    // Fallback: run the turn through the real CLI, exactly like the user does
    // in a terminal. Prompt delivery failed over HTTP, so mirror the session's
    // own model into the invocation to keep the turn on it.
    const directory = watch?.get(sessionID)?.directory ?? pet.directory;
    // The session is the source of truth, so a model the user picked in
    // OpenCode (or in the pet's context menu) is the one this turn runs on.
    const session = pet.endpoint === undefined ? undefined : await getSession(pet.endpoint, sessionID).catch(() => undefined);
    const model = session?.model;
    // A `question` tool call is the agent asking the user to pick an option. The
    // CLI never renders it, so forward it to this pet's panel while the turn is
    // still running; the panel answers by sending the chosen label back as the
    // next prompt, which is how `opencode run` resumes that turn.
    return await runPrompt(sessionID, text, directory, model === undefined ? undefined : { providerID: model.providerID, id: model.id }, (ask) => {
      if (pet.window.isDestroyed()) return;
      pet.window.webContents.send("openpets:pet-ask", ask);
      // A non-interactive CLI run cancels the question immediately and lets
      // the model free-wheel through "reasonable assumptions" — the pet must
      // not look like it is asking and answering itself. Interrupt the
      // server-side loop the moment the card surfaces; the user's submitted
      // answer then starts a fresh turn that sees the Q&A in history.
      if (pet.endpoint !== undefined) void interruptSession(pet.endpoint, sessionID);
    });
  });
  // Answer a question form the agent is parked on (SSE `form.created` route).
  // One reply covers every question of the form, mirroring the OpenCode web
  // dock: the loop resumes the instant this resolves, no follow-up prompt.
  ipcMain.handle("openpets:pet-ask-reply", async (event, payload: unknown) => {
    const record = (typeof payload === "object" && payload !== null ? payload : {}) as { formID?: unknown; answers?: unknown };
    const formID = typeof record.formID === "string" ? record.formID : "";
    const pending = pendingForms.get(formID);
    if (pending === undefined) return { ok: false, error: "问题已失效" };
    const pet = petForSender(event.sender);
    if (pet === undefined) return { ok: false, error: "宠物已关闭" };
    if (pet.sessionID !== pending.sessionID) return { ok: false, error: "会话不匹配" };
    const answers = Array.isArray(record.answers) ? record.answers : [];
    const answer: Record<string, string> = {};
    pending.fieldKeys.forEach((key, index) => {
      const value = answers[index];
      if (typeof value === "string" && value.trim().length > 0) answer[key] = value.trim();
    });
    try {
      await replyForm(pending.endpoint, pending.sessionID, formID, answer);
      pendingForms.delete(formID);
      console.log(`[opencode-http] form replied session=${pending.sessionID} form=${formID} fields=${Object.keys(answer).length}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // User-initiated "stop thinking": kill the CLI turn this pet started, and
  // also interrupt the server-side loop in case it already took the prompt.
  // The session stays bound and usable afterwards.
  ipcMain.handle("openpets:pet-chat-stop", async (event) => {
    const killedLocal = abortRunPrompt();
    const pet = petForSender(event.sender);
    if (pet !== undefined && pet.endpoint !== undefined && pet.sessionID !== undefined) {
      await requestInterrupt(pet.endpoint, pet.sessionID).catch(() => undefined);
    }
    if (!killedLocal) return { ok: false, error: "当前没有进行中的回复" };
    return { ok: true };
  });
  ipcMain.on("openpets:pet-drag-move", (event, payload: unknown) => {
    const pet = petForSender(event.sender);
    if (pet === undefined) return;
    const win = pet.window;
    if (win.isDestroyed()) return;
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
    // Reload every live pet page with the new default sprite.
    for (const pet of pets.values()) {
      if (pet.window.isDestroyed()) continue;
      pet.petEntry = currentPetEntry;
      void writePetPage(currentPetEntry, pet.window.webContents.id).then((filePath) => pet.window.loadFile(filePath));
    }
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

/**
 * Handle a summon request: always spawn a brand-new pet window with its own
 * session for the requested folder.
 */
async function dispatchSummon(request: SummonRequest): Promise<void> {
  const petEntry = await pickPetEntryForNewWindow();
  const pet = createPetWindow({ directory: request.directory, petEntry });
  void runSummon(pet, request);
}

// Explorer invokes one process per click; a second launch forwards its request
// to the running instance instead of stacking duplicate processes.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const request = parseSummonRequest(argv);
    if (request === undefined) {
      const pet = focusedPet();
      pet?.window.show();
      pet?.window.focus();
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
  const firstPet = createPetWindow(
    startupSummon === undefined ? {} : { directory: startupSummon.directory, petEntry: await pickPetEntryForNewWindow() },
  );
  if (startupSummon !== undefined) {
    // The window is already created for this request; drive it directly.
    void runSummon(firstPet, startupSummon);
  } else {
    // Connect on plain launch too: the pet is useful without a context-menu
    // summon, so bind a session for the default folder right away.
    void connectDefault(firstPet);
  }
});

app.on("window-all-closed", () => {
  // Pets are the app; closing the last one exits.
  app.quit();
});

app.on("quit", () => {
  watch?.stop();
  // Quitting ends every pet's session work and clears its timers.
  for (const pet of pets.values()) {
    if (pet.revertTimer) clearTimeout(pet.revertTimer);
    if (pet.idleRevertTimer) clearTimeout(pet.idleRevertTimer);
    if (pet.endpoint !== undefined && pet.sessionID !== undefined) {
      void interruptSession(pet.endpoint, pet.sessionID);
    }
  }
  pets.clear();
});
