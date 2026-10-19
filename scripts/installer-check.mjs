import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const repository = fileURLToPath(new URL('../', import.meta.url));
const { version } = require('../package.json');
const installer = resolve(
  process.argv[2] || join(repository, 'release/installer', 'Terra-Board-Setup-x64.exe'),
);
assert.equal(process.platform, 'win32', 'This check runs the Windows installer.');
assert.ok(existsSync(installer), 'Build the installer first.');

function powershell(source) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
function registrations() {
  const entries = JSON.parse(
    powershell(`
    $roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
    $entries = foreach ($root in $roots) {
      Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match '^Terra Board(?:\\s|$)' } | Select-Object InstallLocation,UninstallString,PSPath
    }; ConvertTo-Json -InputObject @($entries) -Compress
  `),
  );
  return entries.map((entry) => ({
    ...entry,
    InstallLocation:
      entry.InstallLocation ||
      (entry.UninstallString?.match(/^"([^"]+)"/)?.[1]
        ? dirname(entry.UninstallString.match(/^"([^"]+)"/)[1])
        : null),
  }));
}
const known = JSON.parse(
  powershell(`@{
  desktop = [Environment]::GetFolderPath('Desktop');
  programs = [Environment]::GetFolderPath('Programs');
  local = [Environment]::GetFolderPath('LocalApplicationData')
} | ConvertTo-Json -Compress`),
);
assert.equal(registrations().length, 0, 'Refusing to replace an existing installed Terra Board.');
assert.equal(
  powershell(`@(Get-Process -Name 'Terra Board' -ErrorAction SilentlyContinue).Count`),
  '0',
  'Close Terra Board normally before running this installer test.',
);
const startShortcut = join(known.programs, 'Terra Board.lnk');
const desktopShortcut = join(known.desktop, 'Terra Board.lnk');
const installerCache = join(known.local, 'terra-board-updater', 'installer.exe');
for (const path of [startShortcut, desktopShortcut, installerCache])
  assert.ok(!existsSync(path), `Refusing to overwrite an existing file: ${path}`);

mkdirSync(join(repository, '.local-test'), { recursive: true });
const root = mkdtempSync(join(repository, '.local-test', 'installer-'));
const destination = join(root, 'Installed app');
const executable = join(destination, 'Terra Board.exe');
const uninstaller = join(destination, 'Uninstall Terra Board.exe');
const local = join(root, 'LocalData');
const library = join(local, 'Terra Board', 'Library');
const env = { ...process.env, LOCALAPPDATA: local };
delete env.CANVAS_DATA_DIR;
delete env.CANVAS_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;
const report = { installer, root, steps: [], completed: false };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const installerHash = hash(readFileSync(installer));

function run(file, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { windowsHide: true, env, ...options });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun(output) : reject(Error(`${file} exited ${code}\n${output}`)),
    );
  });
}
async function smoke(extraEnv = {}) {
  const output = await run(executable, ['--smoke-test'], { env: { ...env, ...extraEnv } });
  writeFileSync(join(root, `smoke-${report.steps.length}.log`), output);
  const match = output.match(/DESKTOP_SMOKE (\{[^\r\n]+\})/);
  assert.ok(match, output);
  const result = JSON.parse(match[1]);
  assert.equal(result.dataDirectory, extraEnv.CANVAS_DATA_DIR || library);
  for (const key of ['userData', 'sessionData', 'logs', 'crashDumps', 'temp'])
    assert.ok(result[key].startsWith(result.dataDirectory + sep), key);
  return result;
}
async function uninstall() {
  const entry = registrations();
  if (!entry.length) return;
  assert.equal(entry.length, 1);
  assert.equal(resolve(entry[0].InstallLocation).toLowerCase(), destination.toLowerCase());
  assert.ok(
    resolve(uninstaller).startsWith(resolve(root) + sep),
    'Uninstall target is inside the test workspace.',
  );
  assert.ok(existsSync(uninstaller));
  await run(uninstaller, ['/S', '/currentuser', `_?=${destination}`], {
    windowsVerbatimArguments: true,
  });
  assert.equal(registrations().length, 0, 'Uninstall entry removed.');
  assert.ok(!existsSync(executable), 'Installed application removed.');
}

try {
  await run(installer, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${destination}`], {
    windowsVerbatimArguments: true,
  });
  assert.ok(existsSync(executable));
  assert.equal(registrations()[0]?.InstallLocation.toLowerCase(), destination.toLowerCase());
  assert.ok(existsSync(startShortcut), 'Start menu shortcut installed.');
  const archive = join(destination, 'resources', 'app.asar');
  const manifest = JSON.parse(extractFile(archive, 'package.json'));
  assert.equal(manifest.terraDistribution, 'installed');
  assert.equal(manifest.version, version);
  assert.ok(
    !listPackage(archive).some((path) =>
      /(^|[\\/])(Library|\.local-test)([\\/]|$)|\.(sqlite|canvas)$/.test(path),
    ),
    'No personal library files in app payload.',
  );
  for (const file of ['electron/main.cjs', 'electron/storage-paths.cjs', 'dist/index.html'])
    assert.deepEqual(
      extractFile(archive, file.replaceAll('/', sep)),
      readFileSync(join(repository, file)),
      file,
    );
  report.steps.push(
    'silent install, custom directory, Start menu shortcut, current build and private-data exclusion',
  );
  report.initialStartup = await smoke();
  report.steps.push(
    'installed app starts with its default per-user library and local runtime folders',
  );
  const store = new Store(library);
  const board = store.createBoard({ name: 'Installer persistence check' });
  store.close();
  await run(installer, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${destination}`], {
    windowsVerbatimArguments: true,
  });
  report.reinstalledStartup = await smoke();
  const reopened = new Store(library);
  assert.equal(reopened.board(board.id).name, 'Installer persistence check');
  reopened.close();
  report.steps.push('reinstall starts successfully and preserves a saved board');
  report.overrideStartup = await smoke({ CANVAS_DATA_DIR: join(root, 'Override library') });
  report.steps.push('explicit library override remains isolated');
  await uninstall();
  const retained = new Store(library);
  assert.equal(retained.board(board.id).name, 'Installer persistence check');
  retained.close();
  assert.ok(!existsSync(startShortcut), 'Start menu shortcut removed.');
  assert.ok(!existsSync(desktopShortcut), 'No test desktop shortcut remains.');
  report.steps.push('uninstall removes app and shortcuts while preserving saved boards');
  report.completed = true;
  console.log('INSTALLER_CHECK_OK', JSON.stringify(report));
} finally {
  await uninstall();
  // NSIS caches this installer outside the test folder; remove only this exact new file.
  if (existsSync(installerCache) && hash(readFileSync(installerCache)) === installerHash) {
    unlinkSync(installerCache);
    try {
      rmdirSync(dirname(installerCache));
    } catch {}
  }
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
}
