/**
 * electron-main.ts
 *
 * Standalone desktop pet app: an original-style transparent, frameless,
 * always-on-top pet window plus the Pets management tab (管理端 → 宠物,
 * only that tab) in a normal management window.
 */

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog, clipboard, Notification } from "electron";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createPetPageHtml } from "./desktop-render.js";
import { createPanelPageHtml } from "./panel-render.js";
import { defaultPetSprite, getConfiguredSpriteStates, isLoopingSpriteState, resolveReactionSpriteState } from "./reaction-animation-mapping.js";
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
  updatePetWardrobePreference,
  wardrobePreferenceFor,
  type PetStoreEntry,
} from "./pet-store.js";
import { resolveWardrobeOutfit, describeAutomaticOutfit, defaultOutfitId, autoOutfitId, type WardrobePreferences, type WardrobeRule } from "./pet-wardrobe-core.js";
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
  toolSummary,
  replyForm,
  deleteSession,
  abortRunPrompt,
  runPrompt,
  sendPrompt,
  setSessionModel,
  turnResultAfter,
  type ServiceEndpoint,
} from "./opencode-client.js";
import { OpenCodeWatch } from "./opencode-watch.js";
import { ensureOpenCodeService, type EnsureResult } from "./opencode-ensure.js";
import { desktopDirectory, parseSummonRequest, placeAtCursor, type SummonRequest } from "./summon.js";

const scale = 0.75;
// Collapsed carrier is the scaled sprite footprint plus a small margin, plus a
// reserved strip above the sprite for the speech bubble. The sprite is pinned to
// the window's bottom-right corner, so growing the window only adds room above
// the pet and never moves it on screen.
const PET_WINDOW_MARGIN = 8;
const BUBBLE_STRIP_HEIGHT = 90;
const collapsedWindowSize = {
  width: Math.ceil(defaultPetSprite.frameWidth * scale) + PET_WINDOW_MARGIN * 2,
  height: Math.ceil(defaultPetSprite.frameHeight * scale) + PET_WINDOW_MARGIN * 2 + BUBBLE_STRIP_HEIGHT,
};
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
  /** Whether the floating chat panel window is currently shown. */
  chatExpanded: boolean;
  /**
   * The chat panel's own BrowserWindow. Lazily created on first open and then
   * reused: closing the panel only hides it, so the transcript keeps its DOM.
   * The pet window is never resized, moved or otherwise involved.
   */
  panelWindow: BrowserWindow | null;
  /** The wardrobe outfit id currently rendered (undefined = base atlas). */
  wardrobeOutfitId: string | undefined;
  /** The atlas file path currently rendered (undefined = base atlas). */
  wardrobeAtlasPath: string | undefined;
  /** Walk-about ticker; only armed while the pet is idle and not dragging. */
  walkTimer: NodeJS.Timeout | null;
  /** True while a drag is in progress (suppresses reactions and walking). */
  dragging: boolean;
  /** Display id the pet's page zoom was last synced against. */
  displayId: number;
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

// Chat panel: its own floating window, anchored to the pet like an Ant Design
// Popconfirm. The pet window keeps this size forever; nothing here touches it.
const PANEL_SIZE = { width: 560, height: 700 };
// Gap between the pet's window edge and the panel, so the panel never covers it.
// Kept small: the carrier window already pads the sprite by PET_WINDOW_MARGIN
// plus the reserved bubble strip, so a large gap here reads as "far from pet".
const PANEL_GAP = 8;

// Pick the work area of the display that actually contains the anchor point, so a
// pet dragged to a secondary monitor opens its panel on that monitor instead of
// snapping back to the primary one.
function workAreaForPoint(point: { x: number; y: number }): Electron.Rectangle {
  return screen.getDisplayNearestPoint(point).workArea;
}

/**
 * Popconfirm-style placements, named after the Ant Design component: the axis
 * says which side of the anchor the panel sits on, the suffix says how the
 * panel's other axis is aligned with the anchor's edge.
 */
type PanelSide = "top" | "bottom" | "left" | "right";
type PanelAlign = "start" | "center" | "end";
type PanelPlacement = { side: PanelSide; align: PanelAlign };

