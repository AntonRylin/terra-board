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
const until = async (fn, label, timeout = 40000) => {
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

  // --- Sharing a folder between two people --------------------------------
  const owner = device('owner');
  const withSam = owner.store.createFolder({ name: 'With Sam' });
  const plan = owner.store.createBoard({ name: 'Plan', folderId: withSam.id });
  const planImage = await owner.store.importAsset({
    bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#e76f51' } })
      .png()
      .toBuffer(),
    name: 'orange.png',
  });
  owner.store.patchBoard({
    id: plan.id,
    revision: 0,
    upserts: [
      note('p1', 'shared note'),
      { id: 'pimg', type: 'image', x: 0, y: 0, width: 8, height: 8, z: 2, assetId: planImage.id },
    ],
  });
  const diary = owner.store.createBoard({ name: 'Diary' });
  owner.store.patchBoard({ id: diary.id, revision: 0, upserts: [note('d1', 'private')] });
  const invite = await owner.sync.invite('folder', withSam.id, 'edit', 'Anton');
  assert.match(invite, /^S[0-9A-F]{9}$/);
  assert.equal(owner.store.syncStatus().library, false, 'sharing does not upload the library');
  results.inviteCreated = true;

  const friend = device('friend');
  await friend.sync.join(invite.slice(0, 5) + '-' + invite.slice(5), 'Sam');
  const friendBoards = () =>
    friend.store
      .library()
      .boards.map((b) => b.name)
      .sort();
  assert.deepEqual(
    friendBoards().filter((n) => ['Plan', 'Diary'].includes(n)),
    ['Plan'],
  );
  assert.equal(friend.store.library().sharing.boards[plan.id].shared, 'edit');
  assert.equal(friend.store.library().sharing.folders[withSam.id].owner, 'Anton');
  assert.ok(friend.store.asset({ id: planImage.id, variant: 'original' }), 'shared image arrives');
  assert.equal(friend.sync.status.sharedWithMe[0].owner, 'Anton');
  await assert.rejects(friend.sync.join(invite, 'Sam'), /wrong or has expired/);
  results.friendJoinedFolder = true;

  const peek = await friend.sync.client
    .from('entities')
    .select('id')
    .eq('workspace_id', owner.sync.workspace)
    .eq('board_id', diary.id);
  assert.equal(peek.data.length, 0, 'private boards stay private');
  results.privateBoardHidden = true;

  // The friend edits; the owner sees it live.
  const planRevision = friend.store.loadBoard({ id: plan.id }).revision;
  friend.store.patchBoard({
    id: plan.id,
    revision: planRevision,
    upserts: [note('p1', 'edited by Sam')],
  });
  friend.sync.localChanged();
  await until(
    () =>
      owner.store.loadBoard({ id: plan.id }).objects.find((o) => o.id === 'p1')?.text ===
      'edited by Sam',
    'owner receiving the friend edit',
  );
  results.friendEditReachesOwner = true;

  // Moving a board into the shared folder shares it; moving it out unshares it.
  owner.store.updateBoard({ id: diary.id, patch: { folderId: withSam.id } });
  owner.sync.localChanged();
  await until(() => friendBoards().includes('Diary'), 'friend receiving the moved board', 15000);
  assert.equal(
    friend.store.loadBoard({ id: diary.id }).objects[0].text,
    'private',
    'its content comes along',
  );
  owner.store.updateBoard({ id: diary.id, patch: { folderId: null } });
  owner.sync.localChanged();
  await until(() => !friendBoards().includes('Diary'), 'friend losing the moved-out board', 15000);
  results.folderMembershipFollowsMoves = true;

  // Owner sees who has access and turns Sam into a viewer.
  const access = await owner.sync.sharePeople('folder', withSam.id);
  assert.deepEqual(
    access.people.map((p) => [p.name, p.role]),
    [['Sam', 'edit']],
  );
  await owner.sync.setPersonRole(access.shareId, access.people[0].id, 'view');
  await friend.sync.run();
  assert.equal(friend.store.library().sharing.boards[plan.id].shared, 'view');
  const forced = await friend.sync.client.rpc('push_entities', {
    p_workspace: owner.sync.workspace,
    p_rows: [{ kind: 'object', board_id: plan.id, id: 'p1', data: note('p1', 'sneaky') }],
  });
  assert.match(forced.error?.message || '', /cannot edit/, 'viewers cannot write');
  results.roleChangeEnforced = true;

  // Removing Sam takes the shared copies away.
  await owner.sync.removePerson(access.shareId, access.people[0].id);
  await friend.sync.run();
  assert.ok(!friendBoards().includes('Plan'), 'revoked boards disappear');
  assert.equal(friend.sync.status.sharedWithMe.length, 0);
  results.revokeRemovesCopies = true;

  await owner.sync.stopSharing(access.shareId);
  assert.equal(owner.sync.status.shared.length, 0);
  results.stopSharing = true;

  console.log(JSON.stringify({ passed: true, ...results }));
} catch (e) {
  console.error(JSON.stringify({ passed: false, ...results }));
  for (const d of devices)
    console.error(
      d.name,
      JSON.stringify({
        state: d.sync.status.state,
        error: d.sync.status.error,
        local: d.store.syncStatus(),
      }),
    );
  throw e;
} finally {
  for (const d of devices) {
    d.sync.stop();
    d.store.close();
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
