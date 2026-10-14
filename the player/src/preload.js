// Bridge between the page and the main process. Everything the renderer can ask for is listed here.
const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

// in test runs, copies go to a private test clipboard (his real clipboard is never touched)
const QA = process.env.ALVA_QA === '1';
let qaClip = '';

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  probe: (file) => ipcRenderer.invoke('probe', file),
  siblings: (file) => ipcRenderer.invoke('siblings', file),
  library: () => ipcRenderer.invoke('library'),
  details: (file) => ipcRenderer.invoke('details', file),
  copy: (text) => { if (QA) qaClip = String(text); else clipboard.writeText(String(text)); },
  qaClipboard: () => (QA ? qaClip : ''),
  b64: (file) => ipcRenderer.invoke('b64', file),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  exists: (file) => ipcRenderer.invoke('exists', file),
  snapshot: (file, frame, fps, name) => ipcRenderer.invoke('snapshot', { file, frame, fps, name }),
  reveal: (file) => ipcRenderer.invoke('reveal-file', file),
  registerDefault: () => ipcRenderer.invoke('register-default'),
  makeShortcuts: () => ipcRenderer.invoke('make-shortcuts'),
  win: (cmd, arg) => ipcRenderer.send('win', cmd, arg),
  view: (v) => ipcRenderer.send('view', v),
  showWindow: () => ipcRenderer.send('reveal'),
  wrap: (opts) => ipcRenderer.invoke('win:wrap', opts),
  homeSize: (opts) => ipcRenderer.invoke('win:home', opts),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, f) => cb(f)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),
  onBackground: (cb) => ipcRenderer.on('win:background', () => cb()),
  onMotion: (cb) => ipcRenderer.on('win:motion', (_e, m) => cb(m)),
  onWake: (cb) => ipcRenderer.on('win:wake', (_e, f) => cb(f)),
});