/** Try to place the panel on `side`, returning bounds or null when it overflows. */
function placeOnSide(
  anchor: Electron.Rectangle,
  size: { width: number; height: number },
  side: PanelSide,
  align: PanelAlign,
  area: Electron.Rectangle,
): { x: number; y: number } | null {
  let x: number;
  let y: number;
  if (side === "top" || side === "bottom") {
    y = side === "top" ? anchor.y - PANEL_GAP - size.height : anchor.y + anchor.height + PANEL_GAP;
    const leftEdge = anchor.x;
    const centerEdge = anchor.x + (anchor.width - size.width) / 2;
    const rightEdge = anchor.x + anchor.width - size.width;
    x = align === "start" ? leftEdge : align === "end" ? rightEdge : centerEdge;
  } else {
    x = side === "left" ? anchor.x - PANEL_GAP - size.width : anchor.x + anchor.width + PANEL_GAP;
    const topEdge = anchor.y;
    const centerEdge = anchor.y + (anchor.height - size.height) / 2;
    const bottomEdge = anchor.y + anchor.height - size.height;
    y = align === "start" ? topEdge : align === "end" ? bottomEdge : centerEdge;
  }
  if (x < area.x || y < area.y || x + size.width > area.x + area.width || y + size.height > area.y + area.height) {
    return null;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Compute the panel window bounds next to `anchor` (the pet's window rect).
 *
 * Pure geometry, no window mutation: pick the preferred side from the free
 * space around the pet, then fall back through the other sides when the panel
 * would leave the work area, and finally clamp so a very large panel on a very
 * small screen still stays visible.
 */
function computePanelBounds(
  anchor: Electron.Rectangle,
  size: { width: number; height: number },
  area: Electron.Rectangle,
): { x: number; y: number; width: number; height: number; placement: PanelPlacement } {
  const spaceUp = anchor.y - area.y;
  const spaceDown = area.y + area.height - (anchor.y + anchor.height);
  const spaceLeft = anchor.x - area.x;
  const spaceRight = area.x + area.width - (anchor.x + anchor.width);
  // Prefer the roomiest vertical side; fall back to horizontal only when neither
  // vertical side can hold the panel.
  const verticalFirst: PanelSide[] = spaceDown >= spaceUp ? ["bottom", "top"] : ["top", "bottom"];
  const horizontalFirst: PanelSide[] = spaceRight >= spaceLeft ? ["right", "left"] : ["left", "right"];
  const fitsVertically = Math.max(spaceUp, spaceDown) >= size.height + PANEL_GAP;
  const sides = fitsVertically ? [...verticalFirst, ...horizontalFirst] : [...horizontalFirst, ...verticalFirst];
  // Centre alignment is the nicest; nudge to a flush edge when the centred
  // variant would overflow the work area.
  const aligns: PanelAlign[] = ["center", "start", "end"];
  for (const side of sides) {
    for (const align of aligns) {
      const placed = placeOnSide(anchor, size, side, align, area);
      if (placed !== null) return { ...placed, width: size.width, height: size.height, placement: { side, align } };
    }
  }
  // Nothing fits cleanly: keep the roomiest side and clamp inside the work area.
  const side = sides[0] ?? "bottom";
  const align: PanelAlign = "center";
  const rough = placeOnSide(anchor, size, side, align, {
    x: -1e6, y: -1e6, width: 2e6, height: 2e6,
  }) ?? { x: anchor.x, y: anchor.y + anchor.height + PANEL_GAP };
  return {
    x: Math.min(Math.max(rough.x, area.x + 2), area.x + area.width - size.width - 2),
    y: Math.min(Math.max(rough.y, area.y + 2), area.y + area.height - size.height - 2),
    width: size.width,
    height: size.height,
    placement: { side, align },
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
  cancelWalk(pet);
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
      if (pet.window.isDestroyed()) return;
      pet.lastSpriteState = "idle";
      pet.window.webContents.send("openpets:pet-state", { state: "idle" });
      scheduleWalk(pet);
    }, revert + 200);
    pet.revertTimer.unref?.();
  }
}

/**
 * Clamp a pet window's Y so the visible sprite — not the whole carrier —
 * stays inside the work area. The carrier adds a transparent bubble strip
 * (90px) plus an 8px margin above the sprite and an 8px margin below it, so
 * those invisible strips may hang off the screen top and behind the
 * taskbar; clamping the bare window instead would stop the pet's feet at
 * roughly the vertical middle of the screen.
 */
function clampCarrierY(y: number, height: number, area: Electron.Rectangle): number {
  const minY = area.y + 2 - BUBBLE_STRIP_HEIGHT - PET_WINDOW_MARGIN;
  const maxY = area.y + area.height - 2 - height + PET_WINDOW_MARGIN;
  return Math.min(Math.max(y, minY), Math.max(minY, maxY));
}

/**
 * Per-display carrier geometry: the carrier's DIP size is fixed — the pet
 * page lays out in CSS pixels that exactly fill it, so keeping these
 * constants across monitors with different DPI scales (100% side screens vs
 * a 125% laptop panel) keeps the sprite fully visible everywhere. The only
 * thing cross-DPI moves need is putting the size back when Chromium
 * re-anchors it (see the drag handler / walkOnce).
 */

/** Bring one pet window's size back to the fixed carrier size. */
function restoreCarrierSize(pet: PetInstance): void {
  if (pet.window.isDestroyed()) return;
  const after = pet.window.getBounds();
  if (after.width !== collapsedWindowSize.width || after.height !== collapsedWindowSize.height) {
    // Keep the sprite's bottom edge where it is: the sprite sits at the
    // window bottom (8px margin), so re-anchoring from the bottom stops the
    // pet visibly jumping under the user's pointer.
    const bottom = after.y + after.height - PET_WINDOW_MARGIN;
    const area = workAreaForPoint({ x: after.x + Math.floor(after.width / 2), y: bottom });
    pet.window.setBounds({
      x: after.x + Math.round((after.width - collapsedWindowSize.width) / 2),
      y: clampCarrierY(bottom - collapsedWindowSize.height + PET_WINDOW_MARGIN, collapsedWindowSize.height, area),
      width: collapsedWindowSize.width,
      height: collapsedWindowSize.height,
    });
  }
}

/**
 * Reset the page zoom anchor after a display change.
 *
 * Chromium auto-compensates page zoom when a window lands on a monitor with
 * a different DPI scale (anchored to the monitor seen at creation), which
 * drifts `devicePixelRatio` away from the screen scale and makes the sprite
 * shrink or crop on every crossing. Pinning the zoom to 1/scaleFactor keeps
 * the page at devicePixelRatio 1: one physical sprite size on every screen,
 * exactly filling the fixed-size carrier.
 */
function syncPetDisplay(pet: PetInstance, display: Electron.Display): void {
  if (pet.window.isDestroyed() || pet.displayId === display.id) return;
  pet.displayId = display.id;
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
  pet.window.webContents.setZoomFactor(1 / scale);
}

/**
 * Show a directional walk pose without touching the reaction/revert machinery.
 * Used by drag feedback and the idle walk-about ticker; both are "cosmetic"
 * states that must not schedule a revert or clobber an agent reaction.
 */
function pushWalkState(pet: PetInstance, state: "running-left" | "running-right" | "idle"): void {
  if (pet.window.isDestroyed()) return;
  pet.lastSpriteState = state;
  pet.window.webContents.send("openpets:pet-state", { state });
}

/** Cancel any pending idle walk; called on drag start and on reactions. */
function cancelWalk(pet: PetInstance): void {
  if (pet.walkTimer !== null) {
    clearTimeout(pet.walkTimer);
    pet.walkTimer = null;
  }
}

/**
 * Occasionally let an idle pet walk a short distance left or right, playing
 * the directional rows that the fixed window otherwise never shows. The pet
 * only walks while truly idle: no reaction, no drag, no panel open.
 */
function scheduleWalk(pet: PetInstance): void {
  cancelWalk(pet);
  const delay = 12_000 + Math.random() * 18_000;
  pet.walkTimer = setTimeout(() => {
    pet.walkTimer = null;
    if (pet.window.isDestroyed()) return;
    if (pet.dragging || pet.chatExpanded) { scheduleWalk(pet); return; }
    if (pet.lastSpriteState !== "idle") { scheduleWalk(pet); return; }
    void walkOnce(pet);
  }, delay);
  pet.walkTimer.unref?.();
}

/** One short walk: pick a direction, glide the window, then return to idle. */
async function walkOnce(pet: PetInstance): Promise<void> {
  if (pet.window.isDestroyed()) return;
  const win = pet.window;
  const right = Math.random() < 0.5;
  const distance = 24 + Math.round(Math.random() * 40);
  pushWalkState(pet, right ? "running-right" : "running-left");
  const start = win.getBounds();
  // Clamp against the display the pet currently lives on, keyed from the
  // window centre. The helper clampPointToWorkArea() picks the display
  // nearest the *target* point instead, so a pet near a screen edge could
  // have its walk target clamped into a neighbouring monitor (or a
  // coordinate gap between monitors) and silently walk off the visible
  // desktop. Staying on the home display keeps the pet on screen.
  const homeArea = workAreaForPoint({
    x: start.x + Math.floor(start.width / 2),
    y: start.y + Math.floor(start.height / 2),
  });
  syncPetDisplay(pet, screen.getDisplayNearestPoint({
    x: start.x + Math.floor(start.width / 2),
    y: start.y + Math.floor(start.height / 2),
  }));
  const clampWalkX = (x: number): number =>
    Math.min(Math.max(x, homeArea.x + 2), Math.max(homeArea.x + 2, homeArea.x + homeArea.width - collapsedWindowSize.width - 2));
  // Same sprite-based rule as dragging (clampCarrierY): the transparent
  // bubble strip above the sprite may hang off the screen top, so the walk
  // keeps the pet's feet inside the work area instead of pinning the whole
  // carrier window inside it.
  const clampWalkY = (y: number): number => clampCarrierY(y, collapsedWindowSize.height, homeArea);
  const startY = clampWalkY(start.y);
  const targetX = clampWalkX(start.x + (right ? distance : -distance));
  const steps = 12;
  const stepX = (targetX - start.x) / steps;
  for (let i = 0; i < steps; i += 1) {
    if (win.isDestroyed() || pet.dragging) break;
    if (pet.lastSpriteState !== "running-left" && pet.lastSpriteState !== "running-right") break;
    const bounds = win.getBounds();
    // Re-clamp every step so rounding drift or a drag that raced the walk
    // cannot accumulate past the home display's edge either.
    win.setPosition(Math.round(clampWalkX(bounds.x + stepX)), Math.round(clampWalkY(bounds.y)));
    restoreCarrierSize(pet);
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  if (win.isDestroyed()) return;
  if (pet.lastSpriteState === "running-left" || pet.lastSpriteState === "running-right") {
    pushWalkState(pet, "idle");
  }
  scheduleWalk(pet);
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

/**
 * The sprite's rectangle inside a pet carrier window.
 *
 * The sprite is pinned to the bottom-right corner, inset by PET_WINDOW_MARGIN;
 * everything above it is transparent space reserved for the speech bubble.
 * Panel placement uses this so the panel hugs the pet instead of the window.
 */
function petSpriteBounds(windowBounds: Electron.Rectangle): Electron.Rectangle {
  const spriteWidth = collapsedWindowSize.width;
  const spriteHeight = collapsedWindowSize.height - BUBBLE_STRIP_HEIGHT;
  return {
    x: windowBounds.x + windowBounds.width - spriteWidth,
    y: windowBounds.y + windowBounds.height - spriteHeight,
    width: spriteWidth,
    height: spriteHeight,
  };
}

function clampPointToWorkArea(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  const area = workAreaForPoint(point);
  return {
    x: Math.min(Math.max(point.x, area.x + 2), area.x + area.width - size.width - 2),
    y: Math.min(Math.max(point.y, area.y + 2), area.y + area.height - size.height - 2),
  };
}

/** Shrink the nominal panel to fit the work area it will be shown on. */
function panelSizeFor(anchor: { x: number; y: number }): { width: number; height: number } {
  const area = workAreaForPoint(anchor);
  return {
    width: Math.max(280, Math.min(PANEL_SIZE.width, area.width - 24)),
    height: Math.max(260, Math.min(PANEL_SIZE.height, area.height - 24)),
  };
}

function publishPanelState(pet: PetInstance | undefined): void {
  if (pet === undefined) return;
  // The panel owns its header now; push the bound session title there so a
  // session switch updates it without waiting for a history round-trip.
  if (pet.panelWindow !== null && !pet.panelWindow.isDestroyed()) {
    pet.panelWindow.webContents.send("openpets:pet-panel-state", {
      chatExpanded: pet.chatExpanded,
      sessionTitle: pet.sessionTitle ?? "",
    });
  }
  // The pet window still needs the flag to keep its own affordances in sync.
  if (!pet.window.isDestroyed()) {
    pet.window.webContents.send("openpets:pet-panel-state", {
      chatExpanded: pet.chatExpanded,
      sessionTitle: pet.sessionTitle ?? "",
    });
  }
}

/** Find the pet that owns a panel window's webContents (or a pet window's). */
function petForPanelSender(sender: Electron.WebContents): PetInstance | undefined {
  const direct = pets.get(sender.id);
  if (direct !== undefined) return direct;
  for (const pet of pets.values()) {
    if (pet.panelWindow !== null && !pet.panelWindow.isDestroyed() && pet.panelWindow.webContents.id === sender.id) return pet;
  }
  return undefined;
}

/**
 * Get (creating on first use) the floating chat panel for `pet`.
 *
 * The panel is a normal frameless always-on-top window that loads
 * `createPanelPageHtml`. It has its own preload so its IPC cannot be confused
 * with the pet window's, and it is hidden rather than destroyed on close so the
 * rendered transcript survives a toggle.
 */
function ensurePanelWindow(pet: PetInstance): BrowserWindow | null {
  if (pet.panelWindow !== null && !pet.panelWindow.isDestroyed()) return pet.panelWindow;
  if (pet.window.isDestroyed()) return null;
  const size = panelSizeFor(pet.window.getBounds());
  const panel = new BrowserWindow({
    title: "OpenPets chat",
    width: size.width,
    height: size.height,
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
      preload: join(projectRoot, "panel-preload.cjs"),
      zoomFactor: 1,
    },
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.setMenu(null);
  pet.panelWindow = panel;
  panel.on("closed", () => {
    if (pet.panelWindow === panel) pet.panelWindow = null;
    if (!pet.window.isDestroyed()) {
      pet.chatExpanded = false;
      publishPanelState(pet);
    }
  });
  // Esc and the in-panel close button both hide the panel; nothing about the
  // pet or its session changes.
  panel.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") setChatExpanded(pet, false);
  });
  // Popconfirm semantics: clicking outside the panel dismisses it. This lives
  // on the panel rather than on the pet because the panel owns focus while it
  // is open; the pet blurs the moment the panel opens and must not count.
  //
  // The latch guards against the blur Chromium fires while the panel is still
  // being activated for the first time, which otherwise closes the panel
  // moments after opening it.
  let panelHasFocused = false;
  panel.on("focus", () => { panelHasFocused = true; });
  panel.on("blur", () => {
    if (!panelHasFocused) return;
    if (!pet.chatExpanded) return;
    // Give the click a chance to land on the pet (which toggles the panel
    // itself) or on the panel again before deciding the user clicked away.
    setTimeout(() => {
      if (pet.window.isDestroyed() || !pet.chatExpanded) return;
      if (panel.isDestroyed()) return;
      if (panel.isFocused()) return;
      const focused = BrowserWindow.getFocusedWindow();
      if (focused !== null && focused === pet.window) return;
      setChatExpanded(pet, false);
    }, 120);
  });
  panel.webContents.on("console-message", (_event, level, message) => {
    console.log(`[panel:${level}] ${message}`);
  });
  const dir = join(app.getPath("userData"), "rendered-pets");
  void mkdir(dir, { recursive: true })
    .then(() => {
      const filePath = join(dir, `standalone-panel-${pet.window.webContents.id}.html`);
      return writeFile(filePath, createPanelPageHtml({ petName: pet.petEntry.displayName }), "utf8").then(() => filePath);
    })
    .then((filePath) => panel.loadFile(filePath))
    .catch((error) => console.error("panel page load failed", error));
  return panel;
}

/**
 * Show a Windows toast when a pet's turn finishes.
 *
 * No-ops when the notification API is unavailable (older Windows, notifications
 * disabled) so a missing toast never breaks the turn pipeline.
 */
function notifyTurnDone(pet: PetInstance, label: string): void {
  if (!Notification.isSupported()) return;
  try {
    const toast = new Notification({
      title: `${pet.petEntry.displayName} 完成了任务`,
      body: `${label}：已回复，点我查看对话`,
      silent: false,
    });
    toast.on("click", () => {
      if (pet.window.isDestroyed()) return;
      setChatExpanded(pet, true);
      pet.window.show();
      pet.window.focus();
    });
    toast.show();
  } catch (error) {
    console.error("notification failed", error);
  }
}

/**
 * Tell the user (once per failure) that OpenCode could not be brought up.
 * The pet cannot work without the service, so failing silently here would
 * leave a stuck "连接中" bubble with no explanation.
 */
function notifyOpenCodeProblem(error: string): void {
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: "OpenPets：OpenCode 未就绪",
      body: error,
      silent: false,
    }).show();
  } catch {
    // Notifications are best-effort; the console log already carries the error.
  }
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
  // Finished work is worth a Windows toast: the user may have switched away
  // while the pet was thinking. Only terminal "succeeded" notifications fire;
  // failures and interrupts already surface as a visible error pose.
  if (update.kind === "succeeded") notifyTurnDone(pet, label);
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

