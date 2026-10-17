# Draws the FrameHUD icon at each size and packs the PNGs into assets\FrameHUD.ico.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force "$root\assets" | Out-Null

function Draw([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $r = $s * 0.22; $d = $r * 2; $m = [Math]::Max(0.5, $s * 0.02); $w = $s - 2 * $m
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($m, $m, $d, $d, 180, 90); $p.AddArc($m + $w - $d, $m, $d, $d, 270, 90)
    $p.AddArc($m + $w - $d, $m + $w - $d, $d, $d, 0, 90); $p.AddArc($m, $m + $w - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    $g.FillPath([System.Drawing.Brushes]::Black, $p)
    $red = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 40, 40))
    $bw = [Math]::Max(2, [Math]::Round($s * 0.14)); $base = [Math]::Round($s * 0.78)
    $x1 = [Math]::Round($s * 0.2); $x2 = [Math]::Round($s * 0.43); $x3 = [Math]::Round($s * 0.66)
    $g.FillRectangle($red, $x1, $base - [Math]::Round($s * 0.22), $bw, [Math]::Round($s * 0.22))
    $g.FillRectangle($red, $x2, $base - [Math]::Round($s * 0.40), $bw, [Math]::Round($s * 0.40))
    $g.FillRectangle([System.Drawing.Brushes]::White, $x3, $base - [Math]::Round($s * 0.56), $bw, [Math]::Round($s * 0.56))
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    return ,$ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$imgs = @($sizes | ForEach-Object { ,(Draw $_) })
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$imgs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $imgs[$i].Length
}
foreach ($img in $imgs) { $bw.Write($img) }
[System.IO.File]::WriteAllBytes("$root\assets\FrameHUD.ico", $out.ToArray())
[System.IO.File]::WriteAllBytes("$root\assets\FrameHUD-256.png", $imgs[-1])
"icon written"
