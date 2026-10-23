import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SCHEME, parseDeepLink, findDeepLink } = require('../electron/deep-link.cjs');

test('parseDeepLink reads a connect link', () => {
  assert.equal(SCHEME, 'terraboard');
  assert.deepEqual(parseDeepLink('terraboard://connect?address=terra.acme.eu'), {
    kind: 'connect',
    address: 'https://terra.acme.eu',
  });
  assert.deepEqual(parseDeepLink('TERRABOARD://connect/?address=https%3A%2F%2Fterra.acme.eu'), {
    kind: 'connect',
    address: 'https://terra.acme.eu',
  });
});

test('parseDeepLink rejects unsafe addresses', () => {
  for (const link of [
    'terraboard://connect?address=terra.acme.eu/../x',
    'terraboard://connect?address=user@terra.acme.eu',
    'terraboard://connect?address=javascript:alert(1)',
    'terraboard://connect?address=' + 'a'.repeat(5000),
    'terraboard://connect?address=terra.acme.eu&address=other.eu',
    'terraboard://connect',
    'terraboard://other?address=terra.acme.eu',
    'https://terra.acme.eu',
  ]) {
    assert.equal(parseDeepLink(link), null, link);
  }
});

test('parseDeepLink ignores non-string input and other routes', () => {
  assert.equal(parseDeepLink(undefined), null);
  assert.equal(parseDeepLink(42), null);
  assert.equal(parseDeepLink('terraboard://auth/callback?code=x'), null, 'code too short');
  assert.equal(parseDeepLink('terraboard://billing/done'), null);
  assert.equal(parseDeepLink('terraboard://connect/extra?address=terra.acme.eu'), null);
});

test('findDeepLink picks the link out of Windows argv', () => {
  const link = 'terraboard://connect?address=a.eu';
  assert.equal(findDeepLink(['C:\Terra Board.exe', '--flag', link]), link);
  assert.equal(findDeepLink(['x.exe']), null);
  assert.equal(findDeepLink(['x.exe', 'TerraBoard://connect?address=a.eu'])?.length, link.length);
});

test('parseDeepLink reads the sign-in callback', () => {
  const url = 'terraboard://auth/callback?code=4a1f0c2e-8d7b-4e43-9a51-0d6b2d9f4f11';
  assert.deepEqual(parseDeepLink(url), {
    kind: 'auth',
    url,
    code: '4a1f0c2e-8d7b-4e43-9a51-0d6b2d9f4f11',
  });
  assert.deepEqual(
    parseDeepLink('terraboard://auth/callback#error=access_denied&error_description=No'),
    {
      kind: 'auth',
      url: 'terraboard://auth/callback#error=access_denied&error_description=No',
      error: 'access_denied',
    },
  );
  for (const link of [
    'terraboard://auth/other?code=4a1f0c2e8d7b',
    'terraboard://auth/callback',
    'terraboard://auth/callback?code=has spaces in it',
    'terraboard://auth/callback?code=4a1f0c2e8d7b&code=5b2f0c2e8d7b',
    'terraboard://user@auth/callback?code=4a1f0c2e8d7b',
  ])
    assert.equal(parseDeepLink(link), null, link);
});
