import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { integrateAppImage, execArgument, desktopEntry } = require('../electron/linux-desktop.cjs');

test('desktop entry quotes the AppImage path for Exec', () => {
  assert.equal(
    execArgument('/home/me/Apps/Terra Board.AppImage'),
    '"/home/me/Apps/Terra Board.AppImage"',
  );
  assert.equal(execArgument('/a/$b`c"d\\e%f'), '"/a/\\\\$b\\\\`c\\\\"d\\\\\\\\e%%f"');
  const entry = desktopEntry({ appImage: '/x/T.AppImage', icon: '/i.png' });
  assert.match(entry, /^Exec="\/x\/T\.AppImage" %U$/m);
  assert.match(entry, /^MimeType=x-scheme-handler\/terraboard;$/m);
});

test('an AppImage writes its menu entry, follows a move, and defers to a .deb', () => {
  const root = mkdtempSync(join(tmpdir(), 'terra-desktop-'));
  try {
    const dataHome = join(root, 'data');
    const system = join(root, 'system');
    const icon = join(root, 'icon.png');
    writeFileSync(icon, 'png');
    const run = (appImage) => integrateAppImage({ appImage, dataHome, icon, systemDirs: [system] });
    const entry = join(dataHome, 'applications', 'terra-board.desktop');
    assert.equal(run('/apps/Terra-Board-x86_64.AppImage'), 'written');
    assert.match(readFileSync(entry, 'utf8'), /Exec="\/apps\/Terra-Board-x86_64\.AppImage" %U/);
    assert.equal(readFileSync(join(dataHome, 'Terra Board', 'terra-board.png'), 'utf8'), 'png');
    assert.equal(run('/apps/Terra-Board-x86_64.AppImage'), 'current');
    assert.equal(run('/moved/Terra-Board-x86_64.AppImage'), 'written');
    assert.match(readFileSync(entry, 'utf8'), /Exec="\/moved\//);
    assert.equal(run('relative.AppImage'), 'skipped');
    mkdirSync(join(system, 'applications'), { recursive: true });
    writeFileSync(join(system, 'applications', 'terra-board.desktop'), '');
    rmSync(entry);
    assert.equal(run('/apps/Terra-Board-x86_64.AppImage'), 'system');
    assert.equal(existsSync(entry), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system programs started from an AppImage do not see its library folders', () => {
  const { systemEnv } = require('../electron/linux-desktop.cjs');
  const env = systemEnv({
    APPIMAGE: '/apps/T.AppImage',
    APPDIR: '/tmp/.mount_T',
    PATH: '/tmp/.mount_T:/tmp/.mount_T/usr/sbin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_T/usr/lib',
    XDG_DATA_DIRS: '/tmp/.mount_T/usr/share/:/usr/local/share/:/usr/share/',
    HOME: '/home/me',
  });
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.XDG_DATA_DIRS, '/usr/local/share/:/usr/share/');
  assert.equal(env.HOME, '/home/me');
  const plain = { PATH: '/usr/bin' };
  assert.equal(systemEnv(plain), plain);
});

test('launch at login on Linux writes and removes an XDG autostart entry', () => {
  const { autostartEnabled, setAutostart } = require('../electron/linux-desktop.cjs');
  const configHome = mkdtempSync(join(tmpdir(), 'terra-autostart-'));
  try {
    const file = join(configHome, 'autostart', 'terra-board.desktop');
    assert.equal(autostartEnabled({ configHome }), false);
    const executable = '/opt/Terra Board/terra-board';
    assert.equal(setAutostart({ configHome, executable, enabled: true }), true);
    assert.match(readFileSync(file, 'utf8'), /^Exec="\/opt\/Terra Board\/terra-board"$/m);
    assert.equal(autostartEnabled({ configHome }), true);
    // Turned off in the desktop's own startup settings.
    writeFileSync(file, readFileSync(file, 'utf8') + 'Hidden=true\n');
    assert.equal(autostartEnabled({ configHome }), false);
    assert.equal(setAutostart({ configHome, executable, enabled: false }), false);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
