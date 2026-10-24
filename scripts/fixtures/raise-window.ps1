# Keeps a window above all others (or lets it go back among them) without
# activating it, so a check can read what the screen shows in it.
param([long]$Handle, [switch]$Release)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RaiseWindow {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
# HWND_TOPMOST or HWND_NOTOPMOST; SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE.
$after = if ($Release) { -2 } else { -1 }
[RaiseWindow]::SetWindowPos([IntPtr]::new($Handle), [IntPtr]::new($after), 0, 0, 0, 0, 0x13) | Out-Null
