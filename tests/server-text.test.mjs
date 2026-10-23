import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serverDescription,
  switchWarning,
  unsentLoss,
  unsentText,
} from '../src/components/settings/server-text.ts';

test('serverDescription reads the way the Server row shows it', () => {
  const terra = { name: 'Terra Cloud', kind: 'terra', locked: false, address: null };
  assert.equal(serverDescription(terra), 'Terra Cloud');
  assert.equal(serverDescription(null), 'None');
  assert.equal(
    serverDescription({ name: 'Acme', kind: 'custom', locked: false, address: 'terra.acme.eu' }),
    'Acme · terra.acme.eu',
  );
  assert.equal(
    serverDescription({
      name: 'Acme',
      kind: 'custom',
      locked: true,
      address: 'https://terra.acme.eu/',
    }),
    'Acme · terra.acme.eu · Set by your organization.',
  );
  assert.equal(
    serverDescription({ name: 'Terra Cloud', kind: 'terra', locked: true, address: null }),
    'Terra Cloud · Set by your organization.',
  );
});

test('unsentText names the count and stays empty when nothing is waiting', () => {
  assert.equal(unsentText(0), '');
  assert.equal(unsentText(1), "1 change hasn't uploaded yet.");
  assert.equal(unsentText(12), "12 changes haven't uploaded yet.");
  assert.match(switchWarning, /^Switching servers signs you out and turns off sync on this computer\./);
});

test('unsentLoss says plainly what is lost and what stays', () => {
  assert.match(
    unsentLoss,
    /edits to boards other people shared with you that haven't uploaded are lost/,
  );
  assert.match(unsentLoss, /Your own boards and their edits stay on this computer\./);
});
