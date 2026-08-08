const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deskApp", {
  isApp: true,
  restart: () => ipcRenderer.invoke("desk:restart"),
  getInfo: () => ipcRenderer.invoke("desk:get-info"),
  pickFolder: () => ipcRenderer.invoke("desk:pick-folder"),
  onDaemonDied: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("daemon-died", handler);
    return () => ipcRenderer.removeListener("daemon-died", handler);
  },
});

// Mark the document as the desktop shell ASAP so traffic-light CSS applies
// before React paints (sidebar "PROJECTS" was under the macOS buttons).
function markDeskApp() {
  try {
    document.documentElement.classList.add("desk-app");
    document.body?.classList.add("desk-app");
  } catch {
    /* */
  }
}
markDeskApp();
window.addEventListener("DOMContentLoaded", markDeskApp);
