// panel-preload.cjs — CJS preload for the standalone chat panel window.
// The panel is its own BrowserWindow anchored next to the pet, so it needs its
// own bridge; the pet window keeps pet-preload.cjs and never hosts chat UI.
const { contextBridge, ipcRenderer } = require("electron");

let panelStateHandler = null;
let askHandler = null;
ipcRenderer.on("openpets:pet-panel-state", (_event, payload) => {
  panelStateHandler?.(payload);
});
ipcRenderer.on("openpets:pet-ask", (_event, payload) => {
  askHandler?.(payload);
});

contextBridge.exposeInMainWorld("openpetsPanel", {
  onPanelState: (callback) => {
    if (typeof callback === "function") panelStateHandler = callback;
  },
  onAsk: (callback) => {
    if (typeof callback === "function") askHandler = callback;
  },
  chatHistory: () => {
    return ipcRenderer.invoke("openpets:pet-chat-history");
  },
  chatModel: () => {
    return ipcRenderer.invoke("openpets:pet-chat-model");
  },
  chatSend: (text) => {
    return ipcRenderer.invoke("openpets:pet-chat-send", text);
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
});
