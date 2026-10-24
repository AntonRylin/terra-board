// The second company migration (ee/supabase/migrations/20261026090000_roles_teams.sql) in
// PGlite: the edition marker, server roles (admin, member, guest) and teams that share
// boards and folders through the core share_members table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { supabaseDb } from './supabase-db.mjs';

const eeFile = new URL('../ee/supabase/migrations/20261026090000_roles_teams.sql', import.meta.url);
const notAdmin = { code: '42501', message: /Only a server admin/ };

async function companyServer() {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('boss@acme.eu')");
  const boss = await server.user({ email: 'boss@acme.eu' });
  return { server, boss };
}

// A signed-in person with a personal workspace.
async function person(server, email, name = email.split('@')[0]) {
  const p = await server.user({ email });
  p.ws = (await p.rpc('ensure_personal_workspace', { p_name: name })).workspace;
  return p;
}

const shareBoard = (owner, board = 'b1') =>
  owner.rpc('create_share', { p_workspace: owner.ws, p_kind: 'board', p_target: board });

// share_id -> role as the person sees it in shared_with_me().
const sharedWith = async (p) =>
  Object.fromEntries(
    (await p.query('select share_id, role from public.shared_with_me()')).map((r) => [
      r.share_id,
      r.role,
    ]),
  );

const memberRows = (server, share) =>
  server.admin(
    'select member_workspace, role from public.share_members where share_id = $1 order by member_workspace',
    [share],
  );

// Runs one statement as the anon API role (no JWT), like a client before sign-in.
const asAnon = (server, sql) =>
  server.db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return (await tx.query(sql)).rows;
  });

const log = async (boss) => (await boss.rpc('admin_audit')).reverse();
const clearLog = (server) => server.admin('delete from public.audit_events');

test('the migration runs again over itself', async () => {
  const { server, boss } = await companyServer();
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  await boss.rpc('admin_set_role', { p_email: 'g@acme.eu', p_role: 'guest' });
  await server.admin(fs.readFileSync(eeFile, 'utf8'));
  assert.deepEqual(
    (await boss.rpc('company_teams')).map((t) => t.id),
    [team],
  );
  assert.equal((await server.admin('select * from public.server_roles')).length, 1);
});

test('company_info marks the company edition, for anyone before sign-in too', async () => {
  const { server, boss } = await companyServer();
  assert.deepEqual((await asAnon(server, 'select public.company_info() as v'))[0].v, {
    edition: 'company',
    sso: true,
  });
  await boss.rpc('admin_set_sso', { p_on: false });
  assert.deepEqual(await boss.rpc('company_info'), { edition: 'company', sso: false });
  assert.equal((await boss.rpc('company_status')).sso, false);
  await assert.rejects(boss.rpc('admin_set_sso', { p_on: null }), { code: '22023' });
  await boss.rpc('admin_set_sso', { p_on: true });
  assert.deepEqual(
    (await log(boss)).map((e) => e.action).filter((a) => a.startsWith('sso')),
    ['sso.off', 'sso.on'],
  );
  // The anon role can't reach anything else of the company edition.
  await assert.rejects(asAnon(server, 'select public.company_status()'), { code: '42501' });
  await assert.rejects(asAnon(server, 'select public.company_teams()'), { code: '42501' });
});

