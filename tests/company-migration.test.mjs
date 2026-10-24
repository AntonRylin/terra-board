// The company server migration (ee/supabase/migrations) in PGlite: server admins, people,
// license key storage and the audit log. See tests/supabase-db.mjs for the Supabase stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { supabaseDb } from './supabase-db.mjs';

const eeFile = new URL('../ee/supabase/migrations/20261025090000_company.sql', import.meta.url);
const board = (id, extra = {}) => ({
  kind: 'board',
  board_id: '',
  id,
  data: { name: id, folderId: null, ...extra },
});
const object = (boardId, id) => ({ kind: 'object', board_id: boardId, id, data: { text: id } });

// A server whose setup named boss@acme.eu as the first admin, before that account existed.
async function companyServer() {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('Boss@Acme.eu')");
  const boss = await server.user({ email: 'boss@acme.eu' });
  return { server, boss };
}

const notAdmin = { code: '42501', message: /Only a server admin/ };
const actions = async (boss) => (await boss.rpc('admin_audit')).map((e) => e.action).reverse();
const clearLog = (server) => server.admin('delete from public.audit_events');

test('the migration runs again over itself', async () => {
  const { server } = await companyServer();
  await server.admin(fs.readFileSync(eeFile, 'utf8'));
  assert.equal((await server.admin('select * from public.company_settings')).length, 1);
  assert.deepEqual(await server.admin('select email from public.server_admins'), [
    { email: 'boss@acme.eu' },
  ]);
});

test('the first admin is set up by email before the account exists', async () => {
  const { boss } = await companyServer();
  assert.deepEqual(await boss.rpc('company_status'), {
    admin: true,
    license: null,
    people: 1,
    freePeople: 10,
    audit: true,
  });
});

test('everyone else is refused by every admin call', async () => {
  const { server } = await companyServer();
  const person = await server.user();
  assert.equal((await person.rpc('company_status')).admin, false);
  const calls = [
    ['admin_people', {}],
    ['admin_set_disabled', { p_user: person.id, p_disabled: true }],
    ['admin_set_admin', { p_email: person.email ?? 'x@example.com', p_admin: true }],
    ['admin_set_license', { p_key: null }],
    ['admin_set_audit', { p_on: false }],
    ['admin_audit', {}],
  ];
  for (const [name, args] of calls) await assert.rejects(person.rpc(name, args), notAdmin, name);
  // Nor can they read the tables directly.
  assert.deepEqual(await person.query('select * from public.audit_events'), []);
  await assert.rejects(person.query('select * from public.server_admins'), { code: '42501' });
  await assert.rejects(person.query('select * from public.company_settings'), { code: '42501' });
  await assert.rejects(person.query("insert into public.audit_events (action) values ('fake')"), {
    code: '42501',
  });
});

test('admin rights come from the account email, never the token or an anonymous user', async () => {
  const { server } = await companyServer();
  // A token claiming the admin email, for a user whose email is something else.
  const spoof = await server.user({ email: 'mallory@example.com' });
  spoof.email = 'boss@acme.eu';
  assert.equal((await spoof.rpc('company_status')).admin, false);
  await assert.rejects(spoof.rpc('admin_people'), notAdmin);
  // An anonymous user that somehow carries the admin email.
  const anon = await server.user({ anonymous: true });
  await server.admin("update auth.users set email = 'boss@acme.eu' where id = $1", [anon.id]);
  assert.equal((await anon.rpc('company_status')).admin, false);
  await assert.rejects(anon.rpc('admin_audit'), notAdmin);
});

