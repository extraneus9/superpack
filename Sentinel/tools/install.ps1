# Sentinel desktop-app installer.
# Builds the icon + silent launcher and puts a "Sentinel" shortcut on the Desktop and
# in the Start Menu. Run once:   powershell -ExecutionPolicy Bypass -File tools\install.ps1
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$ico = Join-Path $proj 'assets\sentinel.ico'
if (-not (Test-Path $ico)) {   # build_exe.ps1 already makes the icon; only regenerate if missing
  $py = @("$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
          "$env:LOCALAPPDATA\Python\pythoncore-3.10-64\python.exe") |
          Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($py) { & $py (Join-Path $proj 'tools\make_launcher.py') | Out-Null }
}
# Prefer the standalone exe (no Python needed); fall back to the silent Python launcher.
$exe = Join-Path $proj 'dist\Sentinel.exe'
if (Test-Path $exe) { $target = $exe; $workdir = (Split-Path $exe) }
else                { $target = Join-Path $proj 'Sentinel.vbs'; $workdir = $proj }
$sh  = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'Sentinel.lnk'))
  $lnk.TargetPath       = $target
  $lnk.WorkingDirectory = $workdir
  $lnk.IconLocation     = $ico
  $lnk.Description       = 'Sentinel - real-time protection'
  $lnk.Save()
}
Write-Host 'Sentinel installed. Double-click "Sentinel" on your Desktop to launch it.'
# To also start Sentinel automatically with Windows, uncomment the next 3 lines:
# $startup = [Environment]::GetFolderPath('Startup')
# $s = $sh.CreateShortcut((Join-Path $startup 'Sentinel.lnk'))
# $s.TargetPath=$target; $s.WorkingDirectory=$workdir; $s.IconLocation=$ico; $s.Save()
