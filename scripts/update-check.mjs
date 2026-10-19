// End-to-end check of in-app updates on Windows.
//
// 1. Builds a copy of the current app with the next patch version as an update
//    feed, unless --feed names a folder that already has an installer and its
//    latest.yml (for example release/installer, to update an older installer).
// 2. Installs the installer (default: this version's) into a throwaway folder
//    with its own LOCALAPPDATA, serves the feed from localhost and opens the app.
// 3. Checks the prompt shows the new version and its release page, and that
//    Restart installs the new version and reopens the app. With --close-first it
//    instead closes the prompt and quits, which installs the update on quit.
// 4. With --source <exe>, also checks a build from source shows the prompt with a
//    Download link to the new installer.
//
// Run `npm run installer` first, and close every Terra Board window: the NSIS
// installer closes running copies of the app.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, uncacheAll } from '@electron/asar';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../', import.meta.url));
const { version } = require('../package.json');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const installer = resolve(
  option('--installer') || join(repository, 'release/installer/Terra-Board-Setup-x64.exe'),
);
const bumped = version.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
const feed = resolve(option('--feed') || join(repository, '.local-test/update-feed', bumped));
const feedField = (key) =>
  readFileSync(join(feed, 'latest.yml'), 'utf8').match(new RegExp(`^${key}: *(.+)$`, 'm'))?.[1];
