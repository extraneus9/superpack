const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (ch) => (fn) => ipcRenderer.on(ch, (_e, d) => fn(d));

contextBridge.exposeInMainWorld('bloomSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.send('settings:set', key, value),
  onState: listen('settings:state'),
  test: () => ipcRenderer.send('settings:test'),
  openWindowsSettings: () => ipcRenderer.send('settings:windows'),
  quit: () => ipcRenderer.send('settings:quit'),
  // history ("see all")
  history: () => ipcRenderer.invoke('history:get'),
  onHistory: listen('history:new'),
  clearHistory: () => ipcRenderer.send('history:clear'),
  // sound
  soundBytes: (file) => ipcRenderer.invoke('sound:bytes', file),
  playSound: (file) => ipcRenderer.send('sound:play', file),
  onPlayed: listen('sound:played'),
  addSounds: (files) => ipcRenderer.invoke('sound:add', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  removeSound: (file) => ipcRenderer.send('sound:remove', file),
  // Windows' own popup: one-click off / undo, and a real Windows test notification
  hideWindows: (on) => ipcRenderer.invoke('popups:set', on),
  windowsTest: () => ipcRenderer.invoke('popups:test'),
  // window buttons
  min: () => ipcRenderer.send('win:min'),
  max: () => ipcRenderer.send('win:max'),
  close: () => ipcRenderer.send('win:close'),
  onMax: listen('win:max'),
});