test('company_status counts people, not anonymous computers or disabled accounts', async () => {
  const { server, boss } = await companyServer();
  await server.user({ anonymous: true });
  await server.user({ anonymous: true });
  const ana = await server.user({ email: 'ana@acme.eu' });
  const sam = await server.user({ email: 'sam@acme.eu' });
  assert.equal((await boss.rpc('company_status')).people, 3);
  await boss.rpc('admin_set_disabled', { p_user: sam.id, p_disabled: true });
  assert.equal((await ana.rpc('company_status')).people, 2);
  // A ban that has run out counts again.
  await server.admin(
    "update auth.users set banned_until = now() - interval '1 day' where id = $1",
    [sam.id],
  );
  assert.equal((await ana.rpc('company_status')).people, 3);
  const anon = await server.user({ anonymous: true });
  assert.equal((await anon.rpc('company_status')).people, 3, 'anonymous computers may ask too');
});

test('disabling ends the sessions, enabling clears it, and nobody disables themselves', async () => {
  const { server, boss } = await companyServer();
  const sam = await server.user({ email: 'sam@acme.eu' });
  await server.admin('insert into auth.sessions (id, user_id) values ($1, $2)', [
    randomUUID(),
    sam.id,
  ]);
  await clearLog(server);

  await boss.rpc('admin_set_disabled', { p_user: sam.id, p_disabled: true });
  const [banned] = await server.admin(
    "select banned_until > now() + interval '50 years' as far from auth.users where id = $1",
    [sam.id],
  );
  assert.equal(banned.far, true);
  assert.deepEqual(
    await server.admin('select 1 from auth.sessions where user_id = $1', [sam.id]),
    [],
  );
  assert.equal(
    (await server.admin('select 1 from auth.sessions where user_id = $1', [boss.id])).length,
    1,
    "the admin's own session stays",
  );
  let [listed] = await boss.rpc('admin_people', { p_search: 'sam' });
  assert.equal(listed.disabled, true);

  await boss.rpc('admin_set_disabled', { p_user: sam.id, p_disabled: false });
  const [cleared] = await server.admin('select banned_until from auth.users where id = $1', [
    sam.id,
  ]);
  assert.equal(cleared.banned_until, null);
  [listed] = await boss.rpc('admin_people', { p_search: 'sam' });
  assert.equal(listed.disabled, false);

  await assert.rejects(boss.rpc('admin_set_disabled', { p_user: boss.id, p_disabled: true }), {
    code: '22023',
    message: /your own account/,
  });
  await assert.rejects(boss.rpc('admin_set_disabled', { p_user: randomUUID(), p_disabled: true }), {
    message: /not on this server/,
  });
  const log = (await boss.rpc('admin_audit')).reverse();
  assert.deepEqual(
    log.map((e) => [e.action, e.target, e.details.email, e.actorEmail]),
    [
      ['person.disabled', sam.id, 'sam@acme.eu', 'boss@acme.eu'],
      ['person.enabled', sam.id, 'sam@acme.eu', 'boss@acme.eu'],
    ],
  );
});

test('a disabled admin is no admin until enabled again', async () => {
  const { server, boss } = await companyServer();
  const ana = await server.user({ email: 'ana@acme.eu' });
  await boss.rpc('admin_set_admin', { p_email: 'ana@acme.eu', p_admin: true });
  await boss.rpc('admin_set_disabled', { p_user: ana.id, p_disabled: true });
  assert.equal((await ana.rpc('company_status')).admin, false);
  await boss.rpc('admin_set_disabled', { p_user: ana.id, p_disabled: false });
  assert.equal((await ana.rpc('company_status')).admin, true);
});

