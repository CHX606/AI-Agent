param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BitAgentShellIcon {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct FileInfo { public IntPtr Icon; public int Index; public uint Attributes;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string DisplayName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string TypeName; }
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
 public static extern IntPtr SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
"@
$info = [BitAgentShellIcon+FileInfo]::new()
$result = [BitAgentShellIcon]::SHGetFileInfo($Executable, 0, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info), 256)
if ($result -eq [IntPtr]::Zero -or $info.Icon -eq [IntPtr]::Zero) { throw 'Windows Shell cannot load the application icon' }
try {
 $image = [System.Drawing.Icon]::FromHandle($info.Icon).ToBitmap()
 try {
  $orange = 0; $white = 0
  for ($y=0; $y -lt $image.Height; $y++) {
   for ($x=0; $x -lt $image.Width; $x++) {
    $pixel = $image.GetPixel($x,$y)
    if ($pixel.A -gt 200 -and $pixel.R -gt 150 -and $pixel.G -gt 55 -and $pixel.G -lt 170 -and $pixel.B -lt 100) { $orange++ }
    if ($pixel.A -gt 200 -and $pixel.R -gt 235 -and $pixel.G -gt 235 -and $pixel.B -gt 235) { $white++ }
   }
  }
  $image.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
  @{size=@{width=$image.Width;height=$image.Height};orange=$orange;white=$white} | ConvertTo-Json -Compress
 } finally { $image.Dispose() }
} finally { [void][BitAgentShellIcon]::DestroyIcon($info.Icon) }
