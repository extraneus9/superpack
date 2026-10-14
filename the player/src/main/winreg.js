// Windows integration: everything Windows needs to list "the player" in Default apps, Open with and
// Installed apps — written per-user (HKCU, no admin) as ONE .reg import, and removed the same way.
// options()/buildRegister()/buildUnregister()/deleterScript() are pure (QA checks their text); the rest touch Windows.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// system tools by full path: a bare "reg" would first be looked up in the current folder (the opened video's)
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const REG = path.join(SYS32, 'reg.exe');
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// two file types so Explorer can tell them apart: video = black tile (the original ProgID), audio = white tile
const PROG = 'AlvaPlayer.Media';
const PROG_AUDIO = 'AlvaPlayer.Audio';
const PROGS = [PROG, PROG_AUDIO];
// which of our file types an extension belongs to
const progFor = (o, ext) => ((o.audioExts || []).includes(ext) ? PROG_AUDIO : PROG);
const CAP = 'Software\\AlvaPlayer\\Capabilities';
const HK = 'HKEY_CURRENT_USER\\';
const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\the player';
const APP_PATHS = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\';
// .ts / .mts are also TypeScript sources: claiming them would open code files in the player
const SKIP = new Set(['ts', 'mts']);

const q = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const dword = (n) => 'dword:' + (Math.max(0, Math.min(0xffffffff, Math.round(n))) >>> 0).toString(16).padStart(8, '0');
const HKLM = 'HKEY_LOCAL_MACHINE\\';
const key = (k, values, hive = HK) => [`[${hive}${k}]`, ...Object.entries(values).map(([n, v]) => `${n === '@' ? '@' : q(n)}=${v}`), ''];

// the two file types the media extensions point at — same command, own name and icon
// (FriendlyTypeName must be an indirect @dll,-id string per the docs: the default value names the type instead)
function progIdKeys(o, hive) {
  return [[PROG, 'Video file', o.iconVideo || o.icon], [PROG_AUDIO, 'Audio file', o.iconAudio || o.icon]].flatMap(([id, label, icon]) => [
    ...key(`Software\\Classes\\${id}`, { '@': q(label), FriendlyTypeName: '-' }, hive),
    ...key(`Software\\Classes\\${id}\\DefaultIcon`, { '@': q(icon) }, hive),
    ...key(`Software\\Classes\\${id}\\shell`, { '@': q('open') }, hive),
    ...key(`Software\\Classes\\${id}\\shell\\open`, { FriendlyAppName: q(o.appName) }, hive),
    ...key(`Software\\Classes\\${id}\\shell\\open\\command`, { '@': q(o.command) }, hive),
    ...key(`Software\\Classes\\${id}\\Application`, { ApplicationName: q(o.appName), ApplicationIcon: q(o.icon), ApplicationCompany: q('alva'), AppUserModelId: q('alva.player') }, hive),
  ]);
}
// the app itself, as Default apps sees it
function capabilityKeys(o, hive) {
  const exts = o.exts.filter((e) => !SKIP.has(e));
  return [
    ...key(CAP, { ApplicationName: q(o.appName), ApplicationDescription: q('Plays every video and audio format.'), ApplicationIcon: q(o.icon) }, hive),
    ...key(`${CAP}\\FileAssociations`, Object.fromEntries(exts.map((e) => ['.' + e, q(progFor(o, e))])), hive),
    ...key('Software\\RegisteredApplications', { [o.appName]: q(CAP) }, hive),
  ];
}

