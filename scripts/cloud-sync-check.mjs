// Two libraries sync through a local Supabase (`npx supabase start`).
// Runs in plain Node: the store and sync engine are used directly, without Electron.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const { CloudSync } = require('../electron/cloud-sync.cjs');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');

function localConfig() {
  if (process.env.TERRA_CLOUD_URL && process.env.TERRA_CLOUD_KEY)
    return { url: process.env.TERRA_CLOUD_URL, key: process.env.TERRA_CLOUD_KEY };
  const env = execFileSync('npx supabase status -o json', {
    encoding: 'utf8',
    shell: true,
  });
  const status = JSON.parse(env.slice(env.indexOf('{')));
  return { url: status.API_URL, key: status.ANON_KEY };
}

const config = localConfig();
const roots = [];
const devices = [];
function device(name) {
  const root = mkdtempSync(join(tmpdir(), `terra-cloud-${name}-`));
  roots.push(root);
  const store = new Store(root);
  const statuses = [];
  const sync = new CloudSync({
    call: async (command, args) => store[command](args),
    root,
    config,
    transaction: (job) => job(),
    onStatus: (s) => statuses.push(s),
  });
  const d = { name, root, store, sync, statuses };
  devices.push(d);
  return d;
}
const until = async (fn, label, timeout = 8000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw Error('Timed out waiting for ' + label);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, width: 200, height: 160, text, z: 1 });
const results = {};

try {
  const a = device('a');
  const folder = a.store.createFolder({ name: 'Work' });
  const board = a.store.createBoard({ name: 'Synced plan', folderId: folder.id });
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2a9d8f' } })
    .png()
    .toBuffer();
  const image = await a.store.importAsset({ bytes: png, name: 'teal.png' });
  a.store.patchBoard({
    id: board.id,
    revision: 0,
    upserts: [
      note('n1', 'hello from A'),
      { id: 'img', type: 'image', x: 0, y: 0, width: 16, height: 16, z: 2, assetId: image.id },
    ],
  });

  await a.sync.enable();
  await a.sync.run();
  assert.equal(a.sync.status.state, 'synced', a.sync.status.error || '');
  assert.equal(a.sync.status.pending, 0);
  results.firstUpload = true;

  const code = await a.sync.pairingCode();
  assert.match(code, /^[0-9A-F]{10}$/);
  const b = device('b');
  await b.sync.join(code.slice(0, 5) + '-' + code.slice(5).toLowerCase());
  await b.sync.run();
  const onB = b.store.loadBoard({ id: board.id });
  assert.equal(onB.board.name, 'Synced plan');
  assert.equal(onB.board.folderId, folder.id);
  assert.deepEqual(onB.objects.map((o) => o.id).sort(), ['img', 'n1']);
  assert.ok(b.store.asset({ id: image.id, variant: 'original' }));
  assert.equal(b.store.syncStatus().pending, 0, 'applied rows are not echoed back');
  results.pairingAndDownload = true;

  await assert.rejects(b.sync.join(code), /wrong or has expired/);
  results.codeSingleUse = true;

  const before = a.store.loadBoard({ id: board.id }).revision;
  b.store.patchBoard({
    id: board.id,
    revision: onB.revision,
    upserts: [note('n1', 'edited on B')],
    deleted: ['img'],
  });
  b.sync.localChanged();
  // A is subscribed: B's broadcast after pushing should make A pull on its own.
  await until(() => a.store.loadBoard({ id: board.id }).revision > before, 'realtime pull on A');
  const onA = a.store.loadBoard({ id: board.id });
  assert.deepEqual(
    onA.objects.map((o) => o.text),
    ['edited on B'],
  );
  results.realtimeTwoWay = true;

  const devicesSeen = await a.sync.devices();
  assert.equal(devicesSeen.length, 2);
  assert.equal(devicesSeen.filter((d) => d.current).length, 1);
  results.deviceList = true;

  // A stranger who never redeemed a code sees and changes nothing.
  const stranger = createClient(config.url, config.key, { auth: { persistSession: false } });
  assert.ifError((await stranger.auth.signInAnonymously()).error);
  const read = await stranger.from('entities').select('id').eq('workspace_id', a.sync.workspace);
  assert.equal(read.data.length, 0);
  const write = await stranger.rpc('push_entities', {
    p_workspace: a.sync.workspace,
    p_rows: [{ kind: 'board', id: 'x', data: {} }],
  });
  assert.match(write.error?.message || '', /cannot edit/);
  const file = await stranger.storage.from('assets').download(`${a.sync.workspace}/${image.id}`);
  assert.ok(file.error, 'stranger cannot download media');
  const code2 = await stranger.rpc('create_pairing_code', { p_workspace: a.sync.workspace });
  assert.ok(code2.error, 'stranger cannot create codes');
  results.strangerDenied = true;

  // Removing B cuts it off.
  await a.sync.removeDevice(b.sync.userId);
  b.store.updateBoard({ id: board.id, patch: { name: 'B after removal' } });
  await b.sync.run();
  assert.equal(b.sync.status.state, 'error');
  assert.match(b.sync.status.error, /cannot edit/);
  await a.sync.run();
  assert.equal(a.store.loadBoard({ id: board.id }).board.name, 'Synced plan');
  results.removedDeviceBlocked = true;

  await a.sync.disable();
  assert.equal(a.store.syncStatus().enabled, false);
  results.disable = true;

  console.log(JSON.stringify({ passed: true, ...results }));
} catch (e) {
  console.error(JSON.stringify({ passed: false, ...results }));
  throw e;
} finally {
  for (const d of devices) {
    d.sync.stop();
    d.store.close();
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
