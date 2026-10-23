const fs = require('node:fs');
const path = require('node:path');

// An AppImage is a single file nobody installs, so the desktop knows nothing
// about it: no applications-menu entry and no handler for terraboard:// links.
// On every start the AppImage writes its own entry to
// $XDG_DATA_HOME/applications (as AppImageLauncher does) and keeps it pointing
// at wherever the file now is. The .deb installs a system entry instead; when
// one exists the AppImage leaves the desktop alone.
const DESKTOP_FILE = 'terra-board.desktop';

// Desktop Entry Exec quoting: a quoted argument escapes " ` $ \ with a
// backslash, and every backslash is escaped again as a string value; a literal
// % is written %%.
function execArgument(value) {
  const quoted = '"' + value.replace(/(["`$\\])/g, '\\$1') + '"';
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function desktopEntry({ appImage, icon }) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Terra Board',
    'Comment=A private, local visual workspace',
    `Exec=${execArgument(appImage)} %U`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Office;',
    'MimeType=x-scheme-handler/terraboard;',
    'X-Terra-Board-AppImage=true',
    '',
  ].join('\n');
}

// Returns what it did, for the log: 'written', 'current' or 'system' (a .deb
// entry exists).
function integrateAppImage({
  appImage,
  dataHome,
  icon,
  // The AppImage's launcher puts its own usr/share first in XDG_DATA_DIRS.
  systemDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .filter((dir) => !process.env.APPDIR || !dir.startsWith(process.env.APPDIR)),
}) {
  if (!appImage || !path.isAbsolute(appImage) || !dataHome || !path.isAbsolute(dataHome))
    return 'skipped';
  if (systemDirs.some((dir) => dir && fs.existsSync(path.join(dir, 'applications', DESKTOP_FILE))))
    return 'system';
  const iconFile = path.join(dataHome, 'Terra Board', 'terra-board.png');
  const entryFile = path.join(dataHome, 'applications', DESKTOP_FILE);
  const content = desktopEntry({ appImage, icon: iconFile });
  if (!fs.existsSync(iconFile)) {
    fs.mkdirSync(path.dirname(iconFile), { recursive: true });
    fs.writeFileSync(iconFile, fs.readFileSync(icon));
  }
  let current = null;
  try {
    current = fs.readFileSync(entryFile, 'utf8');
  } catch {}
  if (current === content) return 'current';
  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  const temp = entryFile + '.tmp';
  fs.writeFileSync(temp, content, { mode: 0o644 });
  fs.renameSync(temp, entryFile);
  return 'written';
}

// The AppImage's launcher puts the AppImage's own folders first in PATH,
// LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR. System programs the
// app starts (LibreOffice) get those variables without them, so they load the
// system's libraries, not the few older ones the AppImage carries.
function systemEnv(env = process.env) {
  const appDir = env.APPDIR;
  if (!env.APPIMAGE || !appDir) return env;
  const out = { ...env };
  for (const name of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    if (out[name] === undefined) continue;
    const kept = out[name].split(':').filter((dir) => dir && !dir.startsWith(appDir));
    if (kept.length) out[name] = kept.join(':');
    else delete out[name];
  }
  return out;
}

// Launch at login on Linux: an XDG autostart entry ($XDG_CONFIG_HOME/autostart)
// that GNOME, KDE, Xfce and the other desktops start at sign-in.
const autostartFile = (configHome) => path.join(configHome, 'autostart', DESKTOP_FILE);

function autostartEnabled({ configHome }) {
  try {
    const entry = fs.readFileSync(autostartFile(configHome), 'utf8');
    return !/^Hidden=true$/m.test(entry) && !/^X-GNOME-Autostart-enabled=false$/m.test(entry);
  } catch {
    return false;
  }
}

function setAutostart({ configHome, executable, enabled }) {
  const file = autostartFile(configHome);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Terra Board',
      `Exec=${execArgument(executable)}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  return true;
}

module.exports = {
  DESKTOP_FILE,
  desktopEntry,
  execArgument,
  integrateAppImage,
  systemEnv,
  autostartEnabled,
  setAutostart,
};