// Windows 11 25H2 (his build 26200) lists only MACHINE-wide apps in Settings › Default apps — a per-user (HKCU)
// RegisteredApplications entry is ignored there (tested 2026-10-13 with throwaway apps: never listed, deep link
// lands on the generic page; HKLM VLC opens its own page). So the Default-apps half lives in HKLM, written once with
// one UAC prompt. The ProgID is copied there too, like VLC's, so the machine entry never depends on a user hive.
// RegSig fingerprints everything written there (command, icon, name, every type), so a later version with a changed
// type list is seen as outdated and rewritten; the old keys are cleared first so removed types really go.
const machineSig = (o) => crypto.createHash('sha1').update([...progIdKeys(o, HKLM), ...capabilityKeys(o, HKLM)].join('\n').toLowerCase()).digest('hex');
function buildMachineRegister(o) {
  return ['Windows Registry Editor Version 5.00', '',
    ...PROGS.flatMap((id) => [`[-${HKLM}Software\\Classes\\${id}]`, '']),
    `[-${HKLM}Software\\AlvaPlayer]`, '',
    ...progIdKeys(o, HKLM), ...capabilityKeys(o, HKLM),
    ...key('Software\\AlvaPlayer', { RegSig: q(machineSig(o)) }, HKLM),
  ].join('\r\n') + '\r\n';
}
function buildMachineUnregister(o) {
  return ['Windows Registry Editor Version 5.00', '',
    ...PROGS.flatMap((id) => [`[-${HKLM}Software\\Classes\\${id}]`, '']),
    `[-${HKLM}Software\\AlvaPlayer]`, '',
    ...key('Software\\RegisteredApplications', { [o.appName]: '-' }, HKLM),
  ].join('\r\n') + '\r\n';
}

// what gets registered, from the running app's facts (the dev build runs electron.exe with the app folder)
function options({ appName, execPath, isPackaged, appDir, iconPath, iconVideo, iconAudio, version, exts, audioExts = [], sizeKB = 0, date, managed = false }) {
  return {
    appName, exe: execPath, packaged: isPackaged, version, exts, sizeKB, date, managed,
    installDir: path.dirname(execPath),
    command: isPackaged ? `"${execPath}" "%1"` : `"${execPath}" "${appDir}" "%1"`,
    icon: `${iconPath},0`, audioExts,
    // a full icon location ("file,-id") passes through; a bare file gets its first icon
    iconVideo: iconVideo ? (/,-?\d+$/.test(iconVideo) ? iconVideo : `${iconVideo},0`) : null, iconAudio: iconAudio ? `${iconAudio},0` : null,
  };
}

function buildRegister(o) {
  const exts = o.exts.filter((e) => !SKIP.has(e));
  const exeName = path.basename(o.exe);
  const L = ['Windows Registry Editor Version 5.00', '', ...progIdKeys(o, HK)];
  if (o.machine) {
    // the Default-apps entry is machine-wide (buildMachineRegister): a second per-user one would list it twice
    L.push(`[-${HK}Software\\AlvaPlayer]`, '');
    L.push(...key('Software\\RegisteredApplications', { [o.appName]: '-' }));
  } else L.push(...capabilityKeys(o, HK));
  // "Open with" lists it for every media type
  for (const e of exts) { const id = progFor(o, e); L.push(...key(`Software\\Classes\\.${e}\\OpenWithProgids`, { [id]: 'hex(0):', [id === PROG ? PROG_AUDIO : PROG]: '-' })); }
  if (o.packaged) {
    // the exe as Open with → "Choose another app" knows it (the dev build runs electron.exe: never claim that)
    L.push(...key(`Software\\Classes\\Applications\\${exeName}`, { FriendlyAppName: q(o.appName) }));
    L.push(...key(`Software\\Classes\\Applications\\${exeName}\\DefaultIcon`, { '@': q(o.icon) }));
    L.push(...key(`Software\\Classes\\Applications\\${exeName}\\shell\\open\\command`, { '@': q(o.command) }));
    L.push(...key(`Software\\Classes\\Applications\\${exeName}\\SupportedTypes`, Object.fromEntries(exts.map((e) => ['.' + e, q('')]))));
    // Settings › Apps › Installed apps (with a working Uninstall) and Win+R "the player"
    L.push(...key(APP_PATHS + exeName, { '@': q(o.exe), Path: q(o.installDir) }));
    // installed by superpack: the pack owns the Installed-apps entry and the uninstall
    if (!o.managed) L.push(...key(UNINSTALL, {
      DisplayName: q(o.appName), DisplayIcon: q(o.exe + ',0'), DisplayVersion: q(o.version), Publisher: q('alva'),
      InstallLocation: q(o.installDir), InstallDate: q(o.date), UninstallString: q(`"${o.exe}" --uninstall`),
      QuietUninstallString: q(`"${o.exe}" --uninstall --quiet`), NoModify: dword(1), NoRepair: dword(1), EstimatedSize: dword(o.sizeKB || 0),
    }));
  }
  return L.join('\r\n') + '\r\n';
}

