# A small window for the app-frame check: an orange form whose whole inside
# is a button counting clicks, with a counter ticking five times a second (so
# its picture changes), writing where it is, how big, and the click count to a
# file, so the check can see it parked, docked and given back.
param([string]$Report, [string]$Title = 'Terra test app')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
public static class TestAppWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern System.IntPtr SetProcessDpiAwarenessContext(System.IntPtr v);
  [DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int attr, out RECT r, int size);
}
'@
[TestAppWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.Size = New-Object System.Drawing.Size(420, 300)
$script:clicks = 0
$script:ticks = 0
$button = New-Object System.Windows.Forms.Button
$button.Dock = 'Fill'
$button.FlatStyle = 'Flat'
$button.BackColor = [System.Drawing.Color]::FromArgb(232, 131, 58)
$button.ForeColor = [System.Drawing.Color]::White
$button.Font = New-Object System.Drawing.Font('Segoe UI', 20)
$button.Add_Click({ $script:clicks++ })
$form.Controls.Add($button)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
  $script:ticks++
  $button.Text = "Terra test app " + $script:ticks
  $r = New-Object TestAppWin32+RECT
  [TestAppWin32]::GetWindowRect($form.Handle, [ref]$r) | Out-Null
  $v = New-Object TestAppWin32+RECT
  [TestAppWin32]::DwmGetWindowAttribute($form.Handle, 9, [ref]$v, 16) | Out-Null
  $owner = [TestAppWin32]::GetWindow($form.Handle, 4).ToInt64()
  # The window just above it in Windows' stacking order (GW_HWNDPREV).
  $above = [TestAppWin32]::GetWindow($form.Handle, 3).ToInt64()
  $json = '{"x":' + $r.Left + ',"y":' + $r.Top + ',"width":' + ($r.Right - $r.Left) + ',"height":' + ($r.Bottom - $r.Top) +
    ',"visible":{"x":' + $v.Left + ',"y":' + $v.Top + ',"width":' + ($v.Right - $v.Left) + ',"height":' + ($v.Bottom - $v.Top) + '}' +
    ',"owner":"' + $owner + '","above":"' + $above + '","minimized":' + ([TestAppWin32]::IsIconic($form.Handle)).ToString().ToLower() +
    ',"clicks":' + $script:clicks + ',"handle":"' + $form.Handle.ToInt64() + '"}'
  [IO.File]::WriteAllText($Report, $json)
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
