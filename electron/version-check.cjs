// Reads the version in package.json on the repository's default branch, so every
// packaged build, installed or built from source, learns when a newer one exists.
// Raise "version" in package.json and push to announce a new version.
const VERSION_URL = 'https://raw.githubusercontent.com/AntonRylin/terra-board/HEAD/package.json';
const PAGE_URL = 'https://github.com/AntonRylin/terra-board';

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

// Resolves to the published version, or throws when GitHub cannot be read.
async function latestVersion(fetch, url = process.env.TERRA_VERSION_URL || VERSION_URL) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw Error(`GitHub answered ${response.status}`);
  const { version } = await response.json();
  if (typeof version !== 'string' || !/^v?\d+(\.\d+)*/.test(version.trim()))
    throw Error('GitHub has no version number');
  return version.trim().replace(/^v/i, '');
}

module.exports = { isNewer, latestVersion, PAGE_URL };
