const { build } = require('./package.json');

// Linux x64: an AppImage (runs anywhere, updates itself from GitHub Releases)
// and a .deb (Debian, Ubuntu and derivatives). Built on Linux only, in GitHub
// Actions (.github/workflows/linux.yml): sharp and onnxruntime need their Linux
// binaries, which npm installs only on Linux. See docs/development.md.
module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release/linux' },
  extraMetadata: {
    terraDistribution: 'installed',
    homepage: 'https://github.com/AntonRylin/terra-board',
    // Electron uses it as the window's app id, so desktops match running
    // windows to the menu entry (terra-board.desktop).
    desktopName: 'terra-board.desktop',
  },
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    icon: 'assets/icon.png',
    executableName: 'terra-board',
    syncDesktopName: true,
    category: 'Office',
    synopsis: 'A private, local visual workspace',
    description:
      'Terra Board is a private whiteboard that keeps boards, images and documents on your computer.',
    maintainer: 'Terra Board by Social Artworks',
    vendor: 'Social Artworks',
  },
  // No version in the name, so releases/latest/download/Terra-Board-x86_64.AppImage
  // always serves the newest one, like the Windows installer.
  appImage: { artifactName: 'Terra-Board-${arch}.${ext}' },
  deb: { artifactName: 'terra-board_${version}_${arch}.${ext}' },
  // Writes app-update.yml into the AppImage so it can find its updates. The
  // workflow builds with --publish never; publishing stays a manual step.
  publish: [
    { provider: 'github', owner: 'AntonRylin', repo: 'terra-board', releaseType: 'release' },
  ],
};