const sourceExe = option('--source') && resolve(option('--source'));
assert.equal(process.platform, 'win32', 'This check runs the Windows installer.');
assert.ok(existsSync(installer), 'Run `npm run installer` first.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const powershell = (source) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
const processes = () =>
  JSON.parse(
    powershell(
      `ConvertTo-Json -Compress -InputObject @(Get-Process -Name 'Terra Board' -ErrorAction SilentlyContinue | Select-Object Id,Path,MainWindowHandle)`,
    ) || '[]',
  );
const registered = () =>
  powershell(`@(Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall |
    Get-ItemProperty | Where-Object { $_.DisplayName -match '^Terra Board(?:\\s|$)' }).Count`);
assert.equal(registered(), '0', 'Refusing to replace an existing installed Terra Board.');
assert.equal(processes().length, 0, 'Close every Terra Board window before this check.');
// NSIS caches the installer it runs under the real local app data folder.
const known = JSON.parse(
  powershell(`@{
  desktop = [Environment]::GetFolderPath('Desktop');
  local = [Environment]::GetFolderPath('LocalApplicationData')
} | ConvertTo-Json -Compress`),
);
const installerCache = join(known.local, 'terra-board-updater', 'installer.exe');
const desktopShortcut = join(known.desktop, 'Terra Board.lnk');
for (const path of [installerCache, desktopShortcut])
  assert.ok(!existsSync(path), `Refusing to overwrite an existing file: ${path}`);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

mkdirSync(join(repository, '.local-test'), { recursive: true });
const root = mkdtempSync(join(repository, '.local-test', 'update-'));
const destination = join(root, 'Installed app');
const executable = join(destination, 'Terra Board.exe');
const uninstaller = join(destination, 'Uninstall Terra Board.exe');
const local = join(root, 'LocalData');
const env = { ...process.env, LOCALAPPDATA: local };
for (const name of [
  'CANVAS_DATA_DIR',
  'CANVAS_DEV_URL',
  'ELECTRON_RUN_AS_NODE',
  'TERRA_VERSION_URL',
])
  delete env[name];
const report = { installer, feed, root, steps: [], completed: false };

function run(file, argv, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, argv, { windowsHide: true, env, ...options });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolveRun(output) : reject(Error(`${file} exited ${code}\n${output}`)),
    );
  });
}
// Null while the installer is replacing the files.
const installedVersion = () => {
  try {
    uncacheAll(); // @electron/asar otherwise keeps answering from the old archive.
    return JSON.parse(extractFile(join(destination, 'resources', 'app.asar'), 'package.json'))
      .version;
  } catch {
    return null;
  }
};
async function until(what, test, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

// The update installer electron-updater starts on quit or Restart.
const installerRunning = () =>
  powershell(`@(Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -like '*terra-board-updater*' }).Count`) !== '0';

// Close windows of one executable the normal way, so the library saves.
async function closeApp(exe) {
  powershell(`Get-Process -Name 'Terra Board' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq '${exe.replaceAll("'", "''")}' -and $_.MainWindowHandle -ne 0 } |
    ForEach-Object { $_.CloseMainWindow() | Out-Null }`);
  await until(
    'the app to close',
    () => !processes().some((p) => p.Path?.toLowerCase() === exe.toLowerCase()),
    60_000,
  );
}

// Minimal Chrome DevTools connection to the app window.
async function connect(port) {
  const target = await until('the app window', async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
    } catch {}
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      pending.set(++id, r);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const read = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
      ?.result?.value;
  const shot = async (name) => {
    const { result } = await send('Page.captureScreenshot');
    writeFileSync(join(root, name), Buffer.from(result.data, 'base64'));
  };
  return { read, shot, close: () => socket.close() };
}
const prompt = `document.querySelector('.update-prompt')?.innerText ?? ''`;
const clickButton = (start) =>
  `[...document.querySelectorAll('.update-prompt button')].find((b) => b.textContent.startsWith(${JSON.stringify(start)})).click()`;

// The default feed: the same app at the next version, built like a release.
if (!existsSync(join(feed, 'latest.yml'))) {
  await run(
    process.execPath,
    [
      join(repository, 'node_modules/electron-builder/cli.js'),
      '--config',
      'electron-builder.installer.cjs',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      `-c.extraMetadata.version=${bumped}`,
      `-c.directories.output=${feed}`,
    ],
    { cwd: repository, env: process.env },
  );
}
const next = feedField('version');
const feedFile = feedField('path');
const feedInstaller = join(feed, feedFile);
assert.ok(next && existsSync(feedInstaller), 'The feed has an installer and latest.yml.');
report.to = next;
const named = new RegExp(`Terra Board ${next.replaceAll('.', '[.]')}`);

const server = createServer((req, res) => {
  const file = join(feed, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(feed + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Length': statSync(file).size });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const feedUrl = `http://127.0.0.1:${server.address().port}/`;

let app;
try {
  await run(installer, ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${destination}`], {
    windowsVerbatimArguments: true,
  });
  report.from = installedVersion();
  assert.notEqual(report.from, next, 'The feed has the same version as the installer.');
  report.steps.push(`installed ${report.from} silently into the test folder`);

  const port = 9400 + Math.floor(Math.random() * 400);
  spawn(executable, [`--remote-debugging-port=${port}`], {
    env: { ...env, TERRA_UPDATE_FEED: feedUrl },
    detached: true,
    stdio: 'ignore',
  }).unref();
  app = await connect(port);
  const text = await until(
    'the update prompt',
    async () => {
      const t = await app.read(prompt);
      return /Ready to install|is ready/.test(t) && t;
    },
    180_000,
  );
  assert.match(text, named);
  const status = await app.read(`window.canvas.updates.status()`);
  assert.equal(status.available, next);
  await app.shot('installed-prompt.png');
  report.prompt = text;
  // Versions before 0.1.27 say "is ready" and offer Later and Restart.
  const legacy = !text.includes("What's new");
  if (legacy) report.steps.push(`downloaded ${next} and shows it (pre-0.1.27 prompt)`);
  else {
    assert.match(text, /Restart to update/);
    assert.equal(status.page, `https://github.com/AntonRylin/terra-board/releases/tag/v${next}`);
    report.steps.push(`downloaded ${next} and shows its version, What's new and Restart`);
  }

  if (args.includes('--close-first')) {
    // Close the prompt, then quit: the update installs without reopening the app.
    await app.read(
      legacy ? clickButton('Later') : `document.querySelector('.update-prompt-close').click()`,
    );
    await sleep(300);
    assert.equal(await app.read(prompt), '', 'Closing hides the prompt.');
    report.steps.push('closing hides the prompt');
    app.close();
    app = undefined;
    await closeApp(executable);
    await until('the update to install on quit', () => installedVersion() === next, 180_000);
    await until('the installer to finish', () => !installerRunning(), 180_000);
    report.steps.push(`quitting installed ${next}`);
  } else {
    await app.read(clickButton('Restart'));
    app.close();
    app = undefined;
    report.steps.push('clicked Restart');
    await until('the new version to install', () => installedVersion() === next, 180_000);
    const reopened = await until(
      'the updated app to reopen',
      () =>
        processes().find(
          (p) => p.Path?.toLowerCase() === executable.toLowerCase() && p.MainWindowHandle,
        ),
      120_000,
    );
    report.reopenedPid = reopened.Id;
    report.steps.push(`installer replaced the app with ${next} and reopened it`);
    await sleep(3_000);
    await closeApp(executable);
  }

  if (sourceExe) {
    const sourcePort = port + 1;
    spawn(sourceExe, [`--remote-debugging-port=${sourcePort}`], {
      env: {
        ...env,
        CANVAS_DATA_DIR: join(root, 'Source library'),
        TERRA_VERSION_URL: feedUrl + 'latest.yml',
      },
      detached: true,
      stdio: 'ignore',
    }).unref();
    app = await connect(sourcePort);
    const sourceText = await until('the source-build prompt', async () => {
      const t = await app.read(prompt);
      return t.includes('Download') && t;
    });
    assert.match(sourceText, named);
    const sourceStatus = await app.read(`window.canvas.updates.status()`);
    assert.equal(sourceStatus.state, 'available');
    assert.equal(
      sourceStatus.download,
      `https://github.com/AntonRylin/terra-board/releases/download/v${next}/${encodeURIComponent(feedFile)}`,
    );
    await app.shot('source-prompt.png');
    app.close();
    app = undefined;
    await closeApp(sourceExe);
    report.sourcePrompt = sourceText;
    report.steps.push('build from source shows the new version with a Download link');
  }
  report.completed = true;
  console.log('UPDATE_CHECK_OK', JSON.stringify(report));
} finally {
  app?.close();
  server.close();
  for (const exe of [executable, sourceExe].filter(Boolean)) await closeApp(exe).catch(() => {});
  // Quitting with a downloaded update installs it; let that finish first.
  await sleep(2_000);
  await until('the installer to finish', () => !installerRunning(), 180_000).catch(() => {});
  // --keep leaves the test install in place for inspection.
  if (existsSync(uninstaller) && !args.includes('--keep'))
    await run(uninstaller, ['/S', '/currentuser', `_?=${destination}`], {
      windowsVerbatimArguments: true,
    }).catch((e) => report.steps.push(`uninstall failed: ${e.message}`));
  const ours = [installer, feedInstaller].map(hash);
  if (existsSync(installerCache) && ours.includes(hash(installerCache))) {
    unlinkSync(installerCache);
    try {
      rmdirSync(dirname(installerCache));
    } catch {}
  }
  report.leftovers = [installerCache, desktopShortcut].filter(existsSync);
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
}
