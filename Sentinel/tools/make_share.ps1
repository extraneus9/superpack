# Assemble the CLEAN shareable Windows package (no secrets, no community/GPL rules) into dist-share/.
# Run AFTER building the exe:  powershell -ExecutionPolicy Bypass -File tools\make_share.ps1
# Then run your public-scan tool on  dist-share\Sentinel  before sharing.
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $proj 'dist\Sentinel.exe'
if (-not (Test-Path $exe)) { Write-Host "Build the exe first:  tools\build_exe.ps1"; exit 1 }

$shareRoot = Join-Path $proj 'dist-share'
$stage = Join-Path $shareRoot 'Sentinel'
if (Test-Path $shareRoot) { Remove-Item $shareRoot -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item $exe $stage -Force
Copy-Item (Join-Path $proj 'share\README.txt') $stage -Force
Copy-Item (Join-Path $proj 'share\Install Sentinel.ps1') $stage -Force
# empty VT-key template: the end user pastes their OWN free key here; no real key ever shipped
[System.IO.File]::WriteAllText((Join-Path $stage 'VT_API_KEY.default'), '')

$zip = Join-Path $shareRoot 'Sentinel-Windows.zip'
Compress-Archive -Path $stage -DestinationPath $zip -Force

Write-Host "Shareable package: $zip"
Write-Host "Contents:"
Get-ChildItem $stage | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
Write-Host "NEXT: run public-scan on  $stage  before sharing."
