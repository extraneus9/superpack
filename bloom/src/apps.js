// Who sent a toast: app name, icon and (for Store apps) install folder, from its AppUserModelID.
// One PowerShell pass resolves a batch of ids; results are cached on disk so it runs once per app.
const { app, nativeImage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ids = Get-Content $env:BLOOM_IN -Raw | ConvertFrom-Json
$start = @{}; Get-StartApps | ForEach-Object { $start[$_.AppID.ToLower()] = $_.Name }
function Find-Asset($root, $rel) {
  $dir = Join-Path $root (Split-Path $rel); $base = [IO.Path]::GetFileNameWithoutExtension($rel)
  $best = $null; $bestScore = -1
  Get-ChildItem $dir -Filter "$base*.png" | Where-Object { $_.Name -notmatch 'contrast-' } | ForEach-Object {
    $s = 0
    if ($_.Name -match 'altform-unplated') { $s += 1000 }
    if ($_.Name -match 'targetsize-(\d+)') { $s += 500 - [Math]::Abs([int]$Matches[1] - 96) }
    elseif ($_.Name -match 'scale-(\d+)') { $s += [int]$Matches[1] / 10 }
    if ($s -gt $bestScore) { $bestScore = $s; $best = $_.FullName }
  }
  if (-not $best -and (Test-Path (Join-Path $root $rel))) { $best = Join-Path $root $rel }
  $best
}
$lnkMap = $null
function Get-LnkMap {
  $m = @{}; $sh = New-Object -ComObject Shell.Application
  foreach ($root in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
    Get-ChildItem $root -Recurse -Filter *.lnk | ForEach-Object {
      $id = $sh.NameSpace($_.DirectoryName).ParseName($_.Name).ExtendedProperty('System.AppUserModel.ID')
      if ($id) { $m[$id.ToLower()] = $_.FullName }
    }
  }
  $m
}
$kf = @{ '{6D809377-6AF0-444B-8957-A3773F02200E}' = $env:ProgramFiles; '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}' = (Get-Item 'Env:ProgramFiles(x86)').Value;
         '{F38BF404-1D43-42F2-9305-67DE0B28FC23}' = $env:windir; '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}' = "$env:windir\System32";
         '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}' = "$env:windir\SysWOW64" }
$pkgs = $null
$out = @()
foreach ($id in $ids) {
  $r = [ordered]@{ aumid = $id; name = $start[$id.ToLower()]; icon = $null; install = $null; target = $null }
  if ($id -match '^([^!\\]+_[a-z0-9]{13})!(.+)$') {
    $fam = $Matches[1]; $appId = $Matches[2]
    if ($null -eq $pkgs) { $pkgs = @(Get-AppxPackage) }
    $pkg = $pkgs | Where-Object { $_.PackageFamilyName -eq $fam } | Select-Object -First 1
    if ($pkg) {
      $r.install = $pkg.InstallLocation
      [xml]$man = Get-Content (Join-Path $pkg.InstallLocation 'AppxManifest.xml') -Raw
      $apps = @($man.Package.Applications.Application)
      $a = $apps | Where-Object { $_.Id -eq $appId } | Select-Object -First 1
      if (-not $a) { $a = $apps[0] }
      $ve = $a.VisualElements
      $logo = $ve.Square44x44Logo; if (-not $logo) { $logo = $ve.Square150x150Logo }
      if ($logo) { $r.icon = Find-Asset $pkg.InstallLocation $logo }
      if (-not $r.name -and $ve.DisplayName -notmatch '^ms-resource') { $r.name = $ve.DisplayName }
    }
  } else {
    if ($id -match '\\') { $p = $id; foreach ($k in $kf.Keys) { $p = $p.Replace($k, $kf[$k]) }; if (Test-Path $p) { $r.target = $p } }
    if (-not $r.target) { if ($null -eq $lnkMap) { $lnkMap = Get-LnkMap }; $r.target = $lnkMap[$id.ToLower()] }
  }
  $out += [pscustomobject]$r
}
ConvertTo-Json @($out) -Compress -Depth 3
`;
const ENCODED = Buffer.from(PS, 'utf16le').toString('base64');

let cache = null;
const cacheFile = () => path.join(app.getPath('userData'), 'apps.json');
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = {}; }
  return cache;
}
function save() { try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch {} }

const pending = new Map(); // aumid -> promise, so one app is never resolved twice at once

function runPs(ids) {
  return new Promise((resolve) => {
    const inFile = path.join(os.tmpdir(), `bloom-apps-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(inFile, JSON.stringify(ids));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { env: { ...process.env, BLOOM_IN: inFile }, windowsHide: true, timeout: 60000, maxBuffer: 8 << 20 },
      (_err, stdout) => {
        fs.rm(inFile, { force: true }, () => {});
        try { const j = JSON.parse(String(stdout).trim() || '[]'); resolve(Array.isArray(j) ? j : [j]); } catch { resolve([]); }
      });
  });
}

async function iconFor(r) {
  try {
    if (r.icon) {
      const img = nativeImage.createFromPath(r.icon);
      if (!img.isEmpty()) return img.resize({ width: 96, height: 96, quality: 'best' }).toDataURL();
    }
    if (r.target) {
      const img = await app.getFileIcon(r.target, { size: 'large' });
      if (img && !img.isEmpty()) return img.toDataURL();
    }
  } catch {}
  return null;
}

// Resolve many ids in one PowerShell pass (startup warm-up) or one id on demand.
async function resolveMany(ids) {
  const c = load();
  const todo = [...new Set(ids)].filter((id) => id && !c[id] && !pending.has(id));
  if (!todo.length) return;
  const job = (async () => {
    const rows = await runPs(todo);
    for (const r of rows) {
      if (!r || !r.aumid) continue;
      c[r.aumid] = { name: r.name || null, install: r.install || null, iconData: await iconFor(r) };
    }
    for (const id of todo) if (!c[id]) c[id] = { name: null, install: null, iconData: null };
    save();
  })();
  todo.forEach((id) => pending.set(id, job));
  try { await job; } finally { todo.forEach((id) => pending.delete(id)); }
}

async function resolve(aumid, waitMs = 1500) {
  const c = load();
  if (c[aumid]) return c[aumid];
  const job = pending.get(aumid) || resolveMany([aumid]);
  await Promise.race([job, new Promise((r) => setTimeout(r, waitMs))]);
  return c[aumid] || null;
}

function prettyName(aumid) {
  if (/^NotifyIconGeneratedAumid_/i.test(aumid)) return null;
  const tail = aumid.split(/[!\\]/).pop().replace(/\.exe$/i, '');
  return tail.split('.').pop();
}

module.exports = { resolve, resolveMany, prettyName };