test('roles: admins, the default role, and roles set by email before the account exists', async () => {
  const { server, boss } = await companyServer();
  const ana = await server.user({ email: 'ana@acme.eu' });
  assert.equal(await boss.rpc('my_server_role'), 'admin');
  assert.equal(await ana.rpc('my_server_role'), 'member');
  let status = await ana.rpc('company_status');
  assert.equal(status.role, 'member');
  assert.equal(status.defaultRole, 'member');

  await boss.rpc('admin_set_role', { p_email: ' Gus@Acme.eu ', p_role: 'guest' });
  const gus = await server.user({ email: 'gus@acme.eu' });
  assert.equal(await gus.rpc('my_server_role'), 'guest');
  assert.equal((await gus.rpc('company_status')).role, 'guest');

  await boss.rpc('admin_set_default_role', { p_role: 'guest' });
  assert.equal(await ana.rpc('my_server_role'), 'guest');
  assert.equal((await ana.rpc('company_status')).defaultRole, 'guest');
  await boss.rpc('admin_set_role', { p_email: 'ana@acme.eu', p_role: 'member' });
  assert.equal(await ana.rpc('my_server_role'), 'member', 'a role row beats the default');
  await boss.rpc('admin_set_default_role', { p_role: 'member' });

  // Admin wins over a role row.
  await boss.rpc('admin_set_role', { p_email: 'boss@acme.eu', p_role: 'guest' });
  assert.equal(await boss.rpc('my_server_role'), 'admin');
  // Anonymous computers stay members whatever the default.
  await boss.rpc('admin_set_default_role', { p_role: 'guest' });
  const anon = await server.user({ anonymous: true });
  assert.equal(await anon.rpc('my_server_role'), 'member');
  await boss.rpc('admin_set_default_role', { p_role: 'member' });

  const people = await boss.rpc('admin_people');
  assert.deepEqual(
    people.map((p) => [p.email, p.role]),
    [
      ['ana@acme.eu', 'member'],
      ['boss@acme.eu', 'admin'],
      ['gus@acme.eu', 'guest'],
    ],
  );

  for (const bad of ['admin', 'owner', null])
    await assert.rejects(boss.rpc('admin_set_role', { p_email: 'x@acme.eu', p_role: bad }), {
      code: '22023',
      message: /member or guest/,
    });
  await assert.rejects(boss.rpc('admin_set_role', { p_email: 'nobody', p_role: 'guest' }), {
    message: /valid email/,
  });
  await assert.rejects(boss.rpc('admin_set_default_role', { p_role: 'admin' }), {
    code: '22023',
  });

  const events = (await log(boss)).filter((e) => e.action.startsWith('role.'));
  assert.deepEqual(events[0].details, { email: 'gus@acme.eu', role: 'guest' });
  assert.equal(events[0].target, 'gus@acme.eu');
  assert.deepEqual(
    events.map((e) => e.action),
    [
      'role.set',
      'role.default',
      'role.set',
      'role.default',
      'role.set',
      'role.default',
      'role.default',
    ],
  );
});

test('guests cannot create invite codes, members can', async () => {
  const { server, boss } = await companyServer();
  const member = await person(server, 'mia@acme.eu');
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'guest' });
  const guest = await person(server, 'gus@acme.eu');
  const own = await shareBoard(guest);
  await assert.rejects(guest.rpc('create_share_invite', { p_share: own, p_role: 'view' }), {
    code: '42501',
    message: /Guests can't invite people/,
  });
  const share = await shareBoard(member);
  assert.match(await member.rpc('create_share_invite', { p_share: share, p_role: 'edit' }), /^S/);
});

test('a guest joining with an edit invite gets view, and becoming a guest caps edit access', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'guest' });
  const gus = await person(server, 'gus@acme.eu');
  const ana = await person(server, 'ana@acme.eu');
  const share = await shareBoard(owner);
  const code = await owner.rpc('create_share_invite', { p_share: share, p_role: 'edit' });
  await gus.rpc('redeem_share_invite', { p_code: code, p_workspace: gus.ws });
  assert.deepEqual(await sharedWith(gus), { [share]: 'view' });
  // Nor can the owner raise it.
  await owner.rpc('set_share_role', { p_share: share, p_member: gus.ws, p_role: 'edit' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'view' });

  const code2 = await owner.rpc('create_share_invite', { p_share: share, p_role: 'edit' });
  await ana.rpc('redeem_share_invite', { p_code: code2, p_workspace: ana.ws });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' });
  await boss.rpc('admin_set_role', { p_email: 'ana@acme.eu', p_role: 'guest' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });
  // Back to member: direct access stays view until the owner changes it.
  await boss.rpc('admin_set_role', { p_email: 'ana@acme.eu', p_role: 'member' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });
  await owner.rpc('set_share_role', { p_share: share, p_member: ana.ws, p_role: 'edit' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' });

  // A guest default caps everyone without a role row.
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'member' });
  await owner.rpc('set_share_role', { p_share: share, p_member: gus.ws, p_role: 'edit' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'edit' });
  await boss.rpc('admin_set_default_role', { p_role: 'guest' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'edit' }, 'gus has a member row');
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' }, 'so has ana');
  const sam = await person(server, 'sam@acme.eu');
  await boss.rpc('admin_set_default_role', { p_role: 'member' });
  const code3 = await owner.rpc('create_share_invite', { p_share: share, p_role: 'edit' });
  await sam.rpc('redeem_share_invite', { p_code: code3, p_workspace: sam.ws });
  await boss.rpc('admin_set_default_role', { p_role: 'guest' });
  assert.deepEqual(await sharedWith(sam), { [share]: 'view' });
});