// state: { ext: 'drop' | 'value' | 'skip' } from extState() — 'drop' = the .ext key holds nothing but our value
// (registration created it), 'value' = remove only our value, 'skip' = nothing of ours there (and a .reg key
// header would CREATE the key, so it is left out). keepUninstallEntry: the folder deleter removes that entry
// itself once the folder is really gone, so a failed delete can still be retried from Installed apps.
function buildUnregister(o, state = {}, { keepUninstallEntry = false } = {}) {
  const exeName = path.basename(o.exe);
  const L = ['Windows Registry Editor Version 5.00', ''];
  for (const id of PROGS) L.push(`[-${HK}Software\\Classes\\${id}]`, '');
  L.push(`[-${HK}Software\\AlvaPlayer]`, '');
  L.push(...key('Software\\RegisteredApplications', { [o.appName]: '-' }));
  for (const e of o.exts.filter((x) => !SKIP.has(x))) {
    if (state[e] === 'drop') L.push(`[-${HK}Software\\Classes\\.${e}]`, '');
    else if (state[e] === 'value') L.push(...key(`Software\\Classes\\.${e}\\OpenWithProgids`, { [PROG]: '-', [PROG_AUDIO]: '-' }));
  }
  if (o.packaged) {
    L.push(`[-${HK}Software\\Classes\\Applications\\${exeName}]`, '');
    L.push(`[-${HK}${APP_PATHS}${exeName}]`, '');
    if (!keepUninstallEntry && !o.managed) L.push(`[-${HK}${UNINSTALL}]`, ''); // a pack install never had one
  }
  return L.join('\r\n') + '\r\n';
}

// read-only: what of ours sits under HKCU\Software\Classes\.<ext>
function regQuery(k) {
  return new Promise((resolve) => execFile(REG, ['query', k, '/s'], { windowsHide: true, cwd: SYS32 }, (err, out) => resolve(err ? null : String(out))));
}
async function extState(exts) {
  const entries = await Promise.all(exts.filter((e) => !SKIP.has(e)).map(async (e) => {
    const out = await regQuery(`HKCU\\Software\\Classes\\.${e}`);
    if (!out) return [e, 'skip'];
    const keys = out.split(/\r?\n/).filter((l) => /^HKEY_/.test(l));
    const values = out.split(/\r?\n/).filter((l) => /^\s{4}\S.*\s{4}REG_\w+/.test(l));
    const ours = values.filter((l) => PROGS.some((id) => l.trim().startsWith(id + ' ') || l.trim().startsWith(id + '\t'))).length;
    if (!ours) return [e, 'skip'];
    return [e, values.length === ours && keys.length <= 2 ? 'drop' : 'value'];
  }));
  return Object.fromEntries(entries);
}

