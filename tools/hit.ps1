# Which window is under a screen point (in physical pixels), and a picture of a screen area.
# Usage: hit.ps1 -Points "x,y;x,y" [-Shot "x,y,w,h" -Out file.png]
param([string]$Points = '', [string]$Shot = '', [string]$Out = '')

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Hit {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[Hit]::SetProcessDPIAware() | Out-Null

foreach ($pair in ($Points -split ';' | Where-Object { $_ })) {
  $x, $y = $pair -split ',' | ForEach-Object { [int]$_ }
  $p = New-Object Hit+POINT; $p.X = $x; $p.Y = $y
  $h = [Hit]::GetAncestor([Hit]::WindowFromPoint($p), 2)
  $procId = 0; [Hit]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  "$x,$y -> $name"
}

if ($Shot) {
  $x, $y, $w, $h = $Shot -split ',' | ForEach-Object { [int]$_ }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "saved $Out"
}
