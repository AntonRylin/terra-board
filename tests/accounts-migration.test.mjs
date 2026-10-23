// The accounts migration in PGlite: claiming 0.1.28 computers, combining libraries,
// devices, and deleting cloud data. See tests/supabase-db.mjs for the Supabase stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { supabaseDb } from './supabase-db.mjs';

const board = (id, extra = {}) => ({
  kind: 'board',
  board_id: '',
  id,
  data: { name: id, folderId: null, ...extra },
});
const object = (boardId, id) => ({ kind: 'object', board_id: boardId, id, data: { text: id } });

// A 0.1.28 computer: anonymous, with its own workspace holding one board.
async function anonymousLibrary(server, boardId = 'b1') {
  const computer = await server.user({ anonymous: true });
  const workspace = await computer.rpc('create_workspace', { p_name: 'My boards', p_device: 'PC' });
  await computer.rpc('set_display_name', { p_workspace: workspace, p_name: 'Anton' });
  await computer.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board(boardId), object(boardId, 'n1')]),
  });
  return { computer, workspace };
}

// Someone else, with their own workspace, who gets a board shared with them.
async function guestOf(server, owner, workspace, boardId, role = 'edit') {
  const guest = await server.user({ anonymous: true });
  const guestWs = await guest.rpc('create_workspace', { p_name: 'My boards', p_device: 'Laptop' });
  const share = await owner.rpc('create_share', {
    p_workspace: workspace,
    p_kind: 'board',
    p_target: boardId,
  });
  const code = await owner.rpc('create_share_invite', { p_share: share, p_role: role });
  await guest.rpc('redeem_share_invite', { p_code: code, p_workspace: guestWs });
  return { guest, guestWs, share };
}

const sharedWithMe = (person) => person.query('select * from public.shared_with_me()');
const visibleBoards = (person, workspace) =>
  person.query(`select id from public.entities where workspace_id = $1 and kind = 'board'`, [
    workspace,
  ]);
const userExists = async (server, id) =>
  (await server.admin('select 1 from auth.users where id = $1', [id])).length === 1;

async function claim(anon, account) {
  const secret = await anon.rpc('begin_claim');
  return account.rpc('finish_claim', { p_secret: secret });
}

test('a 0.1.28 library with a share moves onto a new account', async () => {
  const server = await supabaseDb();
  const { computer, workspace } = await anonymousLibrary(server);
  const { guest } = await guestOf(server, computer, workspace, 'b1');
  const account = await server.user({ email: 'anton@example.com' });

  const result = await claim(computer, account);

  assert.deepEqual(result, { result: 'moved', workspace });
  assert.equal(await userExists(server, computer.id), false, 'the anonymous user is gone');
  const [ws] = await server.admin('select * from public.workspaces where id = $1', [workspace]);
  assert.ok(ws, 'the workspace still exists');
  assert.equal(ws.created_by, account.id);
  assert.equal(ws.display_name, 'Anton');
  assert.equal(await account.rpc('workspace_role', { p_workspace: workspace }), 'owner');
  const [mine] = await account.query('select * from public.accounts');
  assert.equal(mine.personal_workspace, workspace);
  assert.deepEqual(
    (await visibleBoards(account, workspace)).map((r) => r.id),
    ['b1'],
  );
  // The guest still sees the board, under the same workspace.
  const shares = await sharedWithMe(guest);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].workspace_id, workspace);
  assert.deepEqual(
    (await visibleBoards(guest, workspace)).map((r) => r.id),
    ['b1'],
  );
  const [share] = await server.admin('select created_by from public.shares');
  assert.equal(share.created_by, account.id);
});

test('a second paired computer claims into the same account', async () => {
  const server = await supabaseDb();
  const { computer: first, workspace } = await anonymousLibrary(server);
  const second = await server.user({ anonymous: true });
  const code = await first.rpc('create_pairing_code', { p_workspace: workspace });
  await second.rpc('redeem_pairing_code', { p_code: code, p_device: 'Laptop' });
  const account = await server.user();

  assert.equal((await claim(first, account)).result, 'moved');
  // The second computer signs in to the same account later.
  assert.deepEqual(await claim(second, account), { result: 'joined', workspace });

  const members = await server.admin(
    'select user_id from public.workspace_members where workspace_id = $1',
    [workspace],
  );
  assert.deepEqual(
    members.map((m) => m.user_id),
    [account.id],
  );
  assert.equal((await server.admin('select * from public.workspaces')).length, 1);
  await account.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '0.2.0' });
  await account.rpc('register_device', {
    p_id: randomUUID(),
    p_name: 'Laptop',
    p_version: '0.2.0',
  });
  assert.equal((await account.query('select * from public.devices')).length, 2);
});

