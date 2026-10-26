/**
 * electron-main.ts
 *
 * Standalone desktop pet app: an original-style transparent, frameless,
 * always-on-top pet window plus the Pets management tab (管理端 → 宠物,
 * only that tab) in a normal management window.
 */
import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createPetPageHtml } from "./desktop-render.js";
import { getConfiguredSpriteStates, isLoopingSpriteState, resolveReactionSpriteState } from "./reaction-animation-mapping.js";
import { createManagementHtml } from "./management-render.js";
import { getCatalogPage, getCatalogAllPets } from "./catalog-client.js";
import { installCatalogPet } from "./catalog-install.js";
import { builtInPetEntry, resolveDefaultPet, importPetFolder, listInstalledPets, readManagedState, writeManagedState, } from "./pet-store.js";
import { pickReactionMessage } from "./reaction-messages.js";
const scale = 0.75;
// Reaction schedule mirroring the original `reactionAnimationMetadata` order
// (advanced manually via the tray "切换下一个表情"; no automatic polling).
const reactionSchedule = [
    "idle", "thinking", "working", "testing", "waiting", "success", "error", "celebrating", "waving", "idle",
];
const stateRows = getConfiguredSpriteStates(1010);
let mainWindow = null;
let managementWindow = null;
let tray = null;
let revertTimer = null;
let scheduleIndex = 0;
let lastSpriteState = "idle";
let currentPetEntry = { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
/** Chat carrier state (original expandedPetWindowSize behavior). */
let chatExpanded = false;
let collapsedAnchor = null;
const collapsedWindowSize = { width: 320, height: 300 };
const expandedWindowSize = { width: 420, height: 640 };
const distDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(distDir, "..");
const spritesheetPath = join(projectRoot, "assets", "assets", "default-pet-spritesheet.webp");
const trayIconPath = join(projectRoot, "assets", "assets", "tray-icon.png");
function oneShotRevertMs(spriteState) {
    if (isLoopingSpriteState(spriteState, stateRows))
        return null;
    const row = stateRows[spriteState];
    return row.durationMs * (("iterations" in row && typeof row.iterations === "number") ? row.iterations : 1);
}
function applyReaction(reaction, message) {
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
function advanceSchedule() {
    const reaction = reactionSchedule[scheduleIndex % reactionSchedule.length];
    scheduleIndex += 1;
    applyReaction(reaction);
}
/** Welcome message: pet waves, says hello, and shows the "Hi" badge (original startup greeting). */
function sayWelcome() {
    applyReaction("waving", pickReactionMessage("waving"));
    // Welcome waving is a looping pose; without the poll loop we must revert to idle ourselves.
    if (idleRevertTimer)
        clearTimeout(idleRevertTimer);
    idleRevertTimer = setTimeout(() => {
        if (lastSpriteState === resolveReactionSpriteState("waving")) {
            lastSpriteState = "idle";
            mainWindow?.webContents.send("openpets:pet-state", { state: "idle" });
        }
    }, 4200);
    idleRevertTimer.unref?.();
}
function clampPointToWorkArea(point, size) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        x: Math.min(Math.max(point.x, area.x + 2), area.x + area.width - size.width - 2),
        y: Math.min(Math.max(point.y, area.y + 2), area.y + area.height - size.height - 2),
    };
}
/** Anchor-preserving bounds: the pet stays at its spot while the window grows upward/sideways. */
function expandedBoundsFor(collapsed) {
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
function publishPanelState() {
    mainWindow?.webContents.send("openpets:pet-panel-state", { chatExpanded });
}
/** Expand/collapse the pet window carrier for the chat panel (anchors the pet in place). */
function setChatExpanded(next) {
    if (chatExpanded === next)
        return;
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return;
    chatExpanded = next;
    const wasResizable = win.isResizable();
    win.setResizable(true);
    try {
        if (next) {
            const collapsed = win.getBounds();
            collapsedAnchor = { x: collapsed.x, y: collapsed.y };
            win.setBounds(expandedBoundsFor({ x: collapsed.x, y: collapsed.y }), false);
        }
        else {
            const anchor = collapsedAnchor ?? (() => {
                const bounds = win.getBounds();
                return clampPointToWorkArea({ x: bounds.x, y: bounds.y + (collapsedWindowSize.height - bounds.height) }, collapsedWindowSize);
            })();
            win.setBounds({ ...anchor, width: collapsedWindowSize.width, height: collapsedWindowSize.height }, false);
        }
    }
    finally {
        win.setResizable(wasResizable);
    }
    publishPanelState();
}
// The 5s reaction polling loop (表情轮询) was removed per product request:
// the pet only plays reactions on explicit events (welcome on load, tray
// 「切换下一个表情」, future OpenCode session events).
let idleRevertTimer = null;
async function writePetPage() {
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
function bottomRightPosition(width, height) {
    const display = screen.getPrimaryDisplay().workArea;
    return {
        x: display.x + display.width - width - 24,
        y: display.y + display.height - height - 8,
    };
}
function createPetWindow() {
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
}
function createTray() {
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
async function petListItems() {
    const userData = app.getPath("userData");
    const [installed, state] = [await listInstalledPets(userData), readManagedState(userData)];
    const items = [
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
function openManagementWindow() {
    if (managementWindow && !managementWindow.isDestroyed()) {
        void refreshManagementWindow();
        if (managementWindow.isMinimized())
            managementWindow.restore();
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
async function refreshManagementWindow() {
    if (!managementWindow || managementWindow.isDestroyed())
        return;
    const dir = join(app.getPath("userData"), "rendered-pets");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "management-pets.html");
    await writeFile(filePath, createManagementHtml({ items: await petListItems() }), "utf8");
    await managementWindow.loadFile(filePath);
}
async function decorateCatalogPets(pets) {
    const [installed, state] = [await listInstalledPets(app.getPath("userData")), readManagedState(app.getPath("userData"))];
    const installedIds = new Set(installed.map((entry) => entry.id));
    return pets.map((entry) => ({ ...entry, installed: installedIds.has(entry.id), isDefault: entry.id === state.defaultPetId }));
}
function installIpc() {
    ipcMain.on("openpets:pet-message", (event, message) => {
        if (typeof message !== "string" || message.length === 0)
            return;
        event.sender.send("openpets:pet-state", { state: lastSpriteState, message });
    });
    ipcMain.on("openpets:pet-chat-toggle", () => {
        setChatExpanded(!chatExpanded);
    });
    ipcMain.handle("openpets:pet-chat-send", async (_event, raw) => {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (!text)
            return { ok: false, error: "消息为空" };
        if (text.length > 4000)
            return { ok: false, error: "消息太长（上限 4000 字）" };
        // Stub assistant reply until the OpenCode session backend is wired in.
        await new Promise((resolve) => setTimeout(resolve, 450));
        return { ok: true, reply: `收到：「${text}」。现在还是演示回复——接入 OpenCode 会话后，这里就是真实回答。` };
    });
    ipcMain.on("openpets:pet-drag-move", (_event, payload) => {
        const win = mainWindow;
        if (!win || win.isDestroyed())
            return;
        const dx = typeof payload?.dx === "number" ? Math.round(payload.dx) : 0;
        const dy = typeof payload?.dy === "number" ? Math.round(payload.dy) : 0;
        if (dx === 0 && dy === 0)
            return;
        win.setPosition(win.getBounds().x + dx, win.getBounds().y + dy);
    });
    ipcMain.handle("pets:catalog-page", async (_event, page) => {
        try {
            const result = await getCatalogPage(typeof page === "number" ? page : 0);
            const pets = (await decorateCatalogPets(result.pets));
            return { ok: true, page: result.page, pageCount: result.pageCount, total: result.total, pets, filters: result.filters };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    ipcMain.handle("pets:catalog-search", async () => {
        try {
            const pets = (await decorateCatalogPets(await getCatalogAllPets()));
            return { ok: true, pets };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error), pets: [] };
        }
    });
    ipcMain.handle("pets:catalog-install", async (_event, petId) => {
        if (typeof petId !== "string" || petId.length === 0 || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(petId))
            return { ok: false, message: "非法的宠物 id" };
        const result = await installCatalogPet(app.getPath("userData"), petId);
        await refreshManagementWindow();
        return result;
    });
    ipcMain.handle("pets:select", async (_event, petId) => {
        if (typeof petId !== "string" || petId.length === 0)
            return { ok: false, message: "非法的宠物 id" };
        const userData = app.getPath("userData");
        if (petId !== builtInPetEntry.id) {
            const installed = await listInstalledPets(userData);
            if (!installed.some((entry) => entry.id === petId))
                return { ok: false, message: `未安装 ${petId}` };
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
        if (result.canceled || result.filePaths.length !== 1)
            return { ok: false, message: "已取消" };
        return importPetFolder(app.getPath("userData"), result.filePaths[0]);
    });
}
void app.whenReady().then(async () => {
    installIpc();
    currentPetEntry = await resolveDefaultPet(app.getPath("userData"));
    createTray();
    createPetWindow();
});
app.on("window-all-closed", () => {
    // The pet window is the app; closing it exits like quitting the pet.
    app.quit();
});
app.on("quit", () => {
    if (revertTimer)
        clearTimeout(revertTimer);
});
