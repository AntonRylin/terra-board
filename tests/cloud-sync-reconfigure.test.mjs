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

function setup({
  identity = false,
  server,
  recorded,
  calls = [],
  using = config,
  legacyServerUrl,
  saved = '{"terra-cloud":"old server session"}',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-reconfigure-'));
  const session = path.join(root, 'settings', 'cloud-session');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, saved);
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
    config: using,
    server,
    legacyServerUrl,
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

// A real-looking session that has expired, so a client given it would refresh it at once.
const expiredSession = JSON.stringify({
  'terra-cloud': JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    user: { id: '00000000-0000-0000-0000-000000000001', aud: 'authenticated' },
  }),
});

// Any request the client makes fails the test: none may go out with the old session.
async function withoutNetwork(job) {
  const real = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw Error('no request may be sent');
  };
  try {
    await job();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(requests, []);
}

test('a session saved for another server is deleted before any client sees it', async () => {
  await withoutNetwork(async () => {
    const calls = [];
    const { sync, session, marker, done } = setup({
      identity: true,
      recorded: second.url,
      saved: expiredSession,
      calls,
    });
    try {
      assert.equal(fs.existsSync(session), false);
      assert.equal(fs.readFileSync(marker, 'utf8'), second.url);
      const before = sync.client;
      const status = await sync.start();
      assert.ok(calls.includes('syncDisable'));
      assert.equal(status.state, 'off');
      assert.equal(status.error, 'The server for this computer changed, so sync was turned off.');
      assert.ok(sync.client && sync.client !== before);
    } finally {
      done();
    }
  });
});

test('a session from before the marker belongs to the server the app used then', async () => {
  await withoutNetwork(async () => {
    const calls = [];
    const { sync, session, marker, done } = setup({
      identity: true,
      legacyServerUrl: second.url,
      saved: expiredSession,
      calls,
    });
    try {
      assert.equal(fs.existsSync(session), false);
      assert.equal(fs.readFileSync(marker, 'utf8'), second.url);
      const status = await sync.start();
      assert.ok(calls.includes('syncDisable'));
      assert.match(status.error, /server for this computer changed/);
    } finally {
      done();
    }
  });
});

test('a session for the same server is kept', () => {
  const recorded = setup({ recorded: config.url, legacyServerUrl: second.url });
  assert.ok(fs.existsSync(recorded.session));
  recorded.done();
  const legacy = setup({ legacyServerUrl: config.url });
  assert.ok(fs.existsSync(legacy.session));
  assert.equal(fs.existsSync(legacy.marker), false);
  legacy.done();
  const unknown = setup();
  assert.ok(fs.existsSync(unknown.session));
  unknown.done();
});

test('disable drops the session even when signing out fails', async () => {
  const { sync, session, marker, done } = setup({ identity: true, recorded: config.url });
  try {
    sync.workspace = 'workspace';
    sync.userId = 'user';
    sync.client.rpc = async () => ({ data: null, error: null });
    sync.client.auth.signOut = async () => {
      throw Error('offline');
    };
    const before = sync.client;
    const status = await sync.disable();
    assert.equal(fs.existsSync(session), false);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(status.state, 'off');
    assert.ok(sync.client && sync.client !== before);
  } finally {
    done();
  }
});

// A round that is still running: it ends when release() is called, and asks for another.
function runningRound(sync) {
  let release;
  sync.running = new Promise((resolve) => (release = resolve)).then(() => {
    sync.running = null;
    sync.timer = setTimeout(() => assert.fail('a round started after sync stopped'), 0);
  });
  return () => release();
}

test('disable and reconfigure wait for a sync round in progress', async () => {
  const calls = [];
  const off = setup({ identity: true, recorded: config.url, calls });
  try {
    const release = runningRound(off.sync);
    const disabling = off.sync.disable();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.includes('syncDisable'), false);
    assert.ok(fs.existsSync(off.session));
    release();
    await disabling;
    assert.ok(calls.includes('syncDisable'));
    assert.equal(off.sync.timer, null);
  } finally {
    off.done();
  }

  const moving = setup();
  try {
    const release = runningRound(moving.sync);
    const switching = moving.sync.reconfigure(second, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(moving.session));
    assert.equal(moving.sync.config, config);
    release();
    await switching;
    assert.equal(fs.existsSync(moving.session), false);
    assert.equal(moving.sync.config, second);
    assert.equal(moving.sync.timer, null);
  } finally {
    moving.done();
  }
});
