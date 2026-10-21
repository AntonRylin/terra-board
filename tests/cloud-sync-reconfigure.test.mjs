import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CloudSync } = require('../electron/cloud-sync.cjs');

const config = { url: 'http://127.0.0.1:1', key: 'sb_publishable_' + 'x'.repeat(20) };
const second = {
  kind: 'dev',
  name: 'Second',
  url: 'http://127.0.0.1:2',
  key: config.key,
  address: null,
  signIn: { email: true, google: false, microsoft: false },
};

function setup({ identity = false, server } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-reconfigure-'));
  const session = path.join(root, 'settings', 'cloud-session');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, '{"terra-cloud":"old server session"}');
  const sync = new CloudSync({
    call: async (command) => {
      if (command === 'syncStatus')
        return { identity, library: false, name: '', pending: 0, workspace: null };
      throw Error('unexpected call ' + command);
    },
    root,
    config,
    server,
    transaction: (job) => job(),
  });
  const done = () => {
    sync.stop();
    sync.client?.auth.stopAutoRefresh();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { sync, root, session, done };
}

test('the constructor shows the server it was given', () => {
  const server = { name: 'Terra Cloud', kind: 'default', locked: false, address: null };
  const { sync, done } = setup({ server });
  assert.deepEqual(sync.status.server, server);
  done();
  const plain = setup();
  assert.equal(plain.sync.status.server, null);
  plain.done();
});

test('reconfigure refuses while sync is on and keeps the session', async () => {
  const { sync, session, done } = setup({ identity: true });
  await assert.rejects(sync.reconfigure(second, { name: 'Second' }), /Turn off sync/);
  assert.ok(fs.existsSync(session));
  assert.equal(sync.status.server, null);
  done();
});

test('reconfigure drops the old session and shows the new server', async () => {
  const { sync, session, done } = setup();
  const before = sync.client;
  const server = { name: 'Second', kind: 'dev', locked: false, address: null };
  const status = await sync.reconfigure(second, server);
  assert.equal(fs.existsSync(session), false);
  assert.equal(status.server, server);
  assert.equal(sync.status.server, server);
  assert.equal(status.configured, true);
  assert.equal(status.state, 'off');
  assert.equal(status.error, null);
  assert.ok(sync.client && sync.client !== before);
  assert.equal(sync.config, second);
  done();
});

test('reconfigure to nothing leaves no client', async () => {
  const { sync, session, done } = setup();
  const status = await sync.reconfigure(null, null);
  assert.equal(fs.existsSync(session), false);
  assert.equal(status.configured, false);
  assert.equal(status.server, null);
  assert.ok(!sync.client);
  assert.equal((await sync.start()).state, 'off');
  done();
});
