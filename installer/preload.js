const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  manifest: () => ipcRenderer.invoke('manifest'),
  install: (apps, tasks) => ipcRenderer.invoke('install', { apps, tasks }),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, msg) => fn(msg)),
  open: (exe) => ipcRenderer.send('open', exe),
  minimize: () => ipcRenderer.send('minimize'),
  repo: () => ipcRenderer.send('repo'),
  close: () => ipcRenderer.send('close'),
  classic: () => ipcRenderer.send('classic'),
  quit: () => ipcRenderer.send('quit'),
  shot: (name) => ipcRenderer.invoke('shot', name),
});