test('two unpaired libraries combine, and the guest keeps the same board', async () => {
  const server = await supabaseDb();
  // First computer: claimed already, so the account has a personal workspace.
  const { computer: first, workspace: personal } = await anonymousLibrary(server, 'b-first');
  const account = await server.user();
  await claim(first, account);
  // Second computer: sync turned on separately, never paired, sharing b2 with a guest.
  const { computer: second, workspace: old } = await anonymousLibrary(server, 'b2');
  const { guest, guestWs } = await guestOf(server, second, old, 'b2', 'view');
  // The guest also shared something with the second computer.
  const guestShare = await guest.rpc('create_share', {
    p_workspace: guestWs,
    p_kind: 'board',
    p_target: 'g1',
  });
  const invite = await guest.rpc('create_share_invite', { p_share: guestShare, p_role: 'edit' });
  await second.rpc('redeem_share_invite', { p_code: invite, p_workspace: old });

  const result = await claim(second, account);
  assert.deepEqual(result, { result: 'combine', workspace: personal, retire: old });
  assert.equal(await userExists(server, second.id), false);

  // The app uploads its library to the personal workspace, then retires the old one.
  await account.rpc('push_entities', {
    p_workspace: personal,
    p_rows: JSON.stringify([board('b2'), object('b2', 'n1')]),
  });
  await account.rpc('retire_workspace', { p_old: old, p_new: personal });

  assert.equal(
    (await server.admin('select 1 from public.workspaces where id = $1', [old])).length,
    0,
  );
  const shares = await sharedWithMe(guest);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].workspace_id, personal);
  assert.equal(shares[0].target_id, 'b2');
  assert.equal(shares[0].role, 'view');
  assert.deepEqual(
    (await visibleBoards(guest, personal)).map((r) => r.id),
    ['b2'],
    'the guest sees only the shared board, with the same id',
  );
  // What the guest shared with the old workspace now reaches the personal one.
  const received = await sharedWithMe(account);
  assert.deepEqual(
    received.map((s) => [s.target_id, s.role]),
    [['g1', 'edit']],
  );
});

test('retire_workspace refuses anything but the caller own old library', async () => {
  const server = await supabaseDb();
  const { computer, workspace } = await anonymousLibrary(server);
  const account = await server.user();
  await claim(computer, account);
  const stranger = await anonymousLibrary(server, 'x');
  await assert.rejects(
    account.rpc('retire_workspace', { p_old: stranger.workspace, p_new: workspace }),
    /cannot combine/,
  );
  await assert.rejects(
    account.rpc('retire_workspace', { p_old: workspace, p_new: workspace }),
    /cannot combine/,
  );
});

test('claim secrets work once, expire, and need the right kind of user', async () => {
  const server = await supabaseDb();
  const { computer } = await anonymousLibrary(server);
  const account = await server.user();
  const other = await server.user({ anonymous: true });

  await assert.rejects(account.rpc('begin_claim'), /without an account/);
  const secret = await computer.rpc('begin_claim');
  await assert.rejects(other.rpc('finish_claim', { p_secret: secret }), /Sign in first/);
  await assert.rejects(account.rpc('finish_claim', { p_secret: 'wrong' }), /took too long/);
  await server.admin(`update public.account_claims set expires_at = now() - interval '1 minute'`);
  await assert.rejects(account.rpc('finish_claim', { p_secret: secret }), /took too long/);
  const fresh = await computer.rpc('begin_claim');
  assert.equal((await server.admin('select * from public.account_claims')).length, 1);
  await account.rpc('finish_claim', { p_secret: fresh });
  await assert.rejects(account.rpc('finish_claim', { p_secret: fresh }), /took too long/);
  // Secrets are only stored hashed.
  assert.equal((await server.admin('select * from public.account_claims')).length, 0);
});

test('a computer paired to another account library does not get into it', async () => {
  const server = await supabaseDb();
  const { computer: first, workspace } = await anonymousLibrary(server);
  const second = await server.user({ anonymous: true });
  const code = await first.rpc('create_pairing_code', { p_workspace: workspace });
  await second.rpc('redeem_pairing_code', { p_code: code, p_device: 'Family PC' });
  const owner = await server.user();
  await claim(first, owner);

  const someoneElse = await server.user();
  assert.deepEqual(await claim(second, someoneElse), { result: 'none', workspace: null });
  assert.equal(await someoneElse.rpc('workspace_role', { p_workspace: workspace }), null);
  const created = await someoneElse.rpc('ensure_personal_workspace', { p_name: 'Sam' });
  assert.equal(created.created, true);
  assert.notEqual(created.workspace, workspace);
});

