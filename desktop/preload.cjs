const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("collector", {
  getSnapshot: () => ipcRenderer.invoke("collector:get-snapshot"),
  selectPort: (portPath) => ipcRenderer.invoke("collector:select-port", portPath),
  connectPort: () => ipcRenderer.invoke("collector:connect-port"),
  disconnectPort: () => ipcRenderer.invoke("collector:disconnect-port"),
  bind: (receiverId) => ipcRenderer.invoke("collector:bind", receiverId),
  openCoach: () => ipcRenderer.invoke("collector:open-coach"),
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("collector:snapshot", listener);
    return () => ipcRenderer.removeListener("collector:snapshot", listener);
  },
});
