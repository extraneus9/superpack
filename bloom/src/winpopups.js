// "Hide Windows' own popup" for every app except bloom (the author, 2026-10-17: "global, all apps except ours, in bulk").
//
// Windows keeps each app's "Show notification banners" checkbox (Settings › System › Notifications › <app>) as
// HandlerSettings.s:banner in its notification database (wpndatabase.db). Proven on his PC with screen captures:
// s:banner=0 → the notification still arrives (bloom shows it) but Windows draws no popup; 1 → the popup is back.
// (The registry ShowBanner value is NOT read — the first version of this switch wrote that and did nothing.)
//
// The database belongs to the per-user notification service, so a change is: stop the service (~2 s, allowed for
// the signed-in user) → back up the database files → write → integrity check (restore the backup if it fails) →
// start the service. Each app's previous value is kept so Undo puts back exactly what was there.
const { app } = require('electron');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DIR = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications');
const DB = path.join(DIR, 'wpndatabase.db');
const FILES = ['wpndatabase.db', 'wpndatabase.db-wal', 'wpndatabase.db-shm'];

const userDir = () => app.getPath('userData');
const prevFile = () => path.join(userDir(), 'windows-banners-backup.json');
function loadPrev() { try { return JSON.parse(fs.readFileSync(prevFile(), 'utf8')); } catch { return {}; } }
function savePrev(p) { fs.mkdirSync(userDir(), { recursive: true }); fs.writeFileSync(prevFile(), JSON.stringify(p, null, 1)); }

function ps(cmd) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 30000 },
    (e, so, se) => (e ? reject(new Error(String(se || e.message).trim())) : resolve(String(so).trim()))));
}
const SVC = "(Get-Service WpnUserService_* | Select-Object -First 1).Name";
const stopService = () => ps(`Stop-Service -Name ${SVC} -Force; (Get-Service -Name ${SVC}).Status`);
const startService = () => ps(`Start-Service -Name ${SVC}; Start-Sleep -Milliseconds 800; (Get-Service -Name ${SVC}).Status`);

function backupFiles() {
  const dir = path.join(userDir(), 'wpn-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) if (fs.existsSync(path.join(DIR, f))) fs.copyFileSync(path.join(DIR, f), path.join(dir, f));
  // keep the 5 newest backups
  const root = path.join(userDir(), 'wpn-backups');
  const all = fs.readdirSync(root).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 5))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  return dir;
}
function restoreFiles(dir) {
  for (const f of FILES) {
    const src = path.join(dir, f), dst = path.join(DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst); else fs.rmSync(dst, { force: true });
  }
}

// Runs fn(db) with the service stopped and a fresh backup; any failure puts the backup back.
async function withServiceStopped(fn) {
  await stopService();
  let backup = null, result;
  try {
    backup = backupFiles();
    const db = new DatabaseSync(DB);
    try {
      db.exec('BEGIN');
      result = fn(db);
      db.exec('COMMIT');
      const ok = db.prepare('PRAGMA quick_check').get();
      if (!ok || Object.values(ok)[0] !== 'ok') throw new Error('database check failed');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { db.close(); }
  } catch (e) {
    if (backup) restoreFiles(backup);
    await startService().catch(() => {});
    throw e;
  }
  await startService();
  return result;
}

// Read-only: apps whose Windows popup is currently on — i.e. what "hide" would change.
function pending() {
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare(`select h.PrimaryId id, s.Value v from NotificationHandler h
      left join HandlerSettings s on s.HandlerId = h.RecordId and s.SettingKey = 's:banner'
      where coalesce(s.Value, 1) <> 0`).all();
    db.close();
    return rows.map((r) => r.id);
  } catch { return []; }
}

// Turn the Windows popup off for `ids` (default: every app). bloom's own pill is not a Windows popup, so it is unaffected;
// bloom's Windows entry is included so its test notification also shows only as a bloom pill.
async function hide(ids) {
  const prev = loadPrev();
  const count = await withServiceStopped((db) => {
    const handlers = db.prepare('select RecordId id, PrimaryId aumid from NotificationHandler').all();
    const want = ids ? new Set(ids) : null;
    const get = db.prepare("select Value v from HandlerSettings where HandlerId = ? and SettingKey = 's:banner'");
    const put = db.prepare("insert or replace into HandlerSettings(HandlerId, SettingKey, Value) values (?, 's:banner', 0)");
    let n = 0;
    for (const h of handlers) {
      if (want && !want.has(h.aumid)) continue;
      const cur = get.get(h.id);
      if (!(h.aumid in prev)) prev[h.aumid] = cur ? Number(cur.v) : null; // remember only the ORIGINAL value
      if (!cur || Number(cur.v) !== 0) { put.run(h.id); n++; }
    }
    return n;
  });
  savePrev(prev);
  return { count, total: Object.keys(prev).length };
}

// Put every app back exactly as it was before bloom changed it.
async function restore() {
  const prev = loadPrev();
  const ids = Object.keys(prev);
  if (!ids.length) return { count: 0 };
  const count = await withServiceStopped((db) => {
    const find = db.prepare('select RecordId id from NotificationHandler where PrimaryId = ?');
    const put = db.prepare("insert or replace into HandlerSettings(HandlerId, SettingKey, Value) values (?, 's:banner', ?)");
    const del = db.prepare("delete from HandlerSettings where HandlerId = ? and SettingKey = 's:banner'");
    let n = 0;
    for (const id of ids) {
      const h = find.get(id); if (!h) continue;
      if (prev[id] === null) del.run(h.id); else put.run(h.id, prev[id]);
      n++;
    }
    return n;
  });
  savePrev({});
  return { count };
}

module.exports = { hide, restore, pending };
