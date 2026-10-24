// Who may join and send on a board's live channels (migration 20261024150000), in PGlite.
// 'board:<id>' carries presence and cursors for everyone with access; 'edits:<id>' carries
// edits, which only people who may change the board can send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseDb } from './supabase-db.mjs';

async function account(server, name) {
  const person = await server.user();
  const { workspace } = await person.rpc('ensure_personal_workspace', { p_name: name });
  return { person, workspace };
}

// The board's share (one per board), with this person in it.
async function share(server, owner, boardId, member, role) {
  await server.admin(
    `insert into public.shares (workspace_id, kind, target_id, created_by)
     values ($1, 'board', $2, $3) on conflict do nothing`,
    [owner.workspace, boardId, owner.person.id],
  );
  const [{ id }] = await server.admin(
    `select id from public.shares where workspace_id = $1 and kind = 'board' and target_id = $2`,
    [owner.workspace, boardId],
  );
  await server.admin(
    'insert into public.share_members (share_id, member_workspace, role) values ($1, $2, $3)',
    [id, member.workspace, role],
  );
}

test('only people who may change a board send its live edits', async () => {
  const server = await supabaseDb();
  const owner = await account(server, 'Anton');
  await owner.person.rpc('push_entities', {
    p_workspace: owner.workspace,
    p_rows: JSON.stringify([
      { kind: 'board', board_id: '', id: 'b1', data: { name: 'Plan', folderId: null } },
    ]),
  });
  const editor = await account(server, 'Sam');
  const viewer = await account(server, 'Kim');
  const stranger = await account(server, 'Lee');
  await share(server, owner, 'b1', editor, 'edit');
  await share(server, owner, 'b1', viewer, 'view');

  assert.deepEqual(await owner.person.channel('edits:b1'), { receive: true, send: true });
  assert.deepEqual(await editor.person.channel('edits:b1'), { receive: true, send: true });
  assert.deepEqual(await viewer.person.channel('edits:b1'), { receive: true, send: false });
  assert.deepEqual(await stranger.person.channel('edits:b1'), { receive: false, send: false });

  // Presence and cursors stay open to viewers.
  assert.deepEqual(await viewer.person.channel('board:b1'), { receive: true, send: true });
  assert.deepEqual(await stranger.person.channel('board:b1'), { receive: false, send: false });
  assert.deepEqual(await owner.person.channel('terra:' + owner.workspace), {
    receive: true,
    send: true,
  });
  assert.deepEqual(await owner.person.channel('edits:b2'), { receive: false, send: false });
});

test("a board's live edits close to someone whose access ends", async () => {
  const server = await supabaseDb();
  const owner = await account(server, 'Anton');
  await owner.person.rpc('push_entities', {
    p_workspace: owner.workspace,
    p_rows: JSON.stringify([
      { kind: 'board', board_id: '', id: 'b1', data: { name: 'Plan', folderId: null } },
    ]),
  });
  const editor = await account(server, 'Sam');
  await share(server, owner, 'b1', editor, 'edit');
  assert.equal((await editor.person.channel('edits:b1')).send, true);
  await server.admin('update public.share_members set role = $1', ['view']);
  assert.deepEqual(await editor.person.channel('edits:b1'), { receive: true, send: false });
  await server.admin('delete from public.share_members');
  assert.deepEqual(await editor.person.channel('edits:b1'), { receive: false, send: false });
});
