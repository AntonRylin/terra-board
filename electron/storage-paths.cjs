const path = require('node:path');

function libraryRoot({ isPackaged, appPath, exePath, dataDir, distribution, localAppData }) {
  if (dataDir) return path.resolve(dataDir);
  if (isPackaged && distribution === 'installed') {
    if (!localAppData || !path.isAbsolute(localAppData))
      throw Error('The local application data folder could not be located.');
    return path.join(localAppData, 'Terra Board', 'Library');
  }
  // The packaged executable lives in <repository>/release/win-unpacked.
  // Keep the library outside that replaceable build directory.
  const repository = isPackaged ? path.resolve(path.dirname(exePath), '../..') : appPath;
  return path.join(repository, 'Library');
}

module.exports = { libraryRoot };