test('teams are created, renamed and deleted by admins, with friendly name errors', async () => {
  const { server, boss } = await companyServer();
  const ana = await server.user({ email: 'ana@acme.eu' });
  const design = await boss.rpc('admin_create_team', { p_name: '  Design ' });
  const sales = await boss.rpc('admin_create_team', { p_name: 'sales' });
  await assert.rejects(boss.rpc('admin_create_team', { p_name: 'DESIGN' }), {
    code: '22023',
    message: /A team with this name already exists/,
  });
  for (const bad of ['', '   ', null])
    await assert.rejects(boss.rpc('admin_create_team', { p_name: bad }), {
      code: '22023',
      message: /Enter a team name/,
    });
  await assert.rejects(boss.rpc('admin_create_team', { p_name: 'x'.repeat(81) }), {
    message: /at most 80/,
  });
  await assert.rejects(boss.rpc('admin_rename_team', { p_team: sales, p_name: 'design' }), {
    message: /already exists/,
  });
  await boss.rpc('admin_rename_team', { p_team: sales, p_name: 'Account managers' });
  await boss.rpc('admin_set_team_member', { p_team: design, p_user: ana.id, p_in: true });

  assert.deepEqual(await ana.rpc('company_teams'), [
    { id: sales, name: 'Account managers', members: 0, mine: false },
    { id: design, name: 'Design', members: 1, mine: true },
  ]);
  assert.deepEqual(await boss.rpc('admin_team_members', { p_team: design }), [
    { id: ana.id, email: 'ana@acme.eu' },
  ]);
  const anon = await server.user({ anonymous: true });
  await assert.rejects(anon.rpc('company_teams'), { code: '28000' });

  await boss.rpc('admin_delete_team', { p_team: sales });
  await assert.rejects(boss.rpc('admin_delete_team', { p_team: sales }), {
    message: /does not exist/,
  });
  await assert.rejects(boss.rpc('admin_rename_team', { p_team: randomUUID(), p_name: 'A' }), {
    message: /does not exist/,
  });
  await assert.rejects(
    boss.rpc('admin_set_team_member', { p_team: design, p_user: anon.id, p_in: true }),
    { message: /not on this server/ },
  );
  assert.deepEqual(
    (await ana.rpc('company_teams')).map((t) => t.name),
    ['Design'],
  );

  const events = (await log(boss)).filter((e) => e.action.startsWith('team.'));
  assert.deepEqual(
    events.map((e) => [e.action, e.target]),
    [
      ['team.created', design],
      ['team.created', sales],
      ['team.renamed', sales],
      ['team.member_added', design],
      ['team.deleted', sales],
    ],
  );
  assert.deepEqual(events[2].details, { from: 'sales', name: 'Account managers' });
  assert.deepEqual(events[3].details, { team: 'Design', user: ana.id, email: 'ana@acme.eu' });
});

