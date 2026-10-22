import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNewer, latestRelease, versionUrl } = require('../electron/version-check.cjs');
const { createAppUpdater, installsUpdates } = require('../electron/app-updater.cjs');

const latestYml = (version, file = `Terra-Board-Setup-${version}-x64.exe`) =>
  `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: abc\n    size: 1\npath: ${file}\nsha512: abc\nreleaseDate: '2026-10-19T12:00:00.000Z'\n`;
const respond =
  (body, status = 200) =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const app = (version) => ({ getVersion: () => version });
const fromSource = (version, fetch) =>
  createAppUpdater({ app: app(version), enabled: false, notify: true, fetch, onStatus() {} });

test('compares versions by number, not text', () => {
  assert.equal(isNewer('0.1.25', '0.1.24'), true);
  assert.equal(isNewer('0.1.100', '0.1.24'), true);
  assert.equal(isNewer('0.2', '0.1.24'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.24', '0.1.24'), false);
  assert.equal(isNewer('0.1.23', '0.1.24'), false);
  assert.equal(isNewer('0.1.24-beta.1', '0.1.24'), false);
});

test('reads the newest release and its installer from latest.yml', async () => {
  assert.deepEqual(await latestRelease(respond(latestYml('0.2.0'))), {
    version: '0.2.0',
    page: 'https://github.com/AntonRylin/terra-board/releases/tag/v0.2.0',
    download:
      'https://github.com/AntonRylin/terra-board/releases/download/v0.2.0/Terra-Board-Setup-0.2.0-x64.exe',
  });
  await assert.rejects(latestRelease(respond('', 404)), /404/);
  await assert.rejects(latestRelease(respond('files: []\n')), /no version/);
});

test('a build from source reports a newer release with its page and installer', async () => {
  const seen = [];
  const updater = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: true,
    fetch: respond(latestYml('0.1.25')),
    onStatus: (status) => seen.push(status.state),
  });
  updater.check();
  await settle();
  updater.stop();
  const status = updater.status();
  assert.deepEqual(seen, ['checking', 'available']);
  assert.equal(status.latest, '0.1.25');
  assert.equal(status.supported, false);
  assert.equal(status.page, 'https://github.com/AntonRylin/terra-board/releases/tag/v0.1.25');
  assert.match(
    status.download,
    /releases\/download\/v0\.1\.25\/Terra-Board-Setup-0\.1\.25-x64\.exe$/,
  );
  assert.equal(updater.install(), false);
});

test('an up-to-date build or an unreachable GitHub shows no newer version', async () => {
  const current = fromSource('0.1.25', respond(latestYml('0.1.25')));
  const offline = fromSource('0.1.24', async () => {
    throw Error('offline');
  });
  current.check();
  offline.check();
  await settle();
  current.stop();
  offline.stop();
  assert.equal(current.status().state, 'current');
  assert.equal(current.status().latest, undefined);
  assert.equal(offline.status().state, 'error');
  assert.equal(offline.status().latest, undefined);
});

test('automatic checks can be turned off; checking by hand still works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const updater = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: true,
    automatic: false,
    fetch: async () => {
      calls++;
      return respond(latestYml('0.1.24'))();
    },
    onStatus() {},
  });
  t.mock.timers.tick(5 * 60 * 60 * 1000);
  await settle();
  assert.equal(calls, 0);
  assert.equal(updater.status().automatic, false);
  updater.check();
  await settle();
  assert.equal(calls, 1);
  updater.setAutomatic(true);
  assert.equal(updater.status().automatic, true);
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(calls, 2);
  updater.setAutomatic(false);
  t.mock.timers.tick(5 * 60 * 60 * 1000);
  await settle();
  assert.equal(calls, 2);
  updater.stop();
});

test('development and smoke-test runs do not check', async () => {
  let calls = 0;
  const updater = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: false,
    fetch: async () => {
      calls++;
      return respond(latestYml('9.0.0'))();
    },
    onStatus() {},
  });
  updater.check();
  await settle();
  assert.equal(calls, 0);
  assert.equal(updater.status().state, 'idle');
});

test('each system reads its own update file; only the installer and the AppImage update themselves', () => {
  assert.equal(
    versionUrl('win32'),
    'https://github.com/AntonRylin/terra-board/releases/latest/download/latest.yml',
  );
  assert.equal(
    versionUrl('linux'),
    'https://github.com/AntonRylin/terra-board/releases/latest/download/latest-linux.yml',
  );
  assert.equal(installsUpdates('win32', {}), true);
  assert.equal(
    installsUpdates('linux', { APPIMAGE: '/home/anna/Apps/Terra-Board.AppImage' }),
    true,
  );
  // A .deb install is updated through the system's package tools.
  assert.equal(installsUpdates('linux', {}), false);
  assert.equal(installsUpdates('darwin', {}), false);
});
