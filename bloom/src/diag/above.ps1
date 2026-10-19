# Diagnostic (read-only): which visible windows are above bloom's overlay at a screen point, plus bloom's own styles.
param([long]$hwnd, [int]$x, [int]$y)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class Z {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
}
"@
$me = [IntPtr]$hwnd
$pt = New-Object Z+POINT; $pt.X = $x; $pt.Y = $y
$wfp = [Z]::GetAncestor([Z]::WindowFromPoint($pt), 2)
$out = @("bloom ex=" + ('{0:X}' -f [Z]::GetWindowLong($me,-20)) + " fromPoint=" + $(if ($wfp -eq $me) { 'BLOOM' } else { $c = New-Object Text.StringBuilder 256; [void][Z]::GetClassName($wfp,$c,256); $p=0; [void][Z]::GetWindowThreadProcessId($wfp,[ref]$p); "$($c) pid $p $((Get-Process -Id $p -EA SilentlyContinue).ProcessName)" }))
$above = New-Object System.Collections.ArrayList
$done = $false
[Z]::EnumWindows({ param($h,$l)
  if ($h -eq $me) { $script:done = $true; return $false }
  $r = New-Object Z+RECT; [void][Z]::GetWindowRect($h,[ref]$r); $cl = 0; [void][Z]::DwmGetWindowAttribute($h,14,[ref]$cl,4)
  if ([Z]::IsWindowVisible($h) -and $cl -eq 0 -and $x -ge $r.L -and $x -lt $r.R -and $y -ge $r.T -and $y -lt $r.B) {
    $c = New-Object Text.StringBuilder 256; [void][Z]::GetClassName($h,$c,256); $p=0; [void][Z]::GetWindowThreadProcessId($h,[ref]$p)
    [void]$above.Add("$((Get-Process -Id $p -EA SilentlyContinue).ProcessName)/$($c) ex=$('{0:X}' -f [Z]::GetWindowLong($h,-20)) $($r.L),$($r.T)-$($r.R),$($r.B)") }
  $true }, [IntPtr]::Zero) | Out-Null
$out += "above: " + $(if ($above.Count) { $above -join ' ; ' } else { 'none' })
$out -join ' | '
