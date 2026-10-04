import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, readThemePreference, nightInk } from '../src/appearance.ts';
import { nightScene } from '../src/canvas/night-scene.ts';

test('system follows the OS while explicit preferences remain stable', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  for (const invalid of [null, '', 'auto', 'undefined'])
    assert.equal(readThemePreference(invalid), 'system');
});

test('night ink keeps dark custom text readable without changing saved colors', () => {
  const object = { type: 'text', color: '#29313b' };
  assert.equal(nightInk(object, object.color), '#e4eaf2');
  assert.equal(nightInk({ type: 'text', color: '#ffcc66' }, '#ffcc66'), '#ffcc66');
  assert.equal(object.color, '#29313b');
  assert.equal(nightInk({ type: 'note' }, '#434e5d'), '#e4eaf2');
});

const note = (id, x, color = '#f8efd4') => ({
  id,
  type: 'note',
  x,
  y: 100,
  width: 160,
  height: 160,
  color,
  z: 0,
});
const camera = { x: 0, y: 0, zoom: 1 };
test('only colored notes and shapes emit, including light spilling in from offscreen', () => {
  const scene = nightScene(
    [
      note('warm', 100),
      note('white', 300, '#ffffff'),
      { ...note('text', 500), type: 'text' },
      note('edge', -200),
      note('far', -2000),
    ],
    camera,
    1000,
    700,
  );
  assert.deepEqual(scene.lights.map((l) => l.id).sort(), ['edge', 'warm']);
  assert.ok(scene.lights.every((l) => l.radius > 160 && l.radius <= 600));
});

test('lighting follows pan and zoom, budgets crowded boards, and casts shadows away from light', () => {
  const objects = [
    note('light', 100),
    { ...note('card', 360, '#ffffff'), type: 'image', rotation: 30 },
  ];
  const scene = nightScene(objects, camera, 1000, 700);
  const moved = nightScene(objects, { x: 40, y: 20, zoom: 2 }, 1600, 1000);
  assert.equal(moved.lights[0].x, scene.lights[0].x * 2 + 40);
  assert.equal(moved.lights[0].y, scene.lights[0].y * 2 + 20);
  assert.ok(scene.shadows.find((s) => s.id === 'card').dx > 0);
  assert.equal(scene.shadows.find((s) => s.id === 'card').rotation, Math.PI / 6);
  const crowded = nightScene(
    Array.from({ length: 1000 }, (_, i) => note(String(i), i % 700)),
    camera,
    1000,
    700,
  );
  assert.ok(crowded.lights.length <= 24);
  assert.ok(crowded.shadows.length <= 100);
});