test('admins are added and removed by email, and the last admin stays', async () => {
  const { server, boss } = await companyServer();
  await assert.rejects(boss.rpc('admin_set_admin', { p_email: 'boss@acme.eu', p_admin: false }), {
    code: '22023',
    message: /last admin/,
  });
  for (const bad of ['', 'nobody', 'a@b', 'two words@acme.eu', null])
    await assert.rejects(boss.rpc('admin_set_admin', { p_email: bad, p_admin: true }), {
      message: /valid email/,
    });

  // Someone who has not signed in yet does not keep the server administered.
  await boss.rpc('admin_set_admin', { p_email: '  New.Admin@Acme.eu ', p_admin: true });
  assert.deepEqual(
    (await server.admin('select email, added_by from public.server_admins order by email')).map(
      (r) => [r.email, r.added_by],
    ),
    [
      ['boss@acme.eu', null],
      ['new.admin@acme.eu', boss.id],
    ],
  );
  await assert.rejects(boss.rpc('admin_set_admin', { p_email: 'boss@acme.eu', p_admin: false }), {
    message: /last admin/,
  });

  const ana = await server.user({ email: 'new.admin@acme.eu' });
  assert.equal((await ana.rpc('company_status')).admin, true);
  const [listed] = await boss.rpc('admin_people', { p_search: 'new.admin' });
  assert.equal(listed.admin, true);
  // Now the boss may step down; ana may not then remove herself.
  await boss.rpc('admin_set_admin', { p_email: 'BOSS@acme.eu', p_admin: false });
  assert.equal((await boss.rpc('company_status')).admin, false);
  await assert.rejects(boss.rpc('admin_people'), notAdmin);
  await assert.rejects(
    ana.rpc('admin_set_admin', { p_email: 'new.admin@acme.eu', p_admin: false }),
    {
      message: /last admin/,
    },
  );
  // Removing someone who is not an admin is a no-op.
  await ana.rpc('admin_set_admin', { p_email: 'nobody@acme.eu', p_admin: false });
  assert.deepEqual(
    (await ana.rpc('admin_audit')).reverse().map((e) => [e.action, e.target]),
    [
      ['admin.added', 'new.admin@acme.eu'],
      ['admin.removed', 'boss@acme.eu'],
    ],
  );
});

test('the license key is stored, cleared, and refused when it is not shaped like one', async () => {
  const { server, boss } = await companyServer();
  const payload = Buffer.from(
    JSON.stringify({ v: 1, id: 'lic_1', customer: 'Acme GmbH', seats: 50, expires: '2027-10-24' }),
  ).toString('base64url');
  const key = `TBL1.${payload}.c2lnbmF0dXJl`;
  await boss.rpc('admin_set_license', { p_key: ` ${key} ` });
  const person = await server.user();
  assert.equal((await person.rpc('company_status')).license, key);

  for (const bad of [
    'TBL2.a.b',
    'TBL1.a',
    'TBL1.a.b.c',
    'TBL1.a+b.c',
    `TBL1.${'a'.repeat(4096)}.b`,
  ])
    await assert.rejects(boss.rpc('admin_set_license', { p_key: bad }), {
      code: '22023',
      message: /not a Terra Board license key/,
    });
  assert.equal((await boss.rpc('company_status')).license, key, 'a refused key changes nothing');

  await boss.rpc('admin_set_license', { p_key: '' });
  assert.equal((await boss.rpc('company_status')).license, null);
  await boss.rpc('admin_set_license', { p_key: key });
  await boss.rpc('admin_set_license', { p_key: null });
  assert.equal((await boss.rpc('company_status')).license, null);

  const log = (await boss.rpc('admin_audit'))
    .reverse()
    .filter((e) => e.action.startsWith('license'));
  assert.deepEqual(
    log.map((e) => e.action),
    ['license.set', 'license.cleared', 'license.set', 'license.cleared'],
  );
  assert.equal(log[0].target, 'lic_1');
  assert.deepEqual(log[0].details, {
    license: 'lic_1',
    customer: 'Acme GmbH',
    seats: 50,
    expires: '2027-10-24',
  });
  assert.ok(!JSON.stringify(log).includes(key), 'the key itself is never logged');
  // A key whose payload is not JSON is still stored (the app reports it as malformed).
  await boss.rpc('admin_set_license', { p_key: 'TBL1.bm90IGpzb24.sig' });
  assert.equal((await boss.rpc('company_status')).license, 'TBL1.bm90IGpzb24.sig');
});

