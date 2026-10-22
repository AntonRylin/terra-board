const path = require('node:path');

function libraryRoot({ isPackaged, appPath, exePath, dataDir, distribution, localAppData }) {
  if (dataDir) return path.resolve(dataDir);
  if (isPackaged && distribution === 'installed') {
    if (!localAppData || !path.isAbsolute(localAppData))
      throw Error('The local application data folder could not be located.');
    return path.join(localAppData, 'Terra Board', 'Library');
  }
  // The packaged executable lives in <repository>/release/win-unpacked (or
  // linux-unpacked). Keep the library outside that replaceable build directory.
  const repository = isPackaged ? path.resolve(path.dirname(exePath), '../..') : appPath;
  return path.join(repository, 'Library');
}

// The per-user folder installed copies keep `Terra Board/Library` (and its
// Extensions) in: %LOCALAPPDATA% on Windows, and on Linux $XDG_DATA_HOME, or
// ~/.local/share when that is unset or not absolute (XDG Base Directory spec).
function userDataBase({ platform = process.platform, env = process.env, home, appData }) {
  if (platform === 'win32') return env.LOCALAPPDATA || appData;
  const xdg = env.XDG_DATA_HOME;
  if (xdg && path.posix.isAbsolute(xdg)) return xdg;
  return home ? path.posix.join(home, '.local', 'share') : undefined;
}

module.exports = { libraryRoot, userDataBase };
