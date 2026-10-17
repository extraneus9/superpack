const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('edgeLight', { onFlash: (fn) => ipcRenderer.on('flash', (_e, c) => fn(c)) });