test('shares, their people, boards, devices and accounts are recorded', async () => {
  const { server, boss } = await companyServer();
  const owner = await server.user({ email: 'owner@acme.eu' });
  const { workspace } = await owner.rpc('ensure_personal_workspace', { p_name: 'Owner' });
  const friend = await server.user({ email: 'friend@acme.eu' });
  const { workspace: friendWs } = await friend.rpc('ensure_personal_workspace', { p_name: 'Ana' });
  await clearLog(server);

  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1', { name: 'Plans' }), object('b1', 'n1')]),
  });
  // Editing a board again, or its objects, is not an event.
  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1', { name: 'Plans 2' }), object('b1', 'n2')]),
  });
  const share = await owner.rpc('create_share', {
    p_workspace: workspace,
    p_kind: 'board',
    p_target: 'b1',
  });
  // Sharing the same board again reuses the share.
  await owner.rpc('create_share', { p_workspace: workspace, p_kind: 'board', p_target: 'b1' });
  const code = await owner.rpc('create_share_invite', { p_share: share, p_role: 'view' });
  await friend.rpc('redeem_share_invite', { p_code: code, p_workspace: friendWs });
  await owner.rpc('set_share_role', { p_share: share, p_member: friendWs, p_role: 'edit' });
  await owner.rpc('set_share_role', { p_share: share, p_member: friendWs, p_role: 'edit' });
  await owner.rpc('remove_share_member', { p_share: share, p_member: friendWs });
  await owner.rpc('delete_share', { p_share: share });
  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([{ kind: 'board', board_id: '', id: 'b1', deleted: true }]),
  });
  const pc = randomUUID();
  await owner.rpc('register_device', { p_id: pc, p_name: 'PC', p_version: '0.2.0' });
  await owner.rpc('register_device', { p_id: pc, p_name: 'PC', p_version: '0.2.1' });
  await owner.rpc('revoke_device', { p_id: pc });
  const newcomer = await server.user({ email: 'new@acme.eu' });
  await newcomer.rpc('ensure_personal_workspace', { p_name: 'New' });

  const log = (await boss.rpc('admin_audit')).reverse();
  assert.deepEqual(
    log.map((e) => [e.action, e.target]),
    [
      ['board.created', 'b1'],
      ['share.created', share],
      ['share.member_added', share],
      ['share.member_role_changed', share],
      ['share.member_removed', share],
      ['share.deleted', share],
      ['board.deleted', 'b1'],
      ['device.added', pc],
      ['device.removed', pc],
      ['account.created', newcomer.id],
    ],
  );
  const at = (action) => log.find((e) => e.action === action);
  assert.equal(at('board.created').actor, owner.id);
  assert.equal(at('board.created').actorEmail, 'owner@acme.eu');
  assert.deepEqual(at('board.created').details, { workspace, name: 'Plans' });
  assert.deepEqual(at('board.deleted').details, { workspace, name: 'Plans 2' });
  assert.deepEqual(at('share.created').details, { workspace, kind: 'board', targetId: 'b1' });
  assert.deepEqual(at('share.member_added').details, {
    member: friendWs,
    role: 'view',
    memberName: 'Ana',
  });
  assert.equal(at('share.member_added').actor, friend.id, 'the person who joined');
  assert.deepEqual(at('share.member_role_changed').details, {
    member: friendWs,
    from: 'view',
    role: 'edit',
    memberName: 'Ana',
  });
  assert.deepEqual(at('device.added').details, {
    user: owner.id,
    email: 'owner@acme.eu',
    name: 'PC',
  });
  assert.deepEqual(at('account.created').details, { email: 'new@acme.eu' });
  assert.ok(log.every((e) => typeof e.id === 'number' && e.at));
});

test('deleting cloud data records the account, devices and shares going', async () => {
  const { server, boss } = await companyServer();
  const owner = await server.user({ email: 'owner@acme.eu' });
  const { workspace } = await owner.rpc('ensure_personal_workspace', { p_name: 'Owner' });
  await owner.rpc('create_share', { p_workspace: workspace, p_kind: 'board', p_target: 'b1' });
  await owner.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '1' });
  await clearLog(server);
  await owner.rpc('delete_my_cloud_data');
  assert.deepEqual((await actions(boss)).sort(), [
    'account.deleted',
    'device.removed',
    'share.deleted',
  ]);
});