/**
 * Turn one live SSE event into a chat-panel process row, mirroring what the
 * CLI prints while a turn runs ("→ shell  Get-ChildItem …").
 *
 * Two event families carry tool progress:
 * - `session.tool.called/success/failed` with `{ tool | name, input? }`
 * - `message.part.updated` / `message.part.updated.batch` carrying a `part`
 *   whose `type` is `tool` and `state` holds `status` + `input`
 * Both are normalized into `{ id, tool, status, text }`, the shape the panel's
 * `addProcessRow` already renders. Returns undefined for events that are not
 * tool progress.
 */
function readProcessRow(
  type: string,
  raw: unknown,
): { id: string; tool: string; status?: string; text: string } | undefined {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  const payload = asRecord(raw);
  if (payload === undefined) return undefined;

  // `session.tool.*` wraps the real tool record under `payload.data`. Only
  // `called` is a user-visible step: the panel shows one "running" row per
  // tool call and never a completion row, so the other subtypes
  // (input.started / input.ended / progress / success / failed) are dropped.
  if (type.startsWith("session.tool.")) {
    if (type !== "session.tool.called") return undefined;
    const data = asRecord(payload.data);
    if (data === undefined) return undefined;
    const name =
      (typeof data.tool === "string" ? data.tool : undefined) ||
      (typeof data.name === "string" ? data.name : undefined) ||
      "tool";
    const state = asRecord(data.state);
    const input = asRecord(state?.input) ?? asRecord(data.input);
    const id =
      (typeof data.callID === "string" ? data.callID : undefined) ||
      (typeof data.id === "string" ? data.id : undefined);
    if (id === undefined) return undefined;
    return { id, tool: name, status: "running", text: toolSummary(name, input) };
  }

  // `message.part.updated*` wraps the tool block under `part`.
  const part = asRecord(payload.part) ?? payload;
  const kind = typeof part.type === "string" ? part.type : "";
  if (type.startsWith("session.tool.")) {
    // Legacy tool feed: payload itself is the tool record.
  } else if (kind !== "tool") {
    // A `message.part.updated` for text/reasoning/step is not tool progress.
    return undefined;
  }

  const name =
    (typeof part.tool === "string" ? part.tool : undefined) ||
    (typeof part.name === "string" ? part.name : undefined) ||
    (typeof payload.tool === "string" ? payload.tool : undefined) ||
    (typeof payload.name === "string" ? payload.name : undefined) ||
    "tool";
  const state = asRecord(part.state) ?? asRecord(payload.state);
  let status = typeof state?.status === "string" ? state.status : undefined;
  if (status === undefined) {
    if (type === "session.tool.success") status = "completed";
    else if (type === "session.tool.failed") status = "error";
    else if (type === "session.tool.called") status = "running";
  }
  const input = asRecord(state?.input) ?? asRecord(part.input) ?? asRecord(payload.input);
  // The panel de-duplicates process rows by this id, so it must be the tool
  // call id and must stay identical across every event of the same call.
  // A synthesized fallback would mint a fresh id per event and flood the
  // panel with duplicate rows, so give up instead of guessing.
  const id =
    (typeof part.callID === "string" ? part.callID : undefined) ||
    (typeof payload.callID === "string" ? payload.callID : undefined) ||
    (typeof part.id === "string" ? part.id : undefined) ||
    (typeof payload.id === "string" ? payload.id : undefined);
  if (id === undefined) return undefined;
  return { id, tool: name, text: toolSummary(name, input), ...(status === undefined ? {} : { status }) };
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
        // The panel renders question forms now. Open it first so the user sees
        // the options instead of a silently parked turn.
        if (!pet.chatExpanded) setChatExpanded(pet, true);
        const panel = pet.panelWindow;
        if (panel !== null && !panel.isDestroyed()) panel.webContents.send("openpets:pet-ask", card);
        applyReaction(pet, "waiting", `${pet.sessionTitle ?? "session"}: 需要你确认`);
        return;
      }
      if (sessionID === undefined) return;
      const pet = petForSession(sessionID);
      if (pet === undefined) return;
      // Mirror the CLI progress feed into the chat panel: every tool call/result
      // becomes one process row, pushed incrementally instead of waiting for the
      // turn to end and re-reading history.
      if (event.type.startsWith("session.tool.") || event.type === "message.part.updated" || event.type === "message.part.updated.batch") {
        const panel = pet.panelWindow;
        if (panel !== null && !panel.isDestroyed()) {
          const row = readProcessRow(event.type, event.payload);
          if (row !== undefined) panel.webContents.send("openpets:pet-process", row);
        }
      }
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
  // Bring install + service-start into the same memoized promise so a failed
  // ensure is retried on the next attach instead of caching a failure.
  const ready = await ensureOpenCodeReady();
  if (!ready.ok || ready.endpoint === undefined) {
    return { ok: false, message: ready.error ?? "OpenCode 服务不可用" };
  }
  const discovered = ready.endpoint;
  console.log(`[summon-debug] attachSession directory=${directory} endpoint=${discovered.url}`);
  pet.endpoint = discovered;
  pet.directory = directory;
  startWatch();
  try {
    console.log(`[summon-debug] createSession with directory=${directory} title=${sessionLabel(directory)}`);
    const session = await createSession(discovered, directory, sessionLabel(directory));
    console.log(`[summon-debug] createSession returned id=${session.id} location=${JSON.stringify(session.location)}`);
    pet.sessionID = session.id;
    pet.sessionTitle = session.title ?? sessionLabel(directory);
    watch?.track({ id: session.id, title: pet.sessionTitle, directory });
    return { ok: true, message: `已创建会话：${pet.sessionTitle}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Memoized bring-up of OpenCode (probe → optional install → optional service
 * start). Cleared on failure so the next attach retries; a running service
 * is never restarted or stopped.
 */
let serviceReadyPromise: Promise<EnsureResult> | undefined;
function ensureOpenCodeReady(): Promise<EnsureResult> {
  if (serviceReadyPromise === undefined) {
    serviceReadyPromise = ensureOpenCodeService({
      userDataPath: app.getPath("userData"),
      onProgress: (progress) => console.log(`[opencode-ensure] ${progress.stage}: ${progress.message}`),
    }).then((result) => {
      if (result.ok) {
        console.log(
          `[opencode-ensure] ready url=${result.endpoint?.url} installedHere=${result.installedHere === true} startedHere=${result.startedHere === true}`,
        );
      } else {
        console.log(`[opencode-ensure] FAILED: ${result.error}`);
        serviceReadyPromise = undefined;
        notifyOpenCodeProblem(result.error ?? "未知错误");
      }
      return result;
    });
  }
  return serviceReadyPromise;
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
  console.log(`[summon-debug] runSummon request.directory=${request.directory}`);
  const result = await attachSession(pet, request.directory);
  say(pet, result.ok ? `${sessionLabel(request.directory)} · ${result.message ?? ""}` : `召唤失败：${result.message ?? "未知错误"}`);
  publishPanelState(pet);
}

/**
 * Show or hide a pet's floating chat panel.
 *
 * The pet window is deliberately untouched: it keeps its bounds, its z-order and
 * its input behaviour. The panel is a separate always-on-top window positioned
 * next to the pet, so opening the chat can never move or squeeze the pet.
 */
function setChatExpanded(pet: PetInstance, next: boolean): void {
  const petWin = pet.window;
  if (petWin.isDestroyed()) return;
  console.log(`[pet] setChatExpanded id=${petWin.webContents.id} next=${next} current=${pet.chatExpanded}`);
  if (pet.chatExpanded === next) return;
  pet.chatExpanded = next;
  if (next) {
    const panel = ensurePanelWindow(pet);
    if (panel === null) {
      pet.chatExpanded = false;
      return;
    }
    // Anchor on the sprite, not the whole carrier window: the window reserves a
    // 90px strip above the sprite for the bubble plus an 8px margin, so using
    // its raw bounds would push the panel noticeably away from the pet.
    const anchor = petSpriteBounds(petWin.getBounds());
    const size = panelSizeFor(anchor);
    const area = workAreaForPoint({ x: anchor.x + Math.floor(anchor.width / 2), y: anchor.y + Math.floor(anchor.height / 2) });
    const bounds = computePanelBounds(anchor, size, area);
    console.log(`[pet] panel placement ${bounds.placement.side}/${bounds.placement.align} at ${JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })}`);
    panel.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, false);
    // Show with focus: `showInactive` left the panel unable to receive keyboard
    // input, so the composer could never be typed into. The pet window itself
    // keeps its own focus behavior; focusing the panel is what lets the user
    // type immediately after opening it.
    panel.show();
    panel.focus();
    panel.webContents.send("openpets:pet-panel-state", {
      chatExpanded: true,
      sessionTitle: pet.sessionTitle ?? "",
    });
  } else if (pet.panelWindow !== null && !pet.panelWindow.isDestroyed()) {
    pet.panelWindow.hide();
  }
  publishPanelState(pet);
}

// The 5s reaction polling loop (表情轮询) was removed per product request:
// the pet only plays reactions on explicit events (welcome on load, tray
// 「切换下一个表情」, future OpenCode session events).

/**
 * Which atlas should this pet render right now? Reads wardrobe preferences
 * from state.json and evaluates the schedule against the current moment.
 * Empty catalog result = render the base atlas.
 */
function petRenderPlan(petEntry: PetStoreEntry): { atlasPath?: string; outfitId?: string } {
  if (petEntry.builtIn || petEntry.wardrobe === undefined) return {};
  const prefs = wardrobePreferenceFor(readManagedState(app.getPath("userData")), petEntry.id);
  const outfitId = resolveWardrobeOutfit(petEntry.wardrobe, prefs, new Date());
  if (outfitId === defaultOutfitId) return {};
  const outfit = petEntry.wardrobe.outfits.find((candidate) => candidate.id === outfitId);
  if (outfit === undefined) return {};
  return { atlasPath: join(dirname(petEntry.spritesheetPath), outfit.spritesheetPath), outfitId: outfit.id };
}

/**
 * Render the page for one specific pet. Each instance gets its own file so
 * several pets with different spritesheets can load at the same time without
 * overwriting each other. `plan` may override the displayed atlas (wardrobe).
 */
async function writePetPage(petEntry: PetStoreEntry, instanceKey: number, plan: { atlasPath?: string } = {}): Promise<string> {
  const dir = join(app.getPath("userData"), "rendered-pets");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `standalone-pet-${instanceKey}.html`);
  const spritesheet = plan.atlasPath ?? petEntry.spritesheetPath;
  const spriteUrl = petEntry.builtIn
    ? pathToFileURL(spritesheetPath).toString()
    : pathToFileURL(spritesheet).toString();
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

/** Write + load a pet page for one instance, recording which outfit it shows. */
async function renderPetPage(pet: PetInstance, petEntry: PetStoreEntry): Promise<void> {
  const plan = petRenderPlan(petEntry);
  const filePath = await writePetPage(petEntry, pet.window.webContents.id, plan);
  pet.wardrobeOutfitId = plan.outfitId;
  pet.wardrobeAtlasPath = plan.atlasPath;
  await pet.window.loadFile(filePath);
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
  // Place a brand-new pet on the display that owns the cursor, so creating one
  // while working on a secondary monitor does not drop it on the primary screen.
  const display = workAreaForPoint(screen.getCursorScreenPoint());
  return {
    x: display.x + display.width - width - 24,
    y: display.y + display.height - height - 8,
  };
}

/**
 * Show one pet's own right-click menu. Items are built lazily so model and
 * session lists always reflect the live server state.
 */
/**
 * Delete every session whose transcript is empty, then report the count.
 *
 * Uses `DELETE /api/session/{id}` (`session.remove`), which removes the session
 * and its child sessions. Everything else in the list is untouched: empty means
 * `readTimeline` returned zero messages.
 *
 * Safety: the pet's bound session is skipped so the open chat keeps working,
 * and any session the SSE watcher reports as running is skipped so a live turn
 * is never yanked out from under the user.
 */
async function cleanupEmptySessions(pet: PetInstance): Promise<void> {
  const target = pet.endpoint ?? (await discoverService());
  if (target === undefined) {
    say(pet, "OpenCode 未连接");
    return;
  }
  pet.endpoint = target;
  const sessions = await listSessions(target).catch(() => undefined);
  if (sessions === undefined) {
    say(pet, "读取会话列表失败");
    return;
  }
  let removed = 0;
  let failed = 0;
  for (const session of sessions) {
    if (session.id === pet.sessionID) continue;
    if (watch?.get(session.id)?.status === "running") continue;
    const timeline = await readTimeline(target, session.id).catch(() => undefined);
    if (timeline === undefined || timeline.length > 0) continue;
    try {
      await deleteSession(target, session.id);
      removed += 1;
    } catch (error) {
      failed += 1;
      console.log(`[cleanup] delete failed session=${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const detail = failed > 0 ? `，失败 ${failed} 个` : "";
  say(pet, `已删除空会话 ${removed} 个${detail}`);
  publishPanelState(pet);
}

