const { build } = require('./package.json');

// Keep distribution builds separate from the repository-local app and Library.
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release/installer' },
  extraMetadata: { terraDistribution: 'installed' },
  win: { ...build.win, target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    artifactName: 'Terra-Board-Setup-${version}-${arch}.${ext}',
  },
};