test('non-admins are refused by every admin team and role call', async () => {
  const { server, boss } = await companyServer();
  const ana = await server.user({ email: 'ana@acme.eu' });
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  const calls = [
    ['admin_set_sso', { p_on: false }],
    ['admin_set_role', { p_email: 'ana@acme.eu', p_role: 'member' }],
    ['admin_set_default_role', { p_role: 'guest' }],
    ['admin_create_team', { p_name: 'Mine' }],
    ['admin_rename_team', { p_team: team, p_name: 'Mine' }],
    ['admin_delete_team', { p_team: team }],
    ['admin_team_members', { p_team: team }],
    ['admin_set_team_member', { p_team: team, p_user: ana.id, p_in: true }],
  ];
  for (const [name, args] of calls) await assert.rejects(ana.rpc(name, args), notAdmin, name);
  for (const table of ['server_roles', 'teams', 'team_members', 'team_shares', 'team_grants'])
    await assert.rejects(ana.query(`select * from public.${table}`), { code: '42501' }, table);
  // Internal functions are not callable through the API.
  await assert.rejects(ana.rpc('server_role', { p_user: ana.id }), { code: '42501' });
  await assert.rejects(ana.rpc('team_sync_share', { p_share: randomUUID() }), { code: '42501' });
});

test('sharing with a team gives every member access; joining later grants, leaving revokes', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  const ana = await person(server, 'ana@acme.eu');
  const bob = await person(server, 'bob@acme.eu');
  const noLibrary = await server.user({ email: 'new@acme.eu' });
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  for (const p of [ana, noLibrary, owner])
    await boss.rpc('admin_set_team_member', { p_team: team, p_user: p.id, p_in: true });
  const share = await shareBoard(owner);
  await clearLog(server);

  await owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'edit' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' });
  assert.deepEqual(await sharedWith(bob), {});
  assert.deepEqual(
    (await memberRows(server, share)).map((r) => r.member_workspace),
    [ana.ws],
    'the owner (in the team) gets no row for their own workspace; no library, no row',
  );
  assert.deepEqual(await owner.rpc('share_teams', { p_share: share }), [
    { team, name: 'Design', role: 'edit', members: 3 },
  ]);

  // Someone with no library yet gets access when they get one.
  noLibrary.ws = (await noLibrary.rpc('ensure_personal_workspace', { p_name: 'New' })).workspace;
  assert.deepEqual(await sharedWith(noLibrary), { [share]: 'edit' });

  await boss.rpc('admin_set_team_member', { p_team: team, p_user: bob.id, p_in: true });
  assert.deepEqual(await sharedWith(bob), { [share]: 'edit' });
  await owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'view' });
  assert.deepEqual(await sharedWith(bob), { [share]: 'view' });
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: bob.id, p_in: false });
  assert.deepEqual(await sharedWith(bob), {});
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });

  await owner.rpc('unshare_team', { p_share: share, p_team: team });
  assert.deepEqual(await sharedWith(ana), {});
  assert.deepEqual(await memberRows(server, share), []);
  assert.deepEqual(await server.admin('select * from public.team_grants'), []);
  assert.deepEqual(await owner.rpc('share_teams', { p_share: share }), []);

  const events = (await log(boss)).filter((e) => e.action.startsWith('share.team'));
  assert.deepEqual(
    events.map((e) => [e.action, e.target, e.details.role]),
    [
      ['share.team_added', share, 'edit'],
      ['share.team_role_changed', share, 'view'],
      ['share.team_removed', share, 'view'],
    ],
  );
  assert.deepEqual(events[0].details, { team, teamName: 'Design', kind: 'board', role: 'edit' });
  assert.equal(events[1].details.from, 'edit');
  // The access itself is in the log as share members.
  assert.ok((await log(boss)).some((e) => e.action === 'share.member_added'));
});

