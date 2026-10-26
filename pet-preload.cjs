// pet-preload.cjs — CJS preload for the standalone desktop pet window.
const { contextBridge, ipcRenderer } = require("electron");

let petStateHandler = null;
let panelStateHandler = null;
ipcRenderer.on("openpets:pet-state", (_event, payload) => {
  petStateHandler?.(payload);
});
ipcRenderer.on("openpets:pet-panel-state", (_event, payload) => {
  panelStateHandler?.(payload);
});

contextBridge.exposeInMainWorld("openpetsDemo", {
  onPetState: (callback) => {
    if (typeof callback === "function") petStateHandler = callback;
  },
  onPanelState: (callback) => {
    if (typeof callback === "function") panelStateHandler = callback;
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
  chatHistory: () => {
    return ipcRenderer.invoke("openpets:pet-chat-history");
  },
  dragMove: (dx, dy) => {
    ipcRenderer.send("openpets:pet-drag-move", { dx, dy });
  },
});
