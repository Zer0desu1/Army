const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  platform: process.platform,
  scanNetwork: () => ipcRenderer.invoke('scan-network'),
});