test('the claim still succeeds when the database refuses to delete the anonymous user', async () => {
  const server = await supabaseDb();
  await server.admin(`
    create function public.refuse_delete() returns trigger language plpgsql as $$
    begin raise exception 'permission denied for table users' using errcode = '42501'; end $$;
    create trigger refuse before delete on auth.users for each row execute function public.refuse_delete();`);
  const { computer, workspace } = await anonymousLibrary(server);
  const account = await server.user();
  assert.deepEqual(await claim(computer, account), { result: 'moved', workspace });
  assert.equal(await userExists(server, computer.id), true);
  assert.equal(await computer.rpc('workspace_role', { p_workspace: workspace }), null);
});

test('ensure_personal_workspace creates one workspace per account and keeps its name', async () => {
  const server = await supabaseDb();
  const account = await server.user();
  const first = await account.rpc('ensure_personal_workspace', { p_name: ' Anton ' });
  assert.equal(first.created, true);
  assert.equal(first.name, 'Anton');
  const again = await account.rpc('ensure_personal_workspace', { p_name: 'Other name' });
  assert.deepEqual(again, { workspace: first.workspace, name: 'Anton', created: false });
  const me = await account.rpc('my_account');
  assert.equal(me.personalWorkspace, first.workspace);
  assert.equal(me.anonymous, false);
  const anon = await server.user({ anonymous: true });
  await assert.rejects(anon.rpc('ensure_personal_workspace', { p_name: 'x' }), /Sign in first/);
});

test('removing a computer ends its session; signing in again brings it back', async () => {
  const server = await supabaseDb();
  const account = await server.user();
  const laptop = randomUUID();
  assert.deepEqual(
    await account.rpc('register_device', { p_id: laptop, p_name: 'Laptop', p_version: '0.2.0' }),
    { revoked: false },
  );
  await account.rpc('revoke_device', { p_id: laptop });
  assert.equal(
    (await server.admin('select 1 from auth.sessions where id = $1', [account.session])).length,
    0,
  );
  assert.deepEqual(
    await account.rpc('register_device', { p_id: laptop, p_name: 'Laptop', p_version: '0.2.0' }),
    { revoked: true },
  );
  account.session = randomUUID();
  assert.deepEqual(
    await account.rpc('register_device', { p_id: laptop, p_name: 'Laptop', p_version: '0.2.0' }),
    { revoked: false },
  );
  await assert.rejects(account.rpc('revoke_device', { p_id: randomUUID() }), /not on your account/);
  // Other people's devices stay private.
  const other = await server.user();
  assert.equal((await other.query('select * from public.devices')).length, 0);
});

test('an old paired computer cannot remove the account from its library', async () => {
  const server = await supabaseDb();
  const { computer: first, workspace } = await anonymousLibrary(server);
  const second = await server.user({ anonymous: true });
  const code = await first.rpc('create_pairing_code', { p_workspace: workspace });
  await second.rpc('redeem_pairing_code', { p_code: code, p_device: 'Laptop' });
  const account = await server.user();
  await claim(first, account);
  await assert.rejects(
    second.rpc('remove_member', { p_workspace: workspace, p_user: account.id }),
    /belongs to an account/,
  );
});

test('pushes record the device, and 0.1.28 apps can still push without one', async () => {
  const server = await supabaseDb();
  const account = await server.user();
  const { workspace } = await account.rpc('ensure_personal_workspace', { p_name: 'A' });
  const device = randomUUID();
  await account.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1')]),
    p_device: device,
  });
  const { computer, workspace: old } = await anonymousLibrary(server, 'b-old');
  assert.ok(computer);
  const rows = await server.admin(
    'select workspace_id, updated_device from public.entities order by seq',
  );
  assert.deepEqual(rows, [
    { workspace_id: workspace, updated_device: device },
    { workspace_id: old, updated_device: null },
    { workspace_id: old, updated_device: null },
  ]);
});

