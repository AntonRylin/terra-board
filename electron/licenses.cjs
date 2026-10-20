const fs = require('node:fs');
const path = require('node:path');

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const licenseOf = (pkg) =>
  typeof pkg.license === 'string'
    ? pkg.license
    : pkg.license?.type || (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) || 'Unknown';
const dependenciesOf = (pkg) => Object.keys({ ...pkg?.dependencies, ...pkg?.optionalDependencies });

// Files the app ships that are not npm packages, each listed when present.
function payloadNotices(appPath, resourcesPath) {
  const unpacked = (relative) =>
    path.join(appPath, relative).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return [
    {
      file: unpacked('assets/models/u2net.onnx'),
      notice: { name: 'U-2-Net background-removal model', version: '', license: 'Apache-2.0' },
    },
    {
      file: resourcesPath && path.join(resourcesPath, 'yt-dlp', 'yt-dlp.exe'),
      notice: { name: 'yt-dlp', version: '', license: 'Unlicense' },
    },
    {
      file: unpacked('node_modules/onnxruntime-node/bin/napi-v6/win32/x64/vcruntime140.dll'),
      notice: {
        name: 'Microsoft Visual C++ Runtime',
        version: '14',
        license: 'Microsoft Software License Terms',
      },
    },
  ]
    .filter(({ file }) => file && fs.existsSync(file))
    .map(({ notice }) => notice);
}

// Everything the app ships with its declared license: the main-process
// packages in node_modules (including installed optional natives), the
// packages Vite bundled into the renderer (dist/licenses.json, written at
// build time) and the non-npm payloads.
function collectLicenses({ appPath, resourcesPath }) {
  const entries = new Map();
  const add = ({ name, version, license }) => {
    const key = `${name}@${version}`;
    if (name && !entries.has(key)) entries.set(key, { name, version, license });
  };
  const seen = new Set();
  const queue = dependenciesOf(readJson(path.join(appPath, 'package.json'))).map((name) => ({
    name,
    from: appPath,
  }));
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = [
      path.join(from, 'node_modules', name),
      path.join(appPath, 'node_modules', name),
    ].find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    add({ name: pkg.name || name, version: String(pkg.version || ''), license: licenseOf(pkg) });
    for (const dependency of dependenciesOf(pkg)) queue.push({ name: dependency, from: dir });
  }
  const bundled = readJson(path.join(appPath, 'dist', 'licenses.json'));
  for (const item of Array.isArray(bundled) ? bundled : [])
    add({
      name: String(item?.name || ''),
      version: String(item?.version || ''),
      license: String(item?.license || 'Unknown'),
    });
  for (const notice of payloadNotices(appPath, resourcesPath)) add(notice);
  return [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

module.exports = { collectLicenses, licenseOf };