/** Outfit submenu: auto-follow, base atlas, and one radio per outfit. */
function buildOutfitMenuItems(pet: PetInstance): Electron.MenuItemConstructorOptions[] {
  const wardrobe = pet.petEntry.wardrobe;
  if (pet.petEntry.builtIn || wardrobe === undefined) return [];
  const prefs = wardrobePreferenceFor(readManagedState(app.getPath("userData")), pet.petEntry.id);
  const automatic = describeAutomaticOutfit(wardrobe, prefs, new Date());
  const fixed = prefs?.outfit ?? autoOutfitId;
  const items: Electron.MenuItemConstructorOptions[] = [];
  items.push({
    label: `自动 · ${automatic}`,
    type: "radio",
    checked: fixed === autoOutfitId,
    click: () => void setPetOutfitChoice(pet, autoOutfitId),
  });
  items.push({
    label: "默认装",
    type: "radio",
    checked: fixed === defaultOutfitId,
    click: () => void setPetOutfitChoice(pet, defaultOutfitId),
  });
  for (const outfit of wardrobe.outfits) {
    items.push({
      label: outfit.displayName,
      type: "radio",
      checked: fixed === outfit.id,
      click: () => void setPetOutfitChoice(pet, outfit.id),
    });
  }
  if (prefs?.schedule !== undefined) {
    // Re-reading the creator schedule only matters when a user schedule was
    // saved before; without one there is nothing to restore.
    items.push({
      label: "恢复作者排班",
      click: () => void setPetOutfitChoice(pet, null, { schedule: null }),
    });
  }
  return items;
}

