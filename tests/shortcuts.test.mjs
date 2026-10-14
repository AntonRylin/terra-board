import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingFromEvent,
  bindingKeys,
  formatBinding,
  matchesEvent,
  reservedReason,
  sameBinding,
} from '../src/shortcuts/keys.ts';
import {
  bindingsFor,
  cleanOverrides,
  commandForEvent,
  commands,
  conflictFor,
} from '../src/shortcuts/commands.ts';

const event = (code, mods = {}) => ({
  code,
  key: code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

test('bindings come from physical keys so any keyboard layout works', () => {
  // A Russian layout reports key "м" for the V key; the code stays KeyV.
  const binding = bindingFromEvent({ ...event('KeyV'), key: 'м' });
  assert.deepEqual(binding, { code: 'KeyV' });
  assert.equal(formatBinding(binding), 'V');
  assert.ok(matchesEvent(binding, { ...event('KeyV'), key: 'м' }));
});

test('modifiers match exactly and Meta counts as Ctrl', () => {
  const redo = { code: 'KeyZ', ctrl: true, shift: true };
  assert.ok(matchesEvent(redo, event('KeyZ', { ctrlKey: true, shiftKey: true })));
  assert.ok(matchesEvent(redo, event('KeyZ', { metaKey: true, shiftKey: true })));
  assert.ok(!matchesEvent(redo, event('KeyZ', { ctrlKey: true })));
  assert.ok(!matchesEvent({ code: 'KeyV' }, event('KeyV', { shiftKey: true })));
  assert.deepEqual(bindingKeys(redo), ['Ctrl', 'Shift', 'Z']);
  assert.equal(formatBinding({ code: 'Digit0' }), '0');
  assert.equal(formatBinding({ code: 'Comma', ctrl: true }), 'Ctrl+,');
});

test('lone modifiers and unidentified keys do not form a binding', () => {
  assert.equal(bindingFromEvent(event('ShiftLeft', { shiftKey: true })), null);
  assert.equal(bindingFromEvent(event('ControlRight', { ctrlKey: true })), null);
  assert.equal(bindingFromEvent(event('')), null);
  assert.ok(sameBinding({ code: 'KeyA', ctrl: true }, { code: 'KeyA', ctrl: true, shift: false }));
});

test('navigation, clipboard and window keys are reserved', () => {
  for (const binding of [
    { code: 'Escape' },
    { code: 'Enter', ctrl: true },
    { code: 'ArrowLeft' },
    { code: 'Space' },
    { code: 'Tab', shift: true },
    { code: 'KeyC', ctrl: true },
    { code: 'KeyV', ctrl: true },
    { code: 'F4', alt: true },
  ])
    assert.ok(reservedReason(binding, 'board'), formatBinding(binding));
  assert.equal(reservedReason({ code: 'Tab' }, 'board'), null);
  assert.equal(reservedReason({ code: 'KeyQ' }, 'board'), null);
  // App-wide commands also fire while typing, so plain letters are refused.
  assert.ok(reservedReason({ code: 'KeyQ' }, 'app'));
  assert.equal(reservedReason({ code: 'KeyQ', ctrl: true }, 'app'), null);
  assert.equal(reservedReason({ code: 'F9' }, 'app'), null);
});

test('commands have unique ids and conflict-free defaults', () => {
  const ids = new Set(commands.map((c) => c.id));
  assert.equal(ids.size, commands.length);
  const seen = new Map();
  for (const c of commands)
    for (const b of c.defaults) {
      const key = formatBinding(b);
      assert.ok(!seen.has(key), `${key} used by ${seen.get(key)} and ${c.id}`);
      seen.set(key, c.id);
      assert.equal(reservedReason(b, c.scope), null, `${c.id} default ${key} is reserved`);
    }
});

test('overrides replace defaults and lookups respect scope', () => {
  const overrides = { 'tool.text': [{ code: 'KeyQ' }] };
  assert.deepEqual(bindingsFor('tool.text', overrides), [{ code: 'KeyQ' }]);
  assert.equal(commandForEvent(event('KeyQ'), 'board', overrides), 'tool.text');
  assert.equal(commandForEvent(event('KeyT'), 'board', overrides), null);
  assert.equal(commandForEvent(event('KeyV'), 'board', {}), 'tool.select');
  assert.equal(commandForEvent(event('KeyV'), 'app', {}), null);
  assert.equal(commandForEvent(event('KeyF', { ctrlKey: true }), 'app', {}), 'app.search');
  assert.equal(commandForEvent(event('KeyY', { ctrlKey: true }), 'board', {}), 'edit.redo');
  // An empty list unbinds a command.
  assert.equal(commandForEvent(event('KeyV'), 'board', { 'tool.select': [] }), null);
});

test('conflicts name the other command', () => {
  assert.equal(conflictFor({ code: 'KeyD', ctrl: true }, {}, 'tool.text')?.id, 'edit.duplicate');
  assert.equal(conflictFor({ code: 'KeyD', ctrl: true }, {}, 'edit.duplicate'), null);
  assert.equal(conflictFor({ code: 'KeyT' }, { 'tool.text': [] }, 'tool.select'), null);
});

test('stored overrides are cleaned', () => {
  assert.deepEqual(cleanOverrides(null), {});
  assert.deepEqual(
    cleanOverrides({
      'tool.text': [{ code: 'KeyQ' }, { code: 'KeyW', ctrl: 'yes' }, { code: 7 }],
      'tool.unknown': [{ code: 'KeyP' }],
      'edit.undo': 'Ctrl+Z',
      'tool.note': [{ code: 'KeyA' }, { code: 'KeyB' }, { code: 'KeyC' }],
    }),
    {
      'tool.text': [{ code: 'KeyQ' }, { code: 'KeyW' }],
      'tool.note': [{ code: 'KeyA' }, { code: 'KeyB' }],
    },
  );
});
