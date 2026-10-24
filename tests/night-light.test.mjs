import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { withState, isOn, known } = createRequire(import.meta.url)('../electron/night-light.cjs');

// Night light off, as Windows 11 (build 26300) stored it.
const off = Buffer.from(
  '434201000a0201002a0690a485d6062a2b0e1343420100d00a02c614df9f86a2a3edd4ee0100000000',
  'hex',
);

test('Night light: turning on adds the flag and a newer time', () => {
  assert.equal(known(off), true);
  assert.equal(isOn(off), false);
  const on = withState(off, true, 1800000000);
  assert.equal(isOn(on), true);
  assert.equal(on.length, off.length + 2);
  assert.equal(
    on.toString('hex'),
    '434201000a0201002a0680a4a7da062a2b0e15434201001000d00a02c614df9f86a2a3edd4ee0100000000',
  );
});

test('Night light: turning off restores the layout; time never goes back', () => {
  const on = withState(off, true, 1800000000);
  const back = withState(on, false, 1);
  assert.equal(isOn(back), false);
  assert.deepEqual(back.subarray(15), off.subarray(15));
  assert.notDeepEqual(back.subarray(10, 15), on.subarray(10, 15));
});

test('Night light: an unknown layout is never written', () => {
  const odd = Buffer.from(off);
  odd[18] = 0x17;
  assert.equal(withState(odd, true), null);
  assert.equal(withState(Buffer.alloc(10), true), null);
});
