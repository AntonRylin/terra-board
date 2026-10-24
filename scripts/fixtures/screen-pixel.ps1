# The color on the screen at a point (physical pixels), printed as "r,g,b":
# what Windows shows there, Terra's window and what Windows draws into it.
param([int]$X, [int]$Y)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
public static class ScreenPixelDpi {
  [DllImport("user32.dll")] public static extern System.IntPtr SetProcessDpiAwarenessContext(System.IntPtr v);
}
'@
[ScreenPixelDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap(1, 1)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($X, $Y, 0, 0, $bitmap.Size)
$color = $bitmap.GetPixel(0, 0)
"$($color.R),$($color.G),$($color.B)"
