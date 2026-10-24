# A small window for the app-frame check: an orange form that writes where it
# is and how big it is to a file, so the check can see it docked and given back.
param([string]$Report, [string]$Title = 'Terra test app')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
public static class TestAppWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern System.IntPtr SetProcessDpiAwarenessContext(System.IntPtr v);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr h, int attr, out RECT r, int size);
}
'@
[TestAppWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.BackColor = [System.Drawing.Color]::FromArgb(232, 131, 58)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.Size = New-Object System.Drawing.Size(420, 300)
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Terra test app'
$label.Font = New-Object System.Drawing.Font('Segoe UI', 20)
$label.ForeColor = [System.Drawing.Color]::White
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 20)
$form.Controls.Add($label)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
  $r = New-Object TestAppWin32+RECT
  [TestAppWin32]::GetWindowRect($form.Handle, [ref]$r) | Out-Null
  $v = New-Object TestAppWin32+RECT
  [TestAppWin32]::DwmGetWindowAttribute($form.Handle, 9, [ref]$v, 16) | Out-Null
  $json = '{"x":' + $r.Left + ',"y":' + $r.Top + ',"width":' + ($r.Right - $r.Left) + ',"height":' + ($r.Bottom - $r.Top) +
    ',"visible":{"x":' + $v.Left + ',"y":' + $v.Top + ',"width":' + ($v.Right - $v.Left) + ',"height":' + ($v.Bottom - $v.Top) + '}' +
    ',"handle":"' + $form.Handle.ToInt64() + '"}'
  [IO.File]::WriteAllText($Report, $json)
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
