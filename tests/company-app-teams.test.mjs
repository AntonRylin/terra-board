// The app's roles and teams calls (electron/company.cjs) against the company migrations in
// PGlite, through a client shaped like supabase-js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { supabaseDb } from './supabase-db.mjs';
const require = createRequire(import.meta.url);
const { createCompany } = require('../electron/company.cjs');

const clientFor = (person) => ({
  rpc: async (name, args) => {
    try {
      return { data: await person.rpc(name, args), error: null };
    } catch (e) {
      const missing = /function .* does not exist/.test(e.message);
      return { data: null, error: { code: missing ? 'PGRST202' : e.code, message: e.message } };
    }
  },
});

// A person with a personal workspace holding one board.
async function withLibrary(server, email) {
  const person = await server.user({ email });
  const ws = await person.rpc('ensure_personal_workspace', { p_name: email.split('@')[0] });
  const workspace = ws?.workspace ?? ws;
  return { person, workspace, company: createCompany({ client: clientFor(person) }) };
}

test('status reports roles; admins set roles and the default', async () => {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('boss@acme.eu')");
  const boss = await withLibrary(server, 'boss@acme.eu');
  const anna = await withLibrary(server, 'anna@acme.eu');
  let status = await boss.company.status();
  assert.deepEqual(
    [status.role, status.defaultRole, status.sso, status.teams],
    ['admin', 'member', true, true],
  );
  await boss.company.setRole('anna@acme.eu', 'guest');
  assert.equal((await anna.company.status()).role, 'guest');
  const people = await boss.company.people();
  assert.equal(people.find((p) => p.email === 'anna@acme.eu').role, 'guest');
  await boss.company.setDefaultRole('guest');
  assert.equal((await boss.company.status()).defaultRole, 'guest');
  await boss.company.setSso(false);
  assert.equal((await boss.company.status()).sso, false);
  await assert.rejects(anna.company.setRole('boss@acme.eu', 'guest'), /Only a server admin/);
});

test('sharing a board with a team gives its members access, now and later', async () => {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('boss@acme.eu')");
  const boss = await withLibrary(server, 'boss@acme.eu');
  const owner = await withLibrary(server, 'owner@acme.eu');
  const ben = await withLibrary(server, 'ben@acme.eu');
  const cleo = await withLibrary(server, 'cleo@acme.eu');

  const team = await boss.company.createTeam('Marketing');
  await boss.company.setTeamMember(team, ben.person.id, true);
  assert.deepEqual(
    (await owner.company.teams()).map((t) => [t.name, t.members]),
    [['Marketing', 1]],
  );

  const share = await owner.person.rpc('create_share', {
    p_workspace: owner.workspace,
    p_kind: 'board',
    p_target: 'b1',
  });
  await owner.company.shareWithTeam(share, team, 'edit');
  assert.deepEqual(
    (await owner.company.shareTeams(share)).map((t) => [t.name, t.role, t.members]),
    [['Marketing', 'edit', 1]],
  );
  const sees = async (who) =>
    (await who.person.query('select * from public.shared_with_me()')).map((s) => s.role);
  assert.deepEqual(await sees(ben), ['edit']);
  assert.deepEqual(await sees(cleo), []);

  // Added later: access follows. Removed: it goes.
  await boss.company.setTeamMember(team, cleo.person.id, true);
  assert.deepEqual(await sees(cleo), ['edit']);
  await boss.company.setTeamMember(team, ben.person.id, false);
  assert.deepEqual(await sees(ben), []);

  // A guest in the team only views.
  await boss.company.setRole('cleo@acme.eu', 'guest');
  assert.deepEqual(await sees(cleo), ['view']);

  await owner.company.unshareTeam(share, team);
  assert.deepEqual(await sees(cleo), []);
  await boss.company.renameTeam(team, 'Brand');
  assert.equal((await boss.company.teams())[0].name, 'Brand');
  await assert.rejects(boss.company.createTeam('brand'), /already exists/);
  await boss.company.deleteTeam(team);
  assert.deepEqual(await boss.company.teams(), []);
});
