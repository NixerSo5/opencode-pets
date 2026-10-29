// pet-preload.cjs — CJS preload for the standalone desktop pet window.
// The pet page only renders the sprite and its speech bubble; the chat panel
// lives in its own window with panel-preload.cjs.
const { contextBridge, ipcRenderer } = require("electron");

let petStateHandler = null;
ipcRenderer.on("openpets:pet-state", (_event, payload) => {
  petStateHandler?.(payload);
});

contextBridge.exposeInMainWorld("openpetsDemo", {
  onPetState: (callback) => {
    if (typeof callback === "function") petStateHandler = callback;
  },
  say: (message) => {
    if (typeof message === "string" && message.length > 0) {
      ipcRenderer.send("openpets:pet-message", message);
    }
  },
  chatToggle: () => {
    ipcRenderer.send("openpets:pet-chat-toggle");
  },
  dragMove: (dx, dy) => {
    ipcRenderer.send("openpets:pet-drag-move", { dx, dy });
  },
  dragEnd: () => {
    ipcRenderer.send("openpets:pet-drag-end");
  },
});