// pet-preload.cjs — CJS preload for the standalone desktop pet window.
const { contextBridge, ipcRenderer } = require("electron");

let petStateHandler = null;
let panelStateHandler = null;
let askHandler = null;
ipcRenderer.on("openpets:pet-state", (_event, payload) => {
  petStateHandler?.(payload);
});
ipcRenderer.on("openpets:pet-panel-state", (_event, payload) => {
  panelStateHandler?.(payload);
});
ipcRenderer.on("openpets:pet-ask", (_event, payload) => {
  askHandler?.(payload);
});

contextBridge.exposeInMainWorld("openpetsDemo", {
  onPetState: (callback) => {
    if (typeof callback === "function") petStateHandler = callback;
  },
  onPanelState: (callback) => {
    if (typeof callback === "function") panelStateHandler = callback;
  },
  onAsk: (callback) => {
    if (typeof callback === "function") askHandler = callback;
  },
  say: (message) => {
    if (typeof message === "string" && message.length > 0) {
      ipcRenderer.send("openpets:pet-message", message);
    }
  },
  chatToggle: () => {
    ipcRenderer.send("openpets:pet-chat-toggle");
  },
  chatSend: (text) => {
    return ipcRenderer.invoke("openpets:pet-chat-send", text);
  },
  // Answer a question form the agent is parked on (plan A / SSE route).
  // One call covers the whole form, exactly like the OpenCode web dock.
  askReply: (payload) => {
    const formID = typeof payload?.formID === "string" ? payload.formID : "";
    const answers = Array.isArray(payload?.answers) ? payload.answers : [];
    if (formID.length === 0) return Promise.resolve({ ok: false, error: "缺少 formID" });
    return ipcRenderer.invoke("openpets:pet-ask-reply", { formID, answers });
  },
  chatHistory: () => {
    return ipcRenderer.invoke("openpets:pet-chat-history");
  },
  chatStop: () => {
    return ipcRenderer.invoke("openpets:pet-chat-stop");
  },
  chatModel: () => {
    return ipcRenderer.invoke("openpets:pet-chat-model");
  },
  dragMove: (dx, dy) => {
    ipcRenderer.send("openpets:pet-drag-move", { dx, dy });
  },
});
