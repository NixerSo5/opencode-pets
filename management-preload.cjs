// management-preload.cjs — CJS preload for the Pets management window.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petsManager", {
  select: (petId) => ipcRenderer.invoke("pets:select", petId),
  importFolder: () => ipcRenderer.invoke("pets:import-folder"),
  catalogPage: (page) => ipcRenderer.invoke("pets:catalog-page", page),
  catalogSearch: () => ipcRenderer.invoke("pets:catalog-search"),
  catalogInstall: (petId) => ipcRenderer.invoke("pets:catalog-install", petId),
});
