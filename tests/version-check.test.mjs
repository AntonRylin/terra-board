import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNewer, latestVersion } = require('../electron/version-check.cjs');
const { createAppUpdater } = require('../electron/app-updater.cjs');

const respond =
  (body, status = 200) =>
  async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const app = (version) => ({ getVersion: () => version });

test('compares versions by number, not text', () => {
  assert.equal(isNewer('0.1.25', '0.1.24'), true);
  assert.equal(isNewer('0.1.100', '0.1.24'), true);
  assert.equal(isNewer('0.2', '0.1.24'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.24', '0.1.24'), false);
  assert.equal(isNewer('0.1.23', '0.1.24'), false);
  assert.equal(isNewer('0.1.24-beta.1', '0.1.24'), false);
});

test('reads the version from package.json on GitHub', async () => {
  assert.equal(await latestVersion(respond({ version: ' v0.2.0 ' })), '0.2.0');
  await assert.rejects(latestVersion(respond({}, 404)), /404/);
  await assert.rejects(latestVersion(respond({ name: 'terra-board' })), /no version/);
});

test('a build from source reports a newer GitHub version at launch', async () => {
  const seen = [];
  const updater = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: true,
    fetch: respond({ version: '0.1.25' }),
    onStatus: (status) => seen.push(status.state),
  });
  await settle();
  updater.stop();
  const status = updater.status();
  assert.deepEqual(seen, ['checking', 'available']);
  assert.equal(status.latest, '0.1.25');
  assert.equal(status.supported, false);
  assert.match(status.page, /github\.com\/AntonRylin\/terra-board/);
  assert.equal(updater.install(), false);
});

test('an up-to-date build or an unreachable GitHub shows no newer version', async () => {
  const current = createAppUpdater({
    app: app('0.1.25'),
    enabled: false,
    notify: true,
    fetch: respond({ version: '0.1.25' }),
    onStatus() {},
  });
  const offline = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: true,
    fetch: async () => {
      throw Error('offline');
    },
    onStatus() {},
  });
  await settle();
  current.stop();
  offline.stop();
  assert.equal(current.status().state, 'current');
  assert.equal(current.status().latest, undefined);
  assert.equal(offline.status().state, 'error');
  assert.equal(offline.status().latest, undefined);
});

test('development and smoke-test runs do not check', async () => {
  let calls = 0;
  const updater = createAppUpdater({
    app: app('0.1.24'),
    enabled: false,
    notify: false,
    fetch: async () => {
      calls++;
      return respond({ version: '9.0.0' })();
    },
    onStatus() {},
  });
  updater.check();
  await settle();
  assert.equal(calls, 0);
  assert.equal(updater.status().state, 'idle');
});
