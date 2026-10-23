// share_board (electron/mcp-tools.cjs): AI tools can create an invite code for a board or folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { tools } = require('../electron/mcp-tools.cjs');

const library = {
  boards: [
    { id: 'b1', name: 'Vertragsrecht' },
    { id: 'old', name: 'Old', trashed: true },
  ],
  folders: [{ id: 'f1', name: 'Law' }],
};
const call = async (command) => {
  if (command === 'library') return library;
  throw Error('unexpected ' + command);
};
const share = (services) => tools(call, services).find((t) => t.name === 'share_board');

test('share_board creates an invite for a board and says how to join', async () => {
  const asked = [];
  const tool = share({ cloud: () => ({ invite: async (...a) => (asked.push(a), 'SABCDE1234') }) });
  assert.equal(tool.change, 'cloud');
  const result = JSON.parse(
    (await tool.run({ id: 'b1', kind: 'board', role: 'edit' })).content[0].text,
  );
  assert.deepEqual(asked, [['board', 'b1', 'edit']]);
  assert.equal(result.code, 'SABCDE1234');
  assert.equal(result.name, 'Vertragsrecht');
  assert.match(result.join, /Join with a code/);
});

test('share_board shares folders, view only when asked', async () => {
  const asked = [];
  const tool = share({ cloud: () => ({ invite: async (...a) => (asked.push(a), 'S1') }) });
  await tool.run({ id: 'f1', kind: 'folder', role: 'view' });
  assert.deepEqual(asked, [['folder', 'f1', 'view']]);
});

test('share_board refuses unknown or trashed boards and builds without cloud', async () => {
  const tool = share({ cloud: () => ({ invite: async () => assert.fail('no invite') }) });
  await assert.rejects(tool.run({ id: 'nope', kind: 'board', role: 'edit' }), /No board/);
  await assert.rejects(tool.run({ id: 'old', kind: 'board', role: 'edit' }), /No board/);
  await assert.rejects(share({}).run({ id: 'b1', kind: 'board', role: 'edit' }), /not available/);
});