/** Persist the outfit choice and re-render this pet's window. */
async function setPetOutfitChoice(
  pet: PetInstance,
  outfit: string | null,
  extra: { schedule?: WardrobeRule[] | null } = {},
): Promise<void> {
  if (pet.window.isDestroyed()) return;
  const patch: { outfit?: string | null; schedule?: WardrobeRule[] | null } = {};
  if (outfit !== undefined) patch.outfit = outfit;
  if (extra.schedule !== undefined) patch.schedule = extra.schedule;
  if (Object.keys(patch).length === 0) return;
  await updatePetWardrobePreference(app.getPath("userData"), pet.petEntry.id, patch);
  await renderPetPage(pet, pet.petEntry).catch((error) => console.error("wardrobe re-render failed", error));
  if (pet.window.isDestroyed()) return;
  if (outfit === null || outfit === autoOutfitId) say(pet, "已恢复自动换装");
  else if (outfit === defaultOutfitId) say(pet, "已换上默认装");
  else say(pet, `已换装：${pet.petEntry.wardrobe?.outfits.find((candidate) => candidate.id === outfit)?.displayName ?? outfit}`);
  publishPanelState(pet);
}

// ---------------------------------------------------------------------------
// Wardrobe schedule ticker
// ---------------------------------------------------------------------------

