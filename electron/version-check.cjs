// Reads latest.yml from the newest GitHub release, so every packaged build,
// installed or built from source, learns when a newer installer is published.
// `npm run release` (or uploading latest.yml with the installer) announces it.
const RELEASES_URL = 'https://github.com/AntonRylin/terra-board/releases';
// electron-builder writes latest.yml for the Windows installer and
// latest-linux.yml for the AppImage; each system reads its own.
const versionUrl = (platform = process.platform) =>
  `${RELEASES_URL}/latest/download/${platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'}`;
const PAGE_URL = `${RELEASES_URL}/latest`;

const parts = (version) =>
  String(version)
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

// True when `candidate` is a higher major.minor.patch than `current`.
function isNewer(candidate, current) {
  const a = parts(candidate),
    b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

// The release page for one version.
const releasePage = (version) => `${RELEASES_URL}/tag/v${version}`;

// Top-level `key: value` from electron-builder's latest.yml (or latest-linux.yml).
const field = (yml, key) =>
  yml
    .match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');

// Resolves to { version, page, download } for the newest release, or throws when
// GitHub cannot be read.
async function latestRelease(fetch, url = process.env.TERRA_VERSION_URL || versionUrl()) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw Error(`GitHub answered ${response.status}`);
  const yml = await response.text();
  const version = field(yml, 'version')?.replace(/^v/i, '');
  if (!version || !/^\d+(\.\d+)*/.test(version)) throw Error('GitHub has no version number');
  const file = field(yml, 'path');
  return {
    version,
    page: releasePage(version),
    download: file ? `${RELEASES_URL}/download/v${version}/${encodeURIComponent(file)}` : undefined,
  };
}

module.exports = { isNewer, latestRelease, releasePage, versionUrl, PAGE_URL };