test('deleting cloud data removes the library, its shares and the sign-in', async () => {
  const server = await supabaseDb();
  const account = await server.user();
  const { workspace } = await account.rpc('ensure_personal_workspace', { p_name: 'Anton' });
  await account.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1'), object('b1', 'n1')]),
  });
  await account.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '1' });
  const { guest, guestWs } = await guestOf(server, account, workspace, 'b1');
  // The account is also a guest on someone's board.
  const theirShare = await guest.rpc('create_share', {
    p_workspace: guestWs,
    p_kind: 'board',
    p_target: 'g1',
  });
  const invite = await guest.rpc('create_share_invite', { p_share: theirShare, p_role: 'view' });
  await account.rpc('redeem_share_invite', { p_code: invite, p_workspace: workspace });

  assert.deepEqual(await account.rpc('my_deletable_workspaces'), [workspace]);
  assert.deepEqual(await account.rpc('delete_my_cloud_data'), { userDeleted: true });

  assert.equal(await userExists(server, account.id), false);
  for (const table of ['workspaces', 'entities', 'shares', 'asset_refs', 'workspace_members'])
    assert.equal(
      (
        await server.admin(
          `select 1 from public.${table} where workspace_id = $1`.replace(
            'workspace_id',
            table === 'workspaces' ? 'id' : 'workspace_id',
          ),
          [workspace],
        )
      ).length,
      0,
      table,
    );
  assert.equal((await server.admin('select * from public.devices')).length, 0);
  assert.equal((await server.admin('select * from public.accounts')).length, 0);
  assert.equal((await sharedWithMe(guest)).length, 0, 'the guest lost the board');
  // The guest's own library and share are untouched; the account just left it.
  assert.equal(
    (await server.admin('select 1 from public.workspaces where id = $1', [guestWs])).length,
    1,
  );
  assert.equal(
    (await server.admin('select 1 from public.share_members where share_id = $1', [theirShare]))
      .length,
    0,
  );
});

test('an old paired computer deleting its cloud data only leaves the account library', async () => {
  const server = await supabaseDb();
  const { computer: first, workspace } = await anonymousLibrary(server);
  const second = await server.user({ anonymous: true });
  const code = await first.rpc('create_pairing_code', { p_workspace: workspace });
  await second.rpc('redeem_pairing_code', { p_code: code, p_device: 'Laptop' });
  const account = await server.user();
  await claim(first, account);

  assert.deepEqual(await second.rpc('my_deletable_workspaces'), []);
  await second.rpc('delete_my_cloud_data');
  assert.equal(
    (await server.admin('select 1 from public.workspaces where id = $1', [workspace])).length,
    1,
  );
  assert.equal(await userExists(server, second.id), false);
});

test('when the sign-in cannot be deleted from SQL, the data still goes and the request is kept', async () => {
  const server = await supabaseDb();
  await server.admin(`
    create function public.refuse_delete() returns trigger language plpgsql as $$
    begin raise exception 'permission denied for table users' using errcode = '42501'; end $$;
    create trigger refuse before delete on auth.users for each row execute function public.refuse_delete();`);
  const account = await server.user();
  const { workspace } = await account.rpc('ensure_personal_workspace', { p_name: 'A' });
  assert.deepEqual(await account.rpc('delete_my_cloud_data'), { userDeleted: false });
  assert.equal(
    (await server.admin('select 1 from public.workspaces where id = $1', [workspace])).length,
    0,
  );
  assert.deepEqual(
    (await server.admin('select user_id from public.deletion_requests')).map((r) => r.user_id),
    [account.id],
  );
});

test('only owners may remove a workspace media files', async () => {
  const server = await supabaseDb();
  const account = await server.user();
  const { workspace } = await account.rpc('ensure_personal_workspace', { p_name: 'A' });
  const file = `${workspace}/${'a'.repeat(64)}`;
  await server.admin(`insert into storage.objects (bucket_id, name) values ('assets', $1)`, [file]);
  const stranger = await server.user();
  await stranger.query(`delete from storage.objects where name = $1`, [file]);
  assert.equal((await server.admin('select 1 from storage.objects')).length, 1);
  await account.query(`delete from storage.objects where name = $1`, [file]);
  assert.equal((await server.admin('select 1 from storage.objects')).length, 0);
});

test('files the person added to someone else board do not block deleting the sign-in', async () => {
  const server = await supabaseDb();
  // Older Supabase storage schemas link a file's owner to the user without cascading.
  await server.admin(
    'alter table storage.objects add column owner uuid references auth.users (id)',
  );
  const account = await server.user();
  await account.rpc('ensure_personal_workspace', { p_name: 'A' });
  const other = await server.user();
  const { workspace: theirs } = await other.rpc('ensure_personal_workspace', { p_name: 'B' });
  await server.admin(
    "insert into storage.objects (bucket_id, name, owner) values ('assets', $1, $2)",
    [`${theirs}/${'b'.repeat(64)}`, account.id],
  );
  assert.deepEqual(await account.rpc('delete_my_cloud_data'), { userDeleted: false });
  assert.equal((await server.admin('select * from public.deletion_requests')).length, 1);
  assert.equal(
    (await server.admin('select * from public.accounts where user_id = $1', [account.id])).length,
    0,
  );
});
