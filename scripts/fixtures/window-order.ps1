# Prints "true" when the first window is in front of the second in Windows'
# stacking order (handles as numbers).
param([long]$Front, [long]$Back)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowOrder {
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static bool InFront(IntPtr front, IntPtr back) {
    // GW_HWNDNEXT: the window below.
    for (IntPtr h = GetWindow(front, 2); h != IntPtr.Zero; h = GetWindow(h, 2))
      if (h == back) return true;
    return false;
  }
}
'@
[WindowOrder]::InFront([IntPtr]::new($Front), [IntPtr]::new($Back)).ToString().ToLower()
