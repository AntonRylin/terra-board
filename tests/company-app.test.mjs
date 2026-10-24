// The app's server-admin module (electron/company.cjs) against the company migration in
// PGlite, through a client shaped like supabase-js. License keys are signed with a throwaway
// key, which the module is told to trust through a stubbed license check.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { supabaseDb } from './supabase-db.mjs';
const require = createRequire(import.meta.url);
const license = require('../electron/license.cjs');

// Trust a test signer: verifyLicense reads PUBLIC_KEYS by default.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
license.PUBLIC_KEYS.push(
  publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64url'),
);
const { createCompany, auditCsv } = require('../electron/company.cjs');

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `TBL1.${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
};
const key = (extra = {}) =>
  sign({ v: 1, id: 'lic_t', customer: 'Acme GmbH', seats: 25, expires: '2099-12-31', ...extra });

// supabase-js's rpc(): { data, error } with PostgREST-like error codes.
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

async function setup() {
  const server = await supabaseDb({ ee: true });
  await server.admin("insert into public.server_admins (email) values ('boss@acme.eu')");
  const boss = await server.user({ email: 'boss@acme.eu' });
  const hosts = ['terra.acme.eu'];
  return { server, boss, company: createCompany({ client: clientFor(boss), hosts }), hosts };
}

test('a plain server without ee/ has no company status', async () => {
  const server = await supabaseDb();
  const someone = await server.user({ email: 'a@b.eu' });
  assert.equal(await createCompany({ client: clientFor(someone) }).status(), null);
});

test('the status counts people and checks the stored license key', async () => {
  const { server, company } = await setup();
  for (let i = 0; i < 11; i++) await server.user({ email: `p${i}@acme.eu` });
  let status = await company.status();
  assert.equal(status.admin, true);
  assert.equal(status.people, 12);
  assert.equal(status.license, null);
  assert.match(status.summary.note, /Free self-hosting covers 10 people; this server has 12/);

  await company.setLicense(key({ servers: ['terra.acme.eu'] }));
  status = await company.status();
  assert.equal(status.license.state, 'valid');
  assert.equal(status.license.customer, 'Acme GmbH');
  assert.equal(status.summary.note, null);

  // A key for another server, or a forged one, is refused before it replaces the good key.
  await assert.rejects(company.setLicense(key({ servers: ['other.eu'] })), /not this server/);
  await assert.rejects(company.setLicense('TBL1.abc.def'), /not a valid/);
  assert.equal((await company.status()).license.state, 'valid');

  await company.setLicense(null);
  assert.equal((await company.status()).license, null);
});

test('people, admins, disabling and the audit log work end to end', async () => {
  const { server, boss, company } = await setup();
  const worker = await server.user({ email: 'worker@acme.eu' });
  const people = await company.people();
  assert.deepEqual(
    people.map((p) => [p.email, p.admin, p.disabled]),
    [
      ['boss@acme.eu', true, false],
      ['worker@acme.eu', false, false],
    ],
  );
  await company.setDisabled(worker.id, true);
  assert.equal((await company.people({ search: 'work' }))[0].disabled, true);
  await assert.rejects(company.setDisabled(boss.id, true), /own account/);
  await company.setAdmin('New.Admin@Acme.eu', true);
  await assert.rejects(company.setAdmin('boss@acme.eu', false), /last admin/);

  const log = await company.audit();
  assert.deepEqual(
    log.map((e) => e.action),
    ['admin.added', 'person.disabled'],
  );
  assert.equal(log[1].actorEmail, 'boss@acme.eu');

  // The worker isn't an admin: every admin call is refused with a plain message.
  const other = createCompany({ client: clientFor(worker) });
  await assert.rejects(other.people(), /Only a server admin/);
});

test('the CSV export quotes text and defuses spreadsheet formulas', () => {
  const csv = auditCsv([
    {
      at: '2026-10-24T10:00:00Z',
      actorEmail: 'a@b.eu',
      action: 'board.created',
      target: 'b1',
      details: { name: '=HYPERLINK("x")' },
    },
    { at: '2026-10-24T10:01:00Z', actorEmail: null, action: 'audit.on', target: null, details: {} },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'time,person,action,target,details');
  assert.match(
    lines[1],
    /^2026-10-24T10:00:00Z,a@b\.eu,board\.created,b1,"\{""name"":""=HYPERLINK/,
  );
  assert.equal(lines[2], '2026-10-24T10:01:00Z,,audit.on,,{}');
  assert.equal(
    auditCsv([{ at: '', actorEmail: '=cmd', action: 'x', target: '', details: {} }])
      .split('\r\n')[1]
      .startsWith(",'=cmd"),
    true,
  );
});
