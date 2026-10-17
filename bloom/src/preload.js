const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bloom', {
  on: (ch, fn) => { if (['notify', 'settings', 'sound', 'sound:play'].includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
  played: (info) => ipcRenderer.send('sound:played', info),
  loaded: (info) => ipcRenderer.send('sound:loaded', info),
  edge: (color) => ipcRenderer.send('edge', color),
  mouse: (ignore) => ipcRenderer.send('mouse', ignore),
  idle: () => ipcRenderer.send('idle'),
  open: (id) => ipcRenderer.send('open', id),
  dismissed: (id) => ipcRenderer.send('dismissed', id),
});
