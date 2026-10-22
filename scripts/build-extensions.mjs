// Builds the downloadable extensions into release/extensions and writes the
// catalog the app embeds (electron/generated/extensions.json): every file's
// name, address, size and SHA-256. Repository builds install straight from
// release/extensions; installed builds download from the addresses, so a
// release must upload the onnxruntime zip (docs/development.md).
// --allow-missing skips an extension whose inputs are missing (npm run dev).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative } from 'node:path';
import { zipSync } from 'fflate';
import { u2net, ytDlp } from './payloads.mjs';

const require = createRequire(import.meta.url);
const {
  VERSION: libreOfficeVersion,
  LINUX_OFFICE_HINT,
} = require('../electron/office-converter.cjs');
const allowMissing = process.argv.includes('--allow-missing');
const out = 'release/extensions';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const releaseUrl = (name) =>
  `https://github.com/AntonRylin/terra-board/releases/download/v${version}/${name}`;
const manifest = (id) => JSON.parse(readFileSync(`extensions/${id}/manifest.json`, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(out, { recursive: true });

// Writes a payload into release/extensions unless an identical one is there.
function place(name, bytes) {
  const target = join(out, name);
  const hash = sha256(bytes);
  if (!existsSync(target) || sha256(readFileSync(target)) !== hash) writeFileSync(target, bytes);
  return { name, sha256: hash, size: bytes.length };
}
function missing(what) {
  if (!allowMissing)
    throw Error(`${what} is missing. Run npm run build and prepare-vc-runtime first.`);
  console.warn(`Skipping: ${what} is missing.`);
  return null;
}
const filesIn = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)],
  );

// The extensions are built for the system this runs on: Linux x64 on Linux (in
// GitHub Actions; see .github/workflows/linux.yml), Windows x64 otherwise.
const linux = process.platform === 'linux';

function backgroundRemoval() {
  if (!existsSync(u2net.file)) return missing(u2net.file);
  const model = readFileSync(u2net.file);
  if (sha256(model) !== u2net.sha256) throw Error(`${u2net.file} does not match its checksum.`);
  const vcRuntime = 'build/vc-runtime';
  if (!linux && !existsSync(vcRuntime)) return missing(vcRuntime);
  // onnxruntime for Windows x64, laid out as node_modules so that
  // require('onnxruntime-common') resolves, with the Visual C++ runtime next to
  // onnxruntime.dll (Windows doesn't ship it). DirectML isn't used.
  // On Linux: the x64 library and binding, which find each other by $ORIGIN.
  const node = 'node_modules/onnxruntime-node';
  const common = 'node_modules/onnxruntime-common';
  const binary = linux ? 'bin/napi-v6/linux/x64' : 'bin/napi-v6/win32/x64';
  const runtime = (file) => !/\.(map|d\.ts|d\.cts|d\.mts)$/.test(file);
  const entries = [
    ...[`${node}/package.json`, `${node}/LICENSE`].filter(existsSync),
    ...filesIn(`${node}/dist`).filter(runtime),
    `${node}/${binary}/${linux ? 'libonnxruntime.so.1' : 'onnxruntime.dll'}`,
    `${node}/${binary}/onnxruntime_binding.node`,
    ...[`${common}/package.json`, `${common}/LICENSE`].filter(existsSync),
    ...filesIn(`${common}/dist/cjs`).filter(runtime),
  ].map((file) => [relative('.', file).split('\\').join(posix.sep), file]);
  if (!linux)
    for (const dll of readdirSync(vcRuntime).filter((f) => f.endsWith('.dll')))
      entries.push([`${node}/${binary}/${dll}`, join(vcRuntime, dll)]);
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  const contents = Object.fromEntries(entries.map(([name, file]) => [name, readFileSync(file)]));
  // A fixed date and order give the same zip, and so the same name, every build.
  const zip = Buffer.from(zipSync(contents, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }));
  const { version: ortVersion } = JSON.parse(readFileSync(`${node}/package.json`, 'utf8'));
  const name = `onnxruntime-${ortVersion}-${linux ? 'linux' : 'win32'}-x64-${sha256(zip).slice(0, 8)}.zip`;
  for (const old of readdirSync(out).filter((f) => /^onnxruntime-.*\.zip$/.test(f) && f !== name))
    rmSync(join(out, old));
  const files = [
    { ...place('u2net.onnx', model), url: u2net.url },
    { ...place(name, zip), url: releaseUrl(name), unzip: true },
  ];
  return {
    ...manifest('background-removal'),
    version: `onnxruntime ${ortVersion}, U-2-Net`,
    files,
    downloadSize: files.reduce((sum, f) => sum + f.size, 0),
    installedSize: model.length + Object.values(contents).reduce((sum, f) => sum + f.length, 0),
  };
}

function songLinks() {
  if (!existsSync(ytDlp.file)) return missing(ytDlp.file);
  const exe = readFileSync(ytDlp.file);
  if (sha256(exe) !== ytDlp.sha256) throw Error(`${ytDlp.file} does not match its checksum.`);
  const file = {
    ...place(ytDlp.name, exe),
    url: ytDlp.url,
    ...(ytDlp.executable && { executable: true }),
  };
  return {
    ...manifest('song-links'),
    version: `yt-dlp ${ytDlp.version}`,
    files: [file],
    downloadSize: file.size,
    installedSize: file.size,
  };
}

// LibreOffice comes from The Document Foundation; office-converter.cjs
// downloads, verifies and extracts it (about 356 MB to download).
// On Linux there is no download: the app uses the system's LibreOffice and
// shows this entry as installed when there is one (officeLocation).
const officeFiles = () =>
  linux
    ? {
        ...manifest('office-files'),
        version: 'LibreOffice (system)',
        installer: 'libreoffice',
        downloadSize: 0,
        unavailable: LINUX_OFFICE_HINT,
      }
    : {
        ...manifest('office-files'),
        version: `LibreOffice ${libreOfficeVersion}`,
        installer: 'libreoffice',
        downloadSize: 356 * 1024 * 1024,
      };

const extensions = [backgroundRemoval(), songLinks(), officeFiles()].filter(Boolean);
mkdirSync('electron/generated', { recursive: true });
writeFileSync('electron/generated/extensions.json', JSON.stringify({ extensions }, null, 2) + '\n');
for (const e of extensions)
  console.log(
    `${e.id}: ${(e.files || []).map((f) => `${f.name} ${(f.size / 1048576).toFixed(1)} MB`).join(', ') || e.installer}`,
  );
console.log(`Wrote electron/generated/extensions.json (${extensions.length} extensions).`);
