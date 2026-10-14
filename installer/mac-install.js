// macOS half of the setup window. The Mac download is one .dmg holding "Install superpack.app" (this window) with the
// apps inside its Resources (apps/<name>.app, source/). Installing = copying the picked apps into /Applications (or
// ~/Applications when /Applications isn't writable), then No More Writing's downloads. It reports progress with the
// same messages the Windows engine writes, so the window doesn't know the difference.
// Unsigned on purpose (open source): the person approves "Install superpack" once; the apps it copies are theirs, so
// the download quarantine flag is cleared on them and they open without a second warning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RES = process.resourcesPath;
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  p.stdout.on('data', (d) => { out += d; opts.onData && opts.onData(String(d)); });
  p.stderr.on('data', (d) => { out += d; opts.onData && opts.onData(String(d)); });
  p.on('error', () => resolve({ code: -1, out }));
  p.on('exit', (code) => resolve({ code, out }));
});
function bytesIn(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += bytesIn(p);
      else if (e.isFile()) n += fs.lstatSync(p).size;
    }
  } catch { /* still being copied */ }
  return n;
}
function target(qaDir) {
  if (qaDir) { fs.mkdirSync(qaDir, { recursive: true }); return qaDir; }
  try { fs.accessSync('/Applications', fs.constants.W_OK); return '/Applications'; } catch { /* not an admin */ }
  const mine = path.join(os.homedir(), 'Applications');
  fs.mkdirSync(mine, { recursive: true });
  return mine;
}

// download with progress (follows redirects); → file path
async function download(url, to, onPct) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(to);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total) onPct(Math.round((got / total) * 1000));
  }
  await new Promise((r) => out.end(r));
  return to;
}
async function ollamaUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:11434/api/version'); if (r.ok) return true; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function macInstall(manifest, apps, tasks, send, { qaDir } = {}) {
  const dest = target(qaDir);
  const order = manifest.apps.filter((a) => apps.includes(a.key));
  const total = order.reduce((n, a) => n + a.bytes, 0) || 1;
  let before = 0;
  for (const a of order) {
    const src = path.join(RES, 'apps', a.bundle);
    const to = path.join(dest, a.bundle);
    fs.rmSync(to, { recursive: true, force: true });
    const tick = setInterval(() => send({ step: 'files', app: a.key, p: Math.min(999, Math.round(((before + bytesIn(to)) / total) * 1000)) }), 300);
    const r = await run('/usr/bin/ditto', [src, to]);
    clearInterval(tick);
    if (r.code !== 0) return { ok: false, why: `copying ${a.name} failed` };
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', to]);
    before += a.bytes;
    send({ step: 'files', app: a.key, p: Math.round((before / total) * 1000) });
  }
  if (tasks.includes('sourcecode')) {
    const docs = qaDir ? path.join(qaDir, 'source code') : path.join(os.homedir(), 'Documents', 'superpack source code');
    fs.mkdirSync(docs, { recursive: true });
    for (const f of ['README.md', 'LICENSE']) if (fs.existsSync(path.join(RES, 'source', f))) fs.copyFileSync(path.join(RES, 'source', f), path.join(docs, f));
    for (const a of order) if (fs.existsSync(path.join(RES, 'source', a.name))) await run('/usr/bin/ditto', [path.join(RES, 'source', a.name), path.join(docs, a.name)]);
  }
  if (apps.includes('nomorewriting') && !qaDir) await noMoreWritingDownloads(dest, send);
  send({ step: 'done', app: '', p: 1000, note: dest });
  return { ok: true, dir: dest };
}

// No More Writing needs Ollama (tidies the text) + its writing model + the speech model. Never fatal: the app works
// without Ollama and fetches the speech model on first use.
async function noMoreWritingDownloads(dest, send) {
  const appCli = (base) => path.join(base, 'Ollama.app', 'Contents', 'Resources', 'ollama');
  let cli = ['/Applications', path.join(os.homedir(), 'Applications'), dest].map(appCli).find((p) => fs.existsSync(p));
  try {
    if (!cli) {
      send({ step: 'ollama-download', app: 'nomorewriting', p: 0 });
      const zip = path.join(os.tmpdir(), 'Ollama-darwin.zip');
      await download('https://ollama.com/download/Ollama-darwin.zip', zip, (p) => send({ step: 'ollama-download', app: 'nomorewriting', p }));
      send({ step: 'ollama-install', app: 'nomorewriting', p: 0 });
      await run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', path.join(dest, 'Ollama.app')]);
      cli = appCli(dest);
    }
    if (cli && fs.existsSync(cli)) {
      await run('/usr/bin/open', ['-g', '-a', path.resolve(cli, '..', '..', '..')]); // starts the Ollama server in the background
      if (await ollamaUp()) {
        send({ step: 'model', app: 'nomorewriting', p: 0 });
        await run(cli, ['pull', 'gemma3:4b'], {
          onData: (t) => { const m = t.match(/(\d{1,3})%/g); if (m) send({ step: 'model', app: 'nomorewriting', p: Number(m[m.length - 1].slice(0, -1)) * 10 }); },
        });
      }
    }
  } catch { /* Ollama is optional */ }
  send({ step: 'speech', app: 'nomorewriting', p: 0 });
  const nmw = path.join(dest, 'No More Writing.app', 'Contents', 'MacOS', 'NoMoreWriting');
  if (fs.existsSync(nmw)) await run(nmw, ['--prefetch']);
}

module.exports = { macInstall };