// .reg files are UTF-16 LE with a BOM; one import = one consistent write
function writeRegFile(text) {
  const file = path.join(os.tmpdir(), `the-player-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  return file;
}
function importReg(text) {
  const file = writeRegFile(text);
  return new Promise((resolve, reject) => execFile(REG, ['import', file], { windowsHide: true, cwd: SYS32 }, (err, _o, se) => {
    try { fs.unlinkSync(file); } catch {}
    err ? reject(new Error(String(se || err.message).trim())) : resolve();
  }));
}
// the machine-wide half: Windows shows its own permission prompt (UAC) for reg.exe; "No" rejects with declined=true
// .NET ShellExecute with the "runas" verb keeps the real Win32 error: 1223 = he pressed No (anything else is a failure).
// dryRun (QA) prints the exact program + arguments instead of starting anything.
function elevateScript(file, { dryRun = false } = {}) {
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    `$si = New-Object System.Diagnostics.ProcessStartInfo ${lit(REG)}`,
    `$si.Arguments = ${lit(`import "${file}"`)}`,
    `$si.Verb = 'runas'; $si.UseShellExecute = $true; $si.WindowStyle = 'Hidden'`,
    dryRun ? `[Console]::Out.Write($si.FileName + '|' + $si.Arguments + '|' + $si.Verb); exit 0` : '',
    `try { $p = [System.Diagnostics.Process]::Start($si) } catch { $b = $_.Exception.GetBaseException(); if ($b -is [System.ComponentModel.Win32Exception] -and $b.NativeErrorCode -eq 1223) { exit 1223 }; [Console]::Error.WriteLine($b.Message); exit 2 }`,
    `$p.WaitForExit(); exit $p.ExitCode`,
  ].join('\n');
}
function runPowerShell(script) {
  return new Promise((resolve) => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, cwd: SYS32 },
    (err, out, se) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(se || '').trim() })));
}
async function importRegElevated(text) {
  const file = writeRegFile(text);
  const r = await runPowerShell(elevateScript(file));
  try { fs.unlinkSync(file); } catch {}
  if (r.code === 0) return;
  const e = new Error(r.code === 1223 ? 'Windows permission was declined' : `Windows could not save the machine-wide registration${r.err ? ': ' + r.err : ''}`);
  e.declined = r.code === 1223;
  throw e;
}
// read-only: 'none' (no machine-wide entry), 'current' (there, pointing at this exe) or 'stale' (there, other command)
async function machineState(o) {
  const query = (args) => new Promise((resolve) => execFile(REG, ['query', ...args], { windowsHide: true, cwd: SYS32 }, (err, out) => resolve(err ? null : String(out))));
  if (!(await query(['HKLM\\Software\\RegisteredApplications', '/v', o.appName]))) return 'none';
  const cmd = await query([`HKLM\\Software\\Classes\\${PROG}\\shell\\open\\command`, '/ve']);
  const sig = await query(['HKLM\\Software\\AlvaPlayer', '/v', 'RegSig']);
  return stateFrom(cmd, sig, o);
}
// pure: reg.exe query output → state (paths compare case-insensitively, like Windows)
function stateFrom(cmdOut, sigOut, o) {
  const val = (out) => { const m = out && /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out); return m ? m[1] : null; };
  const cmd = val(cmdOut), sig = val(sigOut);
  return cmd && cmd.toLowerCase() === o.command.toLowerCase() && sig === machineSig(o) ? 'current' : 'stale';
}

// Microsoft: apps that register handlers MUST broadcast SHCNE_ASSOCCHANGED (SHCNF_IDLIST | SHCNF_FLUSH, null items),
// then give the shell a moment (their sample sleeps 1 s) before Settings reads it — otherwise Default apps can miss the app
function notifyShell() {
  const ps = "Add-Type -Namespace W -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'; [W.S]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)";
  return new Promise((resolve) => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, cwd: SYS32 }, () => setTimeout(resolve, 1000)));
}

// The uninstaller can't delete the folder it runs from: this script waits for that process to end, then deletes the
// folder ONLY if nothing at all runs from it any more (it never deletes around a running app), retries a locked file a
// few times, and removes the Installed apps entry last — so a folder that survives can still be uninstalled again.
function deleterScript(dir, pid) {
  const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    `$d=${lit(dir)}; $reg=${lit(REG)}`,
    `try { Wait-Process -Id ${Number(pid) | 0} -Timeout 600 -ErrorAction SilentlyContinue } catch {}`,
    `for ($i=0; $i -lt 120; $i++) {`,
    `  if (-not (Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($d + '\\', 'OrdinalIgnoreCase') })) {`,
    `    for ($k=0; $k -lt 5 -and (Test-Path -LiteralPath $d); $k++) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $d) { Start-Sleep -Seconds 1 } }`,
    `    if (-not (Test-Path -LiteralPath $d)) { & $reg delete ${lit('HKCU\\' + UNINSTALL)} /f | Out-Null }`,
    `    exit`,
    `  }`,
    `  Start-Sleep -Milliseconds 500`,
    `}`,
  ].join('\n');
}

function dirSizeKB(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size; } catch {} } } };
  try { walk(dir); } catch {}
  return Math.round(total / 1024);
}

module.exports = {
  PROG, PROG_AUDIO, PROGS, progFor, CAP, SKIP, REG, POWERSHELL, SYS32, UNINSTALL, options, buildRegister, buildUnregister, buildMachineRegister, buildMachineUnregister,
  extState, importReg, importRegElevated, elevateScript, runPowerShell, machineState, stateFrom, machineSig, notifyShell, deleterScript, dirSizeKB,
};
