// panel-preload.cjs — CJS preload for the standalone chat panel window.
// The panel is its own BrowserWindow anchored next to the pet, so it needs its
// own bridge; the pet window keeps pet-preload.cjs and never hosts chat UI.
const { contextBridge, ipcRenderer } = require("electron");

let panelStateHandler = null;
let askHandler = null;
let processHandler = null;
ipcRenderer.on("openpets:pet-panel-state", (_event, payload) => {
  panelStateHandler?.(payload);
});
ipcRenderer.on("openpets:pet-ask", (_event, payload) => {
  askHandler?.(payload);
});
ipcRenderer.on("openpets:pet-process", (_event, payload) => {
  processHandler?.(payload);
});

contextBridge.exposeInMainWorld("openpetsPanel", {
  onPanelState: (callback) => {
    if (typeof callback === "function") panelStateHandler = callback;
  },
  onAsk: (callback) => {
    if (typeof callback === "function") askHandler = callback;
  },
  onProcess: (callback) => {
    if (typeof callback === "function") processHandler = callback;
  },
  chatHistory: () => {
    return ipcRenderer.invoke("openpets:pet-chat-history");
  },
  chatModel: () => {
    return ipcRenderer.invoke("openpets:pet-chat-model");
  },
  chatSend: (text, images) => {
    // `images` are `{ uri, name }` data URLs; the main process re-validates
    // every one of them before admitting the prompt.
    const payload = { text: typeof text === "string" ? text : "", images: Array.isArray(images) ? images : [] };
    return ipcRenderer.invoke("openpets:pet-chat-send", payload);
  },
  // Native image picker. Doing this in the main process keeps the panel open:
  // the dialog steals focus, and a renderer-side <input type=file> cannot tell
  // the panel's blur handler to stand down.
  pickImages: () => {
    return ipcRenderer.invoke("openpets:panel-pick-images");
  },
  chatStop: () => {
    return ipcRenderer.invoke("openpets:pet-chat-stop");
  },
  askReply: (payload) => {
    const formID = typeof payload?.formID === "string" ? payload.formID : "";
    const answers = Array.isArray(payload?.answers) ? payload.answers : [];
    if (formID.length === 0) return Promise.resolve({ ok: false, error: "缺少 formID" });
    return ipcRenderer.invoke("openpets:pet-ask-reply", { formID, answers });
  },
  copyText: (text) => {
    if (typeof text !== "string" || text.length === 0) return Promise.resolve({ ok: false, error: "没有可复制的内容" });
    return ipcRenderer.invoke("openpets:pet-copy-text", text);
  },
  closePanel: () => {
    ipcRenderer.send("openpets:panel-close");
  },
  // Update bar: downloads the newer GitHub release and hands over to its
  // installer; the main process then quits and relaunches.
  requestUpdate: () => {
    return ipcRenderer.invoke("openpets:panel-request-update");
  },
  // Temporary diagnostics: the panel has no console the user can open, so log
  // lines are forwarded to the main process, which appends them to a file.
  debugLog: (message) => {
    try {
      ipcRenderer.send("openpets:panel-debug-log", String(message ?? ""));
    } catch { /* diagnostics must never break the UI */ }
  },
});
