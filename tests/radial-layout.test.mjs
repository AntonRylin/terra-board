import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const exports = {};
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(new URL('../src/components/radial-layout.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText,
  { exports, require: () => require('../src/components/toolbar-layout.ts') },
);
const { defaultRadialLayout, radialSlot, readRadialLayout } = exports;

test('radial gestures have a neutral center, arrow on the left and a clear customization corridor', () => {
  assert.equal(radialSlot(0, 0), null);
  assert.equal(radialSlot(-71, 0), null);
  assert.equal(defaultRadialLayout()[radialSlot(-100, 0)], 'arrow');
  assert.equal(defaultRadialLayout()[radialSlot(0, -100)], 'text');
  assert.equal(defaultRadialLayout()[radialSlot(100, 0)], 'rect');
  assert.equal(radialSlot(0, 160), null);
  assert.equal(radialSlot(20, 100), null);
});

test('saved slots preserve their direction and recover independently from malformed preferences', () => {
  const layout = defaultRadialLayout();
  layout[5] = 'list';
  assert.equal(readRadialLayout(JSON.parse(JSON.stringify(layout)))[5], 'list');
  layout[0] = 'unknown';
  assert.equal(readRadialLayout(layout)[0], 'text');
  assert.equal(readRadialLayout(layout)[5], 'list');
  for (const value of [null, {}, [], ['arrow'], 'oops']) {
    assert.equal(JSON.stringify(readRadialLayout(value)), JSON.stringify(defaultRadialLayout()));
  }
});
