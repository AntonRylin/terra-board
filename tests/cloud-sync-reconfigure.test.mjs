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

function setup({ identity = false, server, recorded, calls = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-reconfigure-'));
  const session = path.join(root, 'settings', 'cloud-session');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, '{"terra-cloud":"old server session"}');
  const marker = path.join(root, 'settings', 'cloud-session-server');
  if (recorded) fs.writeFileSync(marker, recorded);
  const sync = new CloudSync({
    call: async (command) => {
      calls.push(command);
      if (command === 'syncStatus')
        return { identity, library: false, name: '', pending: 0, workspace: null };
      if (command === 'syncDisable') return {};
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
  return { sync, root, session, marker, done };
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

test('a different server than the session was made for turns sync off locally', async () => {
  const calls = [];
  const { sync, session, marker, done } = setup({
    identity: true,
    recorded: second.url,
    calls,
  });
  const status = await sync.start();
  assert.ok(calls.includes('syncDisable'));
  assert.equal(fs.existsSync(session), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(status.state, 'off');
  assert.equal(status.identity, false);
  assert.match(status.error, /server for this computer changed/);
  done();
});

test('no server at all with a recorded session also turns sync off', async () => {
  const calls = [];
  const { sync, session, marker, done } = setup({ identity: true, recorded: config.url, calls });
  // The engine starts again without any server configured.
  const bare = new CloudSync({
    call: async (command) => {
      calls.push(command);
      return command === 'syncStatus'
        ? { identity: true, library: false, name: '', pending: 0, workspace: null }
        : {};
    },
    root: sync.root,
    config: null,
    transaction: (job) => job(),
  });
  const status = await bare.start();
  assert.ok(calls.includes('syncDisable'));
  assert.equal(fs.existsSync(session), false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(status.identity, false);
  done();
});

test('the same server keeps sync on, and an older install gets its marker', async () => {
  const calls = [];
  const { sync, session, marker, done } = setup({ identity: true, recorded: config.url, calls });
  sync.client.auth.getSession = async () => ({ data: { session: null } });
  const status = await sync.start();
  assert.equal(calls.includes('syncDisable'), false);
  assert.ok(fs.existsSync(session));
  assert.match(status.error, /Signed out/);
  done();

  const old = setup({ identity: true, calls: [] });
  old.sync.client.auth.getSession = async () => ({ data: { session: null } });
  assert.equal(fs.existsSync(old.marker), false);
  await old.sync.start();
  assert.equal(fs.readFileSync(old.marker, 'utf8'), config.url);
  assert.ok(fs.existsSync(old.session));
  old.done();
});

test('reconfigure forgets which server the session was for', async () => {
  const { sync, marker, done } = setup({ recorded: config.url });
  await sync.reconfigure(second, null);
  assert.equal(fs.existsSync(marker), false);
  done();
});
