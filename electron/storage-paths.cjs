const path = require('node:path');

function libraryRoot({ isPackaged, appPath, exePath, dataDir }) {
  if (dataDir) return path.resolve(dataDir);
  // The packaged executable lives in <repository>/release/win-unpacked.
  // Keep the library outside that replaceable build directory.
  const repository = isPackaged ? path.resolve(path.dirname(exePath), '../..') : appPath;
  return path.join(repository, 'Library');
}

module.exports = { libraryRoot };
