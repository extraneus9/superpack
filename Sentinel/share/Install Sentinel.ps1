# Sentinel installer — copies the app into your user folder and adds Desktop + Start Menu shortcuts.
# Right-click this file -> "Run with PowerShell".
$ErrorActionPreference = 'Stop'
$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Sentinel\app'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $src 'Sentinel.exe') $dest -Force
$exe = Join-Path $dest 'Sentinel.exe'
$sh  = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'Sentinel.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.Description = 'Sentinel - free real-time protection'
  $lnk.Save()
}
Write-Host 'Sentinel installed. Launching it now; a "Sentinel" shortcut is on your Desktop.'
Start-Process $exe
