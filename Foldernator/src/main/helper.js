// Client for bin/ShellHelper.exe — one persistent process, JSON lines, auto-restart.
const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

class Helper extends EventEmitter {
  constructor(exePath) {
    super();
    this.exePath = exePath;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.stopping = false;
    this.start();
  }

  start() {
    this.proc = spawn(this.exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // a helper that can't start must not crash the app: retry a few times, then carry on without it
    this.proc.on('error', (e) => { console.error('[helper] cannot start', this.exePath, e.message); });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => console.error('[helper]', String(d)));
    this.proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error('helper exited ' + code));
      this.pending.clear();
      this.proc = null;
      this.restarts = (this.restarts || 0) + 1;
      if (!this.stopping && this.restarts <= 20) setTimeout(() => this.start(), 500);
    });
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event) { this.emit(msg.event, msg); continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'helper error'));
    }
  }

  call(cmd, args = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('helper not running'));
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ id: 0, cmd: 'exit' }) + '\n'); } catch {}
      setTimeout(() => { try { this.proc && this.proc.kill(); } catch {} }, 300);
    }
  }
}

// A running Foldernator locks bin/ShellHelper.exe, so rebuilds may land as ShellHelper-<time>.exe.
// Always start the newest build, and remove older ones that aren't in use any more.
function newestExe() {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', '..', 'bin');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^ShellHelper(-\d+)?\.exe$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })); } catch {}
  files.sort((a, b) => b.t - a.t);
  for (const old of files.slice(1)) { try { fs.unlinkSync(path.join(dir, old.f)); } catch {} }
  return path.join(dir, files.length ? files[0].f : 'ShellHelper.exe');
}

// installed app: ShellHelper.exe ships as an extra resource (a process can't be started from inside app.asar)
const packagedExe = () => path.join(process.resourcesPath, 'ShellHelper.exe');
const isPackaged = (() => { try { return require('electron').app.isPackaged; } catch { return false; } })();
module.exports = { Helper, defaultExe: isPackaged ? packagedExe() : newestExe() };
