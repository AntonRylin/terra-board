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
  assert.deepEqual(
    parseDeepLink('TERRABOARD://connect/?address=https%3A%2F%2Fterra.acme.eu'),
    { kind: 'connect', address: 'https://terra.acme.eu' },
  );
});

test('parseDeepLink rejects unsafe addresses', () => {
  for (const link of [
    'terraboard://connect?address=terra.acme.eu/../x',
    'terraboard://connect?address=user@terra.acme.eu',
    'terraboard://connect?address=javascript:alert(1)',
    'terraboard://connect?address=' + 'a'.repeat(5000),
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
  assert.equal(parseDeepLink('terraboard://auth/callback?code=x'), null);
  assert.equal(parseDeepLink('terraboard://billing/done'), null);
  assert.equal(parseDeepLink('terraboard://connect/extra?address=terra.acme.eu'), null);
});

test('findDeepLink picks the link out of Windows argv', () => {
  const link = 'terraboard://connect?address=a.eu';
  assert.equal(findDeepLink(['C:\Terra Board.exe', '--flag', link]), link);
  assert.equal(findDeepLink(['x.exe']), null);
  assert.equal(findDeepLink(['x.exe', 'TerraBoard://connect?address=a.eu'])?.length, link.length);
});
