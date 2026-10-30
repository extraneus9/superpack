# Build Sentinel.exe — a standalone Windows app (no Python needed to run it).
# Run:  powershell -ExecutionPolicy Bypass -File tools\build_exe.ps1
# Output: dist\Sentinel.exe
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

# Find a real Python that has PyInstaller. Skips the WindowsApps 'python' stub and any
# interpreter that's gone. Override with $env:SENTINEL_PY if needed.
function Find-BuildPython {
  $cands = @()
  if ($env:SENTINEL_PY) { $cands += $env:SENTINEL_PY }
  $cands += @(
    "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
    "$env:LOCALAPPDATA\Python\pythoncore-3.10-64\python.exe",
    "$env:LOCALAPPDATA\Python\pythoncore-3.12-64\python.exe"
  )
  $g = Get-Command python -ErrorAction SilentlyContinue
  if ($g -and $g.Source -notlike "*WindowsApps*") { $cands += $g.Source }
  foreach ($c in $cands) {
    if ($c -and (Test-Path $c)) {
      & $c -c "import PyInstaller" 2>$null
      if ($LASTEXITCODE -eq 0) { return $c }
    }
  }
  throw "No Python with PyInstaller found. Install:  <python> -m pip install -r requirements.txt pyinstaller"
}
$py = Find-BuildPython
Write-Host "Building with: $py"

& $py (Join-Path $proj 'tools\make_launcher.py') | Out-Null

& $py -m PyInstaller --noconfirm --onefile --windowed --name Sentinel `
  --icon "assets\sentinel.ico" `
  --add-data "webui;webui" `
  --add-data "sentinel\rules.json;sentinel" `
  --add-data "yara_rules\sentinel_starter.yar;yara_rules" `
  --collect-all yara `
  --collect-all webview `
  --collect-all pyzipper `
  --collect-all Cryptodome `
  --collect-all certifi `
  --collect-all psutil `
  --hidden-import pystray._win32 `
  run_sentinel.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit $LASTEXITCODE)" }

$exe = Join-Path $proj 'dist\Sentinel.exe'
if (-not (Test-Path $exe)) { throw "Build did not produce $exe" }
Write-Host ""
Write-Host "Built: $exe  ($([math]::Round((Get-Item $exe).Length/1MB,1)) MB, $((Get-Item $exe).LastWriteTime))"
