// Leaving a board a team gave you (ee/supabase/migrations/20261027090000_leave_team_share.sql):
// the team doesn't give it back, and a direct invite lets the person in again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseDb } from './supabase-db.mjs';

async function setup() {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('boss@acme.eu')");
  const boss = await server.user({ email: 'boss@acme.eu' });
  const person = async (email) => {
    const p = await server.user({ email });
    p.ws = (await p.rpc('ensure_personal_workspace', { p_name: email.split('@')[0] })).workspace;
    return p;
  };
  const owner = await person('owner@acme.eu');
  const ben = await person('ben@acme.eu');
  const cleo = await person('cleo@acme.eu');
  const team = await boss.rpc('admin_create_team', { p_name: 'Marketing' });
  for (const p of [ben, cleo])
    await boss.rpc('admin_set_team_member', { p_team: team, p_user: p.id, p_in: true });
  const share = await owner.rpc('create_share', {
    p_workspace: owner.ws,
    p_kind: 'board',
    p_target: 'b1',
  });
  await owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'edit' });
  return { server, boss, owner, ben, cleo, team, share };
}

const sees = async (p) =>
  (await p.query('select role from public.shared_with_me()')).map((r) => r.role);
const leave = (p, share) => p.rpc('remove_share_member', { p_share: share, p_member: p.ws });

test('someone can leave a board their team has, and it stays left', async () => {
  const { server, boss, owner, ben, cleo, team, share } = await setup();
  assert.deepEqual(await sees(ben), ['edit']);
  await leave(ben, share);
  assert.deepEqual(await sees(ben), [], 'left');
  assert.deepEqual(await sees(cleo), ['edit'], 'the rest of the team keeps it');

  // Team changes don't bring it back.
  const dan = await server.user({ email: 'dan@acme.eu' });
  await dan.rpc('ensure_personal_workspace', { p_name: 'dan' });
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: dan.id, p_in: true });
  await owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'view' });
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: ben.id, p_in: false });
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: ben.id, p_in: true });
  assert.deepEqual(await sees(ben), []);
  const other = await boss.rpc('admin_create_team', { p_name: 'Sales' });
  await boss.rpc('admin_set_team_member', { p_team: other, p_user: ben.id, p_in: true });
  await owner.rpc('share_with_team', { p_share: share, p_team: other, p_role: 'edit' });
  assert.deepEqual(await sees(ben), [], 'not through another team either');
  assert.deepEqual(await sees(dan), ['view'], 'Marketing is view now');
});

test('a direct invite lets them back in, and their teams count again', async () => {
  const { boss, owner, ben, team, share } = await setup();
  await leave(ben, share);
  const code = await owner.rpc('create_share_invite', { p_share: share, p_role: 'view' });
  await ben.rpc('redeem_share_invite', { p_code: code, p_workspace: ben.ws });
  assert.deepEqual(await sees(ben), ['edit'], 'view invite plus the team edit');
  // Back to normal: leaving the team now keeps the direct view access.
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: ben.id, p_in: false });
  assert.deepEqual(await sees(ben), ['view']);
});

test('the owner removing a team member keeps them out too', async () => {
  const { owner, ben, cleo, share } = await setup();
  await owner.rpc('remove_share_member', { p_share: share, p_member: ben.ws });
  assert.deepEqual(await sees(ben), []);
  assert.deepEqual(await sees(cleo), ['edit']);
  const people = await owner.query('select * from public.share_people($1)', [share]);
  assert.equal(people.length, 1);
});

test('someone with direct and team access who leaves loses both', async () => {
  const { owner, ben, share } = await setup();
  await owner.rpc('set_share_role', { p_share: share, p_member: ben.ws, p_role: 'view' });
  await leave(ben, share);
  assert.deepEqual(await sees(ben), []);
});

test('deleting a share, a team or a person after someone left cleans up', async () => {
  const { server, boss, owner, ben, team, share } = await setup();
  await leave(ben, share);
  await boss.rpc('admin_delete_team', { p_team: team });
  await owner.rpc('delete_share', { p_share: share });
  assert.equal((await server.admin('select * from public.team_optouts')).length, 0);
  await server.admin('delete from auth.users where id = $1', [ben.id]);
});
