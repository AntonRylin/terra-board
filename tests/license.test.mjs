// License keys for self-hosted servers (electron/license.cjs). Signed here with a throwaway
// key; the real signing key never leaves the seller's computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseLicense,
  verifyLicense,
  licenseSummary,
  PUBLIC_KEYS,
} = require('../electron/license.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const testKey = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(12)
  .toString('base64url');
const other = crypto.generateKeyPairSync('ed25519');

function sign(payload, key = privateKey) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `TBL1.${body}.${crypto.sign(null, Buffer.from(body), key).toString('base64url')}`;
}
const base = {
  v: 1,
  id: 'lic_1',
  customer: 'Acme GmbH',
  seats: 50,
  issued: '2026-10-24',
  expires: '2027-10-23',
};
const at = (date) => Date.parse(date + 'T12:00:00Z');
const check = (key, opts = {}) => verifyLicense(key, { publicKeys: [testKey], ...opts });

test('the app carries the real public key', () => {
  assert.equal(PUBLIC_KEYS.length >= 1, true);
  for (const k of PUBLIC_KEYS) assert.equal(Buffer.from(k, 'base64url').length, 32);
});

test('a signed key is valid until the end of its last day', async () => {
  const key = sign(base);
  const ok = await check(key, { now: at('2027-10-23') });
  assert.equal(ok.state, 'valid');
  assert.equal(ok.customer, 'Acme GmbH');
  assert.equal(ok.seats, 50);
  assert.equal(ok.daysLeft, 1);
  assert.match(ok.message, /Licensed to Acme GmbH for 50 people until 2027-10-23/);
});

test('an expired key has a 30-day grace period, then stops counting', async () => {
  const key = sign(base);
  assert.equal((await check(key, { now: at('2027-11-01') })).state, 'grace');
  assert.equal((await check(key, { now: at('2027-12-30') })).state, 'expired');
});

test('a wrong signature, another signer or a changed payload is invalid', async () => {
  assert.equal((await check(sign(base, other.privateKey))).state, 'invalid');
  const [prefix, , sig] = sign(base).split('.');
  const forged = Buffer.from(JSON.stringify({ ...base, seats: 5000 })).toString('base64url');
  assert.equal((await check(`${prefix}.${forged}.${sig}`)).state, 'invalid');
  // The real key list doesn't accept the test signer.
  assert.equal((await verifyLicense(sign(base))).state, 'invalid');
});

test('malformed keys are rejected without throwing', async () => {
  for (const key of [null, '', 'hello', 'TBL1.abc', 'TBL2.a.b', 'TBL1.@@.##', 'x'.repeat(5000)])
    assert.equal((await check(key)).state, 'invalid');
  assert.equal(parseLicense(sign({ ...base, seats: 0 })), null);
  assert.equal(parseLicense(sign({ ...base, expires: 'soon' })), null);
  assert.equal(parseLicense(sign({ ...base, v: 2 })), null);
});

test('a key can be tied to servers, with wildcards', async () => {
  const key = sign({ ...base, servers: ['terra.acme.eu', '*.acme.at'] });
  const now = at('2027-01-01');
  assert.equal((await check(key, { now, hosts: ['https://terra.acme.eu'] })).state, 'valid');
  assert.equal((await check(key, { now, hosts: ['boards.acme.at'] })).state, 'valid');
  assert.equal((await check(key, { now, hosts: ['acme.at'] })).state, 'server');
  assert.equal((await check(key, { now, hosts: ['terra.other.eu'] })).state, 'server');
  assert.equal((await check(key, { now, hosts: [] })).state, 'server');
  // Without servers, any server is fine.
  assert.equal((await check(sign(base), { now, hosts: ['x.example'] })).state, 'valid');
});

test('the summary says when a server is over its limit', () => {
  assert.equal(licenseSummary({ people: 7 }).note, null);
  const free = licenseSummary({ people: 14 });
  assert.equal(free.over, true);
  assert.match(free.note, /Free self-hosting covers 10 people; this server has 14/);
  const licensed = licenseSummary({ people: 14, license: { state: 'valid', seats: 50 } });
  assert.deepEqual([licensed.licensed, licensed.over, licensed.note], [true, false, null]);
  const full = licenseSummary({ people: 60, license: { state: 'valid', seats: 50 } });
  assert.match(full.note, /license covers 50/);
  const expired = licenseSummary({ people: 14, license: { state: 'expired', seats: 50 } });
  assert.equal(expired.licensed, false);
  assert.equal(expired.over, true);
});