test('direct access and team access: the strongest wins and the direct role comes back', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  const ana = await person(server, 'ana@acme.eu');
  const share = await shareBoard(owner);
  const code = await owner.rpc('create_share_invite', { p_share: share, p_role: 'view' });
  await ana.rpc('redeem_share_invite', { p_code: code, p_workspace: ana.ws });
  const viewers = await boss.rpc('admin_create_team', { p_name: 'Viewers' });
  const editors = await boss.rpc('admin_create_team', { p_name: 'Editors' });
  for (const t of [viewers, editors])
    await boss.rpc('admin_set_team_member', { p_team: t, p_user: ana.id, p_in: true });

  await owner.rpc('share_with_team', { p_share: share, p_team: viewers, p_role: 'view' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });
  await owner.rpc('share_with_team', { p_share: share, p_team: editors, p_role: 'edit' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' }, 'view + edit teams give edit');
  await owner.rpc('unshare_team', { p_share: share, p_team: editors });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });
  await owner.rpc('unshare_team', { p_share: share, p_team: viewers });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' }, 'the direct row stays');

  // The owner changes the direct role while a team gives access: it applies once the team goes.
  await owner.rpc('share_with_team', { p_share: share, p_team: editors, p_role: 'edit' });
  await owner.rpc('set_share_role', { p_share: share, p_member: ana.ws, p_role: 'view' });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' }, 'the team role still applies');
  await owner.rpc('set_share_role', { p_share: share, p_member: ana.ws, p_role: 'edit' });
  await owner.rpc('unshare_team', { p_share: share, p_team: editors });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' });

  // Removing the person directly takes their team access too (20261027090000: it stays
  // removed until they are invited again).
  await owner.rpc('share_with_team', { p_share: share, p_team: viewers, p_role: 'view' });
  await owner.rpc('remove_share_member', { p_share: share, p_member: ana.ws });
  assert.deepEqual(await sharedWith(ana), {});
  await owner.rpc('unshare_team', { p_share: share, p_team: viewers });
  assert.deepEqual(await sharedWith(ana), {});

  // Joining with an invite while a team gives access: the invite's role is the direct role.
  await owner.rpc('share_with_team', { p_share: share, p_team: editors, p_role: 'edit' });
  const again = await owner.rpc('create_share_invite', { p_share: share, p_role: 'view' });
  await ana.rpc('redeem_share_invite', { p_code: again, p_workspace: ana.ws });
  assert.deepEqual(await sharedWith(ana), { [share]: 'edit' });
  await owner.rpc('unshare_team', { p_share: share, p_team: editors });
  assert.deepEqual(await sharedWith(ana), { [share]: 'view' });
});

test('guests get view through teams and cannot share with teams', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'guest' });
  const gus = await person(server, 'gus@acme.eu');
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  await boss.rpc('admin_set_team_member', { p_team: team, p_user: gus.id, p_in: true });
  const share = await shareBoard(owner);
  await owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'edit' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'view' });

  // Member again: the team's edit role applies; guest again: view.
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'member' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'edit' });
  await boss.rpc('admin_set_role', { p_email: 'gus@acme.eu', p_role: 'guest' });
  assert.deepEqual(await sharedWith(gus), { [share]: 'view' });
  await owner.rpc('unshare_team', { p_share: share, p_team: team });
  assert.deepEqual(await sharedWith(gus), {}, 'no direct role was invented');

  const own = await shareBoard(gus, 'g1');
  await assert.rejects(gus.rpc('share_with_team', { p_share: own, p_team: team, p_role: 'view' }), {
    code: '42501',
    message: /Guests can't share on this server/,
  });
});

test('only the owner shares with teams, and bad input is refused', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  const ana = await person(server, 'ana@acme.eu');
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  const share = await shareBoard(owner);
  const calls = [
    ['share_with_team', { p_share: share, p_team: team, p_role: 'view' }],
    ['unshare_team', { p_share: share, p_team: team }],
    ['share_teams', { p_share: share }],
  ];
  for (const [name, args] of calls)
    await assert.rejects(ana.rpc(name, args), { code: '42501', message: /Only the owner/ }, name);
  await assert.rejects(
    boss.rpc('share_with_team', calls[0][1]),
    { code: '42501', message: /Only the owner/ },
    "admins don't own other people's shares",
  );
  assert.deepEqual(await server.admin('select * from public.team_shares'), []);
  await assert.rejects(
    owner.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'own' }),
    {
      code: '22023',
    },
  );
  await assert.rejects(
    owner.rpc('share_with_team', { p_share: share, p_team: randomUUID(), p_role: 'view' }),
    { message: /does not exist/ },
  );
  const anon = await server.user({ anonymous: true });
  await assert.rejects(
    anon.rpc('share_with_team', { p_share: share, p_team: team, p_role: 'view' }),
    {
      code: '28000',
    },
  );
});

