// Run with Electron; all settings and captures live in an isolated test folder.
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { attachWindowShadow } = require('../electron/window-shadow.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.resolve('.local-test'), { recursive: true });
const root = fs.mkdtempSync(path.resolve('.local-test/window-shadow-'));
app.setPath('userData', path.join(root, 'settings'));
app.setPath('sessionData', path.join(root, 'session'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw Error('Timed out: ' + label);
}
app
  .whenReady()
  .then(async () => {
    const display = screen.getPrimaryDisplay();
    const origin = { x: display.workArea.x + 90, y: display.workArea.y + 90 };
    const backdrop = new BrowserWindow({
      ...origin,
      width: 1100,
      height: 800,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      backgroundColor: '#edf1f6',
    });
    await backdrop.loadURL('data:text/html,<body style="margin:0;background:%23edf1f6"></body>');
    backdrop.showInactive();
    const owner = new BrowserWindow({
      x: origin.x + 100,
      y: origin.y + 90,
      width: 900,
      height: 620,
      show: false,
      title: 'Terra Board · Shadow verification',
      backgroundColor: '#fbfcfd',
    });
    owner.setMenu(null);
    await owner.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="margin:0;background:#fbfcfd;font:16px Segoe UI;color:#6d7785"><p style="margin:30px">Terra Board — window shadow</p></body>',
        ),
    );
    const shadow = attachWindowShadow(owner, { BrowserWindow });
    owner.show();
    await until(() => shadow.isVisible(), 'shadow visible');
    await sleep(300);
    const { execFileSync } = require('node:child_process');
    const hwnd = owner.getNativeWindowHandle().readBigUInt64LE().toString();
    const native = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowFrameRead {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int left,top,right,bottom;}
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out Rect rect,int size);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
}
'@; $r = New-Object WindowFrameRead+Rect; [WindowFrameRead]::DwmGetWindowAttribute([IntPtr]${hwnd},9,[ref]$r,16) | Out-Null; @{frame=$r;style=[WindowFrameRead]::GetWindowLongPtr([IntPtr]${shadow.getNativeWindowHandle().readBigUInt64LE()},-20).ToInt64()} | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    const { frame, style } = JSON.parse(native);
    const visible = screen.screenToDipRect(owner, {
      x: frame.left,
      y: frame.top,
      width: frame.right - frame.left,
      height: frame.bottom - frame.top,
    });
    const shadowBounds = shadow.getBounds();
    assert.ok(
      Math.abs(shadowBounds.x + 56 - visible.x) <= 2,
      'shadow aligns with native left edge',
    );
    assert.ok(Math.abs(shadowBounds.y + 56 - visible.y) <= 2, 'shadow aligns with native top edge');
    assert.ok(
      Math.abs(shadowBounds.height - 112 - visible.height) <= 2,
      'shadow aligns with native bottom edge',
    );
    assert.ok(style & 0x20, 'native WS_EX_TRANSPARENT makes decoration click-through');
    assert.ok(style & 0x08000000, 'native WS_EX_NOACTIVATE prevents focus stealing');
    assert.equal(shadow.isFocusable(), false);
    assert.equal(shadow.isResizable(), false);
    assert.equal(shadow.getParentWindow(), owner);
    assert.equal(BrowserWindow.getFocusedWindow(), owner, 'shadow never steals focus');
    const capture = await shadow.webContents.capturePage();
    fs.writeFileSync(path.join(root, 'shadow-alpha.png'), capture.toPNG());
    const size = capture.getSize(),
      bitmap = capture.toBitmap();
    const alpha = (x, y) => bitmap[(Math.floor(y) * size.width + Math.floor(x)) * 4 + 3];
    assert.equal(alpha(size.width / 2, size.height / 2), 0, 'center is fully transparent');
    const scale = size.width / shadow.getContentBounds().width;
    assert.ok(alpha(44 * scale, size.height / 2) > 3, 'soft shadow renders outside main frame');
    assert.ok(
      alpha(44 * scale, size.height / 2) > alpha(5 * scale, size.height / 2),
      'shadow fades outward',
    );

    // Capture only the fixture's backdrop rectangle, never the rest of the desktop.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((source) => source.display_id === String(display.id));
    if (source) {
      const factor = source.thumbnail.getSize().width / display.size.width;
      const bounds = backdrop.getBounds();
      fs.writeFileSync(
        path.join(root, 'desktop-shadow.png'),
        source.thumbnail
          .crop({
            x: Math.round((bounds.x - display.bounds.x) * factor),
            y: Math.round((bounds.y - display.bounds.y) * factor),
            width: Math.round(bounds.width * factor),
            height: Math.round(bounds.height * factor),
          })
          .toPNG(),
      );
    }

    const before = shadow.getBounds();
    const bounds = owner.getBounds();
    owner.setBounds({
      x: bounds.x + 35,
      y: bounds.y + 20,
      width: bounds.width - 70,
      height: bounds.height - 40,
    });
    await sleep(100);
    await until(() => Math.abs(shadow.getBounds().x - before.x - 35) <= 2, 'shadow follows move');
    assert.ok(Math.abs(shadow.getBounds().width - before.width + 70) <= 2, 'shadow follows resize');
    owner.maximize();
    await until(() => owner.isMaximized() && !shadow.isVisible(), 'maximized shadow hidden');
    owner.unmaximize();
    await until(() => !owner.isMaximized() && shadow.isVisible(), 'restored shadow visible');
    owner.minimize();
    await until(() => owner.isMinimized() && !shadow.isVisible(), 'minimized shadow hidden');
    owner.restore();
    await until(() => shadow.isVisible(), 'unminimized shadow visible');
    owner.hide();
    await until(() => !shadow.isVisible(), 'hidden owner has no shadow');
    owner.show();
    await until(() => shadow.isVisible(), 'reshown shadow visible');
    owner.destroy();
    await until(() => shadow.isDestroyed(), 'shadow closes with owner');
    backdrop.destroy();
    console.log(
      JSON.stringify({
        passed: true,
        artifacts: root,
        checks:
          'Transparent center, visible soft falloff, focus, move, resize, maximize, minimize, hide/show, close',
      }),
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