test('with the audit log off nothing is recorded, except switching it', async () => {
  const { server, boss } = await companyServer();
  const owner = await server.user({ email: 'owner@acme.eu' });
  const { workspace } = await owner.rpc('ensure_personal_workspace', { p_name: 'Owner' });
  await clearLog(server);
  await assert.rejects(boss.rpc('admin_set_audit', { p_on: null }), { code: '22023' });

  await boss.rpc('admin_set_audit', { p_on: false });
  assert.equal((await owner.rpc('company_status')).audit, false);
  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1')]),
  });
  const share = await owner.rpc('create_share', {
    p_workspace: workspace,
    p_kind: 'board',
    p_target: 'b1',
  });
  await owner.rpc('delete_share', { p_share: share });
  await owner.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '1' });
  await server
    .user({ email: 'x@acme.eu' })
    .then((x) => x.rpc('ensure_personal_workspace', { p_name: 'X' }));
  await boss.rpc('admin_set_admin', { p_email: 'ana@acme.eu', p_admin: true });
  await boss.rpc('admin_set_license', { p_key: 'TBL1.a.b' });
  assert.deepEqual(await actions(boss), ['audit.off']);

  await boss.rpc('admin_set_audit', { p_on: true });
  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b2')]),
  });
  assert.deepEqual(await actions(boss), ['audit.off', 'audit.on', 'board.created']);
});

test('admin_audit pages backwards from the newest event', async () => {
  const { server, boss } = await companyServer();
  await clearLog(server);
  for (let i = 0; i < 7; i++)
    await server.admin(
      "insert into public.audit_events (action, target) values ('test.event', $1)",
      [String(i)],
    );
  const first = await boss.rpc('admin_audit', { p_limit: 3 });
  assert.deepEqual(
    first.map((e) => e.target),
    ['6', '5', '4'],
  );
  const second = await boss.rpc('admin_audit', { p_before: first.at(-1).id, p_limit: 3 });
  assert.deepEqual(
    second.map((e) => e.target),
    ['3', '2', '1'],
  );
  const last = await boss.rpc('admin_audit', { p_before: second.at(-1).id, p_limit: 3 });
  assert.deepEqual(
    last.map((e) => e.target),
    ['0'],
  );
  assert.deepEqual(await boss.rpc('admin_audit', { p_before: last[0].id }), []);
  assert.equal((await boss.rpc('admin_audit')).length, 7, 'default limit holds them all');
  assert.equal((await boss.rpc('admin_audit', { p_limit: 0 })).length, 1, 'limit is at least 1');
  // Admins can read the table directly as well, through its policy.
  assert.equal((await boss.query('select * from public.audit_events')).length, 7);
});

test('a broken audit log never stops the change it records', async () => {
  const { server, boss } = await companyServer();
  await server.admin(`
    create function public.refuse_audit() returns trigger language plpgsql as $$
    begin raise exception 'disk full' using errcode = '53100'; end $$;
    create trigger refuse before insert on public.audit_events
      for each row execute function public.refuse_audit();`);
  const owner = await server.user({ email: 'owner@acme.eu' });
  const { workspace } = await owner.rpc('ensure_personal_workspace', { p_name: 'Owner' });
  await owner.rpc('push_entities', {
    p_workspace: workspace,
    p_rows: JSON.stringify([board('b1')]),
  });
  const share = await owner.rpc('create_share', {
    p_workspace: workspace,
    p_kind: 'board',
    p_target: 'b1',
  });
  await owner.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '1' });
  await boss.rpc('admin_set_audit', { p_on: true });
  await boss.rpc('admin_set_admin', { p_email: 'ana@acme.eu', p_admin: true });
  assert.equal(
    (await server.admin('select 1 from public.shares where id = $1', [share])).length,
    1,
  );
  assert.equal((await server.admin("select 1 from public.entities where id = 'b1'")).length, 1);
  assert.equal((await server.admin('select 1 from public.devices')).length, 1);
  assert.equal((await server.admin('select 1 from public.server_admins')).length, 2);
  assert.deepEqual(await server.admin('select * from public.audit_events'), []);
});