test('deleting a team, a share, a user or a workspace cleans up and never fails', async () => {
  const { server, boss } = await companyServer();
  const owner = await person(server, 'owner@acme.eu');
  const ana = await person(server, 'ana@acme.eu');
  const bob = await person(server, 'bob@acme.eu');
  const team = await boss.rpc('admin_create_team', { p_name: 'Design' });
  const other = await boss.rpc('admin_create_team', { p_name: 'Other' });
  for (const p of [ana, bob]) {
    await boss.rpc('admin_set_team_member', { p_team: team, p_user: p.id, p_in: true });
    await boss.rpc('admin_set_team_member', { p_team: other, p_user: p.id, p_in: true });
  }
  const s1 = await shareBoard(owner, 'b1');
  const s2 = await shareBoard(owner, 'b2');
  await owner.rpc('share_with_team', { p_share: s1, p_team: team, p_role: 'edit' });
  await owner.rpc('share_with_team', { p_share: s2, p_team: team, p_role: 'view' });
  await owner.rpc('share_with_team', { p_share: s2, p_team: other, p_role: 'view' });

  // Deleting a share takes its team rows with it.
  await owner.rpc('delete_share', { p_share: s1 });
  assert.deepEqual(await sharedWith(ana), { [s2]: 'view' });
  assert.equal((await server.admin('select * from public.team_shares')).length, 2);

  // Deleting a team keeps access through the other team.
  await boss.rpc('admin_delete_team', { p_team: team });
  assert.deepEqual(await sharedWith(ana), { [s2]: 'view' });
  assert.equal((await server.admin('select * from public.team_members')).length, 2);

  // A user deleting their cloud data and sign-in.
  await bob.rpc('delete_my_cloud_data');
  assert.deepEqual(await boss.rpc('admin_team_members', { p_team: other }), [
    { id: ana.id, email: 'ana@acme.eu' },
  ]);
  assert.deepEqual(
    (await memberRows(server, s2)).map((r) => r.member_workspace),
    [ana.ws],
  );
  // A user deleted straight from auth.users (Authentication → Users).
  await server.admin('delete from auth.users where id = $1', [ana.id]);
  assert.deepEqual(await memberRows(server, s2), []);
  assert.deepEqual(await server.admin('select * from public.team_grants'), []);
  assert.deepEqual(await boss.rpc('admin_team_members', { p_team: other }), []);

  // The owner deleting everything, while a team still has the share.
  const cara = await person(server, 'cara@acme.eu');
  await boss.rpc('admin_set_team_member', { p_team: other, p_user: cara.id, p_in: true });
  assert.deepEqual(await sharedWith(cara), { [s2]: 'view' });
  await owner.rpc('delete_my_cloud_data');
  assert.deepEqual(await sharedWith(cara), {});
  assert.deepEqual(await server.admin('select * from public.team_shares'), []);
  assert.deepEqual(await server.admin('select * from public.team_grants'), []);
  // A team member's workspace deleted directly.
  const dan = await person(server, 'dan@acme.eu');
  const s3 = await shareBoard(cara, 'c1');
  await boss.rpc('admin_set_team_member', { p_team: other, p_user: dan.id, p_in: true });
  await cara.rpc('share_with_team', { p_share: s3, p_team: other, p_role: 'edit' });
  assert.deepEqual(await sharedWith(dan), { [s3]: 'edit' });
  await server.admin('delete from public.workspaces where id = $1', [dan.ws]);
  assert.deepEqual(await memberRows(server, s3), []);
  assert.deepEqual(await server.admin('select * from public.team_grants'), []);
});
