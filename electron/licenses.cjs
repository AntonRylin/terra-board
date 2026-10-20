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

// Every package reachable from `queue` ({ name, from }) through dependencies,
// resolved from <from>/node_modules and then <base>/node_modules.
function packageTree(queue, base, { optional }) {
  const found = [];
  const seen = new Set();
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = [path.join(from, 'node_modules', name), path.join(base, 'node_modules', name)].find(
      (candidate) => fs.existsSync(path.join(candidate, 'package.json')),
    );
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    found.push({
      name: pkg.name || name,
      version: String(pkg.version || ''),
      license: licenseOf(pkg),
    });
    const next = optional ? dependenciesOf(pkg) : Object.keys(pkg.dependencies || {});
    for (const dependency of next) queue.push({ name: dependency, from: dir });
  }
  return found;
}
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const unique = (list) => [...new Map(list.map((e) => [`${e.name}@${e.version}`, e])).values()];

// The packages behind the renderer bundle's module IDs, and their dependencies:
// a prebuilt file (jszip's dist, with lie and immediate inside) holds packages
// that never appear as modules of their own. Used by vite.config.ts.
function bundledPackages(moduleIds, base) {
  const queue = [];
  for (const id of moduleIds) {
    const file = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
    const at = file.lastIndexOf('/node_modules/');
    if (at < 0) continue;
    const rest = file.slice(at + '/node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
    queue.push({ name, from: file.slice(0, at) });
  }
  return unique(packageTree(queue, base, { optional: false })).sort(byName);
}

// Everything the app ships with its declared license: the main-process
// packages in node_modules (including installed optional natives), the
// packages Vite bundled into the renderer (dist/licenses.json, written at
// build time) and the non-npm payloads.
function collectLicenses({ appPath, resourcesPath }) {
  const main = dependenciesOf(readJson(path.join(appPath, 'package.json'))).map((name) => ({
    name,
    from: appPath,
  }));
  const bundled = readJson(path.join(appPath, 'dist', 'licenses.json'));
  const renderer = (Array.isArray(bundled) ? bundled : []).map((item) => ({
    name: String(item?.name || ''),
    version: String(item?.version || ''),
    license: String(item?.license || 'Unknown'),
  }));
  return unique([
    ...packageTree(main, appPath, { optional: true }),
    ...renderer,
    ...payloadNotices(appPath, resourcesPath),
  ])
    .filter((entry) => entry.name)
    .sort(byName);
}

module.exports = { collectLicenses, bundledPackages, licenseOf };