test('admin_people lists accounts with devices and storage, searchable and paged', async () => {
  const { server, boss } = await companyServer();
  const ana = await server.user({ email: 'ana@acme.eu' });
  const { workspace } = await ana.rpc('ensure_personal_workspace', { p_name: 'Ana' });
  await ana.rpc('register_device', { p_id: randomUUID(), p_name: 'PC', p_version: '1' });
  const laptop = randomUUID();
  await ana.rpc('register_device', { p_id: laptop, p_name: 'Laptop', p_version: '1' });
  await ana.rpc('revoke_device', { p_id: laptop });
  await server.admin('update auth.users set last_sign_in_at = now() where id = $1', [ana.id]);
  const files = [
    [`${workspace}/${'a'.repeat(64)}`, { size: 1000, mimetype: 'image/png' }],
    [`${workspace}/${'b'.repeat(64)}`, { size: 2500 }],
    [`${workspace}/${'c'.repeat(64)}`, null],
    [`${workspace}/${'d'.repeat(64)}`, { size: 'oops' }],
  ];
  for (const [name, metadata] of files)
    await server.admin(
      "insert into storage.objects (bucket_id, name, metadata) values ('assets', $1, $2)",
      [name, metadata && JSON.stringify(metadata)],
    );
  // Someone else's media and other buckets don't count.
  const sam = await server.user({ email: 'sam@acme.eu' });
  const { workspace: samWs } = await sam.rpc('ensure_personal_workspace', { p_name: 'Sam' });
  await server.admin("insert into storage.buckets (id, name) values ('other', 'other')");
  await server.admin(
    "insert into storage.objects (bucket_id, name, metadata) values ('assets', $1, $3), ('other', $2, $3)",
    [`${samWs}/${'e'.repeat(64)}`, `${workspace}/${'f'.repeat(64)}`, JSON.stringify({ size: 7 })],
  );
  await server.user({ anonymous: true });
  await server.user({ email: 'zed_100%@acme.eu' });

  const everyone = await boss.rpc('admin_people');
  assert.deepEqual(
    everyone.map((p) => p.email),
    ['ana@acme.eu', 'boss@acme.eu', 'sam@acme.eu', 'zed_100%@acme.eu'],
    'sorted by email, anonymous computers left out',
  );
  const [a] = everyone;
  assert.equal(a.id, ana.id);
  assert.equal(a.devices, 1);
  assert.equal(a.storageBytes, 3500);
  assert.equal(a.admin, false);
  assert.equal(a.disabled, false);
  assert.ok(a.created && a.lastSignIn);
  assert.equal(everyone[1].admin, true);
  assert.equal(everyone[1].storageBytes, 0, 'no library yet');
  assert.equal(everyone[2].storageBytes, 7);

  assert.deepEqual(
    (await boss.rpc('admin_people', { p_search: 'SAM' })).map((p) => p.email),
    ['sam@acme.eu'],
  );
  assert.deepEqual(
    (await boss.rpc('admin_people', { p_search: '_100%' })).map((p) => p.email),
    ['zed_100%@acme.eu'],
    'wildcards are matched literally',
  );
  assert.deepEqual(await boss.rpc('admin_people', { p_search: '%x%' }), []);
  assert.deepEqual(
    (await boss.rpc('admin_people', { p_limit: 2, p_offset: 1 })).map((p) => p.email),
    ['boss@acme.eu', 'sam@acme.eu'],
  );
  assert.deepEqual(await boss.rpc('admin_people', { p_offset: 10 }), []);
});