let wardrobeTimer: NodeJS.Timeout | undefined;

/**
 * Re-render pets whose scheduled outfit just changed (e.g. 22:00 pajamas).
 * One unref'd timer, re-armed just past each minute boundary; no per-pet
 * timers. Sleep/resume self-corrects on the next tick.
 */
function armWardrobeTimer(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 50);
  const delay = Math.max(1000, next.getTime() - Date.now());
  wardrobeTimer = setTimeout(() => {
    wardrobeTimer = undefined;
    try {
      tickWardrobes();
    } finally {
      armWardrobeTimer();
    }
  }, delay);
  wardrobeTimer.unref?.();
}

function tickWardrobes(): void {
  for (const pet of pets.values()) {
    if (pet.window.isDestroyed() || pet.petEntry.builtIn || pet.petEntry.wardrobe === undefined) continue;
    const plan = petRenderPlan(pet.petEntry);
    if (plan.atlasPath === pet.wardrobeAtlasPath && plan.outfitId === pet.wardrobeOutfitId) continue;
    console.log(`[wardrobe] pet=${pet.petEntry.id} outfit ${pet.wardrobeOutfitId ?? "default"} -> ${plan.outfitId ?? "default"}`);
    void renderPetPage(pet, pet.petEntry);
  }
}

function stopWardrobeTimer(): void {
  if (wardrobeTimer !== undefined) clearTimeout(wardrobeTimer);
  wardrobeTimer = undefined;
}

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
      // A session can be bound to exactly one pet. Skip sessions already owned
      // by another pet so the same session id never appears on two pets.
      const available = sessions.filter((session) => {
        const owner = petForSession(session.id);
        return owner === undefined || owner === pet;
      });
      if (available.length === 0) {
        sessionItems.push({ label: "没有可用的会话", enabled: false });
      }
      for (const session of available.slice(0, 20)) {
        const directory = session.location?.directory ?? "";
        sessionItems.push({
          label: `${session.title ?? session.id} — ${basename(directory) || "?"}`,
          type: "radio",
          checked: session.id === pet.sessionID,
          click: () => {
            // Re-check at click time: another pet may have claimed this session
            // between opening the menu and the click.
            const owner = petForSession(session.id);
            if (owner !== undefined && owner !== pet) {
              say(pet, "这个会话已被其他宠物占用");
              publishPanelState(pet);
              return;
            }
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

  const outfitItems = buildOutfitMenuItems(pet);
  const menu = Menu.buildFromTemplate([
    { label: "选择 model", submenu: modelItems },
    ...(outfitItems.length > 0 ? [{ label: "换装", submenu: outfitItems }] : []),
    {
      label: "新建 session",
      click: () => {
        // A new session gets its own new pet window (one pet per session) and
        // the next appearance in rotation, so it does not look identical.
        void dispatchSummon({ directory: pet.directory ?? desktopDirectory() });
      },
    },
    { label: "选择 session", submenu: sessionItems },
    {
      label: "清理无效会话",
      enabled: target !== undefined,
      click: () => {
        if (win.isDestroyed()) return;
        void cleanupEmptySessions(pet);
      },
    },
    { type: "separator" },
    {
      label: "关闭宠物",
      click: () => {
        if (win.isDestroyed()) return;
        win.hide();
      },
    },
  ]);
  // Building the menu awaits service discovery, model and session lists. The
  // pet window can be destroyed in that gap (e.g. the user closes it while the
  // menu is still loading), and popup then throws "Object has been destroyed".
  if (win.isDestroyed()) return;
  menu.popup({ window: win });
}

/**
 * Create one new pet window and register its instance. Every call makes a new
 * window, so a new session always gets its own pet.
 */
function createPetWindow(options: { directory?: string; position?: { x: number; y: number }; petEntry?: PetStoreEntry } = {}): PetInstance {
  const petEntry = options.petEntry ?? currentPetEntry;
  // The carrier's DIP size is fixed on every monitor: the pet page lays out
  // in CSS pixels that exactly fill it, so the sprite is always fully
  // visible and any cross-DPI rescaling is undone after moves (see
  // restoreCarrierSize).
  const width = collapsedWindowSize.width;
  const height = collapsedWindowSize.height;
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
    panelWindow: null,
    wardrobeOutfitId: undefined,
    wardrobeAtlasPath: undefined,
    walkTimer: null,
    dragging: false,
    displayId: -1,
  };
  pets.set(window.webContents.id, pet);
  focusedPetId = window.webContents.id;
  // (Re)pin the page zoom after every load: the renderer reloads for outfit
  // changes, and each load lets Chromium re-anchor the zoom to the creation
  // display's scale, which would make the pet resize on the other monitors.
  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const b = window.getBounds();
    const target = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const scale = target.scaleFactor > 0 ? target.scaleFactor : 1;
    pet.displayId = target.id;
    window.webContents.setZoomFactor(1 / scale);
  });
  syncPetDisplay(pet, screen.getDisplayNearestPoint({ x: window.getBounds().x, y: window.getBounds().y }));
  // NOTE: the pet window intentionally does NOT close the panel on blur. The
  // panel is a separate window that takes focus when it opens, so a pet blur
  // fires immediately on open and used to close the panel instantly (the
  // "flash then vanish" bug). Dismissing on outside clicks is handled by the
  // panel window's own blur handler in ensurePanelWindow().
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
    // Kick off the idle walk-about ticker after the page is live. sayWelcome
    // already pushed a reaction, so the first walk waits for it to settle.
    scheduleWalk(pet);
  });
  void renderPetPage(pet, petEntry)
    .then(() => {
      window.show();
    })
    .catch((error) => {
      console.error("pet page load failed", error);
    });
  window.on("closed", () => {
    cancelWalk(pet);
    if (pet.revertTimer) clearTimeout(pet.revertTimer);
    if (pet.idleRevertTimer) clearTimeout(pet.idleRevertTimer);
    // The panel is a separate window, so closing the pet must close it too.
    if (pet.panelWindow !== null && !pet.panelWindow.isDestroyed()) pet.panelWindow.destroy();
    pet.panelWindow = null;
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
      ...(entry.wardrobe !== undefined ? { outfitCount: entry.wardrobe.outfits.length } : {}),
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
    const pet = petForPanelSender(event.sender);
    if (pet === undefined) return;
    setChatExpanded(pet, !pet.chatExpanded);
  });
  // The panel's own close button and Esc both route here.
  ipcMain.on("openpets:panel-close", (event) => {
    const pet = petForPanelSender(event.sender);
    if (pet === undefined) return;
    setChatExpanded(pet, false);
  });
  // Temporary diagnostics: the panel runs without a devtools console the user
  // can open, so it forwards log lines here and they land in a file next to the
  // summon log. Remove together with `debugLog` in panel-preload.cjs.
  ipcMain.on("openpets:panel-debug-log", (_event, message: unknown) => {
    try {
      appendFileSync(join(tmpdir(), "openpets-panel.log"), `${new Date().toISOString()} ${String(message)}\n`);
    } catch { /* diagnostics must never break the app */ }
  });
  // Full projected transcript for the bound session, oldest first. The panel
  // calls this on open so the first paint shows real OpenCode history.
  ipcMain.handle("openpets:pet-chat-history", async (event) => {
    // Always report the bound session's title so the panel header can show it
    // even when there is no history yet (a brand-new session).
    const pet = petForPanelSender(event.sender);
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
    const pet = petForPanelSender(event.sender);
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
    const pet = petForPanelSender(event.sender);
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
      const panel = pet.panelWindow;
      if (panel === null || panel.isDestroyed()) return;
      panel.webContents.send("openpets:pet-ask", ask);
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
    const pet = petForPanelSender(event.sender);
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
    const pet = petForPanelSender(event.sender);
    if (pet !== undefined && pet.endpoint !== undefined && pet.sessionID !== undefined) {
      await requestInterrupt(pet.endpoint, pet.sessionID).catch(() => undefined);
    }
    if (!killedLocal) return { ok: false, error: "当前没有进行中的回复" };
    return { ok: true };
  });
  // Write text to the OS clipboard. Renderers cannot use
  // navigator.clipboard here: the pet window is a file:// document, which
  // Chromium treats as a non-secure context, so the async clipboard API is
  // unavailable. Going through the main process also keeps the copy instant
  // and synchronous with the click.
  ipcMain.handle("openpets:pet-copy-text", (_event, payload: unknown) => {
    const text = typeof payload === "string" ? payload : "";
    if (text.length === 0) return { ok: false, error: "没有可复制的内容" };
    clipboard.writeText(text);
    return { ok: true, length: text.length };
  });
  ipcMain.on("openpets:pet-drag-move", (event, payload: unknown) => {
    const pet = petForSender(event.sender);
    if (pet === undefined) return;
    const win = pet.window;
    if (win.isDestroyed()) return;
    const dx = typeof (payload as { dx?: unknown } | null)?.dx === "number" ? Math.round((payload as { dx: number }).dx) : 0;
    const dy = typeof (payload as { dy?: unknown } | null)?.dy === "number" ? Math.round((payload as { dy: number }).dy) : 0;
    if (dx === 0 && dy === 0) return;
    pet.dragging = true;
    cancelWalk(pet);
    // Face the drag direction: dragging left plays running-left, right plays
    // running-right. Tiny horizontal jitter is ignored so the pose does not
    // flicker while dragging mostly vertically.
    if (Math.abs(dx) >= 2) {
      const facing = dx < 0 ? "running-left" : "running-right";
      if (pet.lastSpriteState !== facing) pushWalkState(pet, facing);
    }
    // Clamping policy while dragging:
    //   x — the whole virtual desktop (union of every display's work area),
    //       so the pet can be carried across monitors but not past the
    //       leftmost / rightmost screen edge;
    //   y — sprite-based: the visible sprite must stay inside the work area
    //       of the display under the window centre, while the transparent
    //       bubble strip above it may hang off the screen top (otherwise the
    //       pet's feet could only ever reach the vertical middle).
    // The carrier's DIP size is fixed (collapsedWindowSize) on every monitor;
    // after the move, put the size back in case the crossing re-anchored it.
    const bounds = win.getBounds();
    const target = screen.getDisplayNearestPoint({
      x: bounds.x + Math.floor(bounds.width / 2) + dx,
      y: bounds.y + Math.floor(bounds.height / 2) + dy,
    });
    const area = target.workArea;
    const desktop = screen.getAllDisplays().reduce(
      (acc, display) => ({
        minX: Math.min(acc.minX, display.workArea.x),
        maxX: Math.max(acc.maxX, display.workArea.x + display.workArea.width),
      }),
      { minX: Infinity, maxX: -Infinity },
    );
    const x = Math.min(Math.max(bounds.x + dx, desktop.minX + 2), Math.max(desktop.minX + 2, desktop.maxX - collapsedWindowSize.width - 2));
    const y = clampCarrierY(bounds.y + dy, collapsedWindowSize.height, area);
    win.setPosition(x, y);
    restoreCarrierSize(pet);
    syncPetDisplay(pet, target);
  });
  ipcMain.on("openpets:pet-drag-end", (event) => {
    const pet = petForSender(event.sender);
    if (pet === undefined) return;
    pet.dragging = false;
    if (pet.window.isDestroyed()) return;
    // Return to idle after the drag unless an agent reaction took over while
    // the pointer was down (the reaction timer owns the state in that case).
    if (pet.lastSpriteState === "running-left" || pet.lastSpriteState === "running-right") {
      pet.lastSpriteState = "idle";
      pet.window.webContents.send("openpets:pet-state", { state: "idle" });
    }
    scheduleWalk(pet);
  });
  async function applyDefaultPet(petId: string): Promise<void> {
    const userData = app.getPath("userData");
    await writeManagedState(userData, { defaultPetId: petId });
    currentPetEntry = await resolveDefaultPet(userData);
    // Reload every live pet page with the new default sprite.
    for (const pet of pets.values()) {
      if (pet.window.isDestroyed()) continue;
      pet.petEntry = currentPetEntry;
      void renderPetPage(pet, currentPetEntry);
    }
  }
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
    if (result.ok && typeof result.id === "string") {
      await applyDefaultPet(result.id);
    }
    await refreshManagementWindow();
    return result;
  });
  ipcMain.handle("pets:select", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || petId.length === 0) return { ok: false, message: "非法的宠物 id" };
    if (petId !== builtInPetEntry.id) {
      const installed = await listInstalledPets(app.getPath("userData"));
      if (!installed.some((entry) => entry.id === petId)) return { ok: false, message: `未安装 ${petId}` };
    }
    await applyDefaultPet(petId);
    return { ok: true, message: "已设为默认" };
  });
  ipcMain.handle("pets:import-folder", async () => {
    const result = await dialog.showOpenDialog(managementWindow ?? new BrowserWindow(), {
      title: "选择宠物包文件夹",
      properties: ["openDirectory"],
      message: "文件夹应包含 pet.json 和精灵图",
    });
    if (result.canceled || result.filePaths.length !== 1) return { ok: false, message: "已取消" };
    const imported = await importPetFolder(app.getPath("userData"), result.filePaths[0]);
    if (imported.ok && typeof imported.id === "string") {
      await applyDefaultPet(imported.id);
    }
    await refreshManagementWindow();
    return imported;
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

// Log (instead of dialog-crash) anything escaping at shutdown or in stray
// callbacks, so a quit-time failure never blindsides the user and always
// leaves a trace we can diagnose.
const crashLogPath = join(app.getPath("userData"), "main-crash.log");
function appendCrashLog(kind: string, error: unknown): void {
  const when = new Date().toISOString();
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  try {
    appendFileSync(crashLogPath, `[${when}] ${kind}: ${detail}\n`, "utf8");
  } catch {
    // Logging must never be the thing that crashes the main process.
  }
  console.error(`[app-crash] ${kind}: ${detail}`);
}
process.on("uncaughtException", (error) => appendCrashLog("uncaughtException", error));
process.on("unhandledRejection", (reason) => appendCrashLog("unhandledRejection", reason ?? "no reason"));


void app.whenReady().then(async () => {
  installIpc();
  armWardrobeTimer();
  // Kick off OpenCode bring-up immediately (probe / install / service start);
  // attachSession awaits the same memoized promise while pets draw.
  void ensureOpenCodeReady();
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
  stopWardrobeTimer();
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
