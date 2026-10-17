# QA for frame counting: native OpenGL (kernel path) + WPF/D3D9 (runtime path).
# Run elevated. Tests build\test\FrameHUD.exe; with -Installer it installs only if every
# pass is within tolerance, then re-runs the passes against the installed exe.
param([string]$Out = "$env:TEMP\FrameHUD-qa", [string]$Installer = '')
$ErrorActionPreference = 'Continue'
$tools = Join-Path $PSScriptRoot '..\build\test'
New-Item -ItemType Directory -Force $Out | Out-Null
Remove-Item "$Out\*" -Force -ErrorAction SilentlyContinue

function Pass($bin, $name, $exe, $argList, $focus) {
    $p = Start-Process "$tools\$exe" -ArgumentList $argList -PassThru
    Start-Sleep -Seconds 2
    Start-Process "$bin\FrameHUD.exe" -ArgumentList '--presenttest', '6', "$Out\$name-trace.txt", $focus -Wait
    $p.WaitForExit()
    $line = Get-Content "$Out\$name-trace.txt" | ? { $_ -like 'GetStats*' }
    if ($line -match '= ([\d.]+) fps') { return [double]$matches[1] } else { return -1 }
}

function Suite($bin, $tag) {
    $r = @{}
    $r.gl120 = Pass $bin "$tag-gl120" 'GLTest.exe' @('120', '10', "$Out\$tag-gl120-app.txt") 'GLTest'
    $r.gl60  = Pass $bin "$tag-gl60"  'GLTest.exe' @('60', '10', "$Out\$tag-gl60-app.txt") 'GLTest'
    $r.wpf   = Pass $bin "$tag-wpf"   'DXTest.exe' @('10', "$Out\$tag-wpf-app.txt") 'DXTest'
    $wpfRef = [double]((Get-Content "$Out\$tag-wpf-app.txt" | ? { $_ -like 'rendering*' }) -split ' ')[1]
    $ok = [math]::Abs($r.gl120 - 120) -le 4 -and [math]::Abs($r.gl60 - 60) -le 2 -and $wpfRef -gt 0 -and [math]::Abs($r.wpf - $wpfRef) / $wpfRef -le 0.1
    "$tag  gl120=$($r.gl120)  gl60=$($r.gl60)  wpf=$($r.wpf) (app $wpfRef)  => $(if ($ok) {'PASS'} else {'FAIL'})" | Add-Content "$Out\summary.txt"
    return $ok
}

$ok = Suite (Join-Path $PSScriptRoot '..\build\test') 'test'
if ($ok -and $Installer) {
    Start-Process $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait
    "installed $(Get-Date -f s)" | Add-Content "$Out\summary.txt"
    Suite "$env:ProgramFiles\FrameHUD" 'installed' | Out-Null
    Start-Process "$env:ProgramFiles\FrameHUD\FrameHUD.exe"
}
'done' | Set-Content "$Out\done.txt"
