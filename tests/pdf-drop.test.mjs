import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { worldToLocal, localToWorld } from '../src/canvas/transform.ts';
import { documentKind } from '../src/canvas/document-files.ts';
const exports = {};
const formats = {};
vm.runInNewContext(
  ts.transpileModule(
    readFileSync(new URL('../src/canvas/pdf-conversion-formats.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    },
  ).outputText,
  { exports: formats, require: () => ({ documentKind }) },
);
vm.runInNewContext(
  ts.transpileModule(readFileSync(new URL('../src/canvas/pdf-drop.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  {
    exports,
    require: (id) =>
      id === './transform'
        ? { worldToLocal }
        : id === './pdf-conversion-formats'
          ? formats
          : { documentKind },
  },
);
const { pdfComposerTargetAt, isPdfComposerInput } = exports;
const pdf = {
  id: 'pdf',
  type: 'document',
  assetId: 'a'.repeat(64),
  text: 'one.pdf',
  x: 100,
  y: 100,
  width: 200,
  height: 300,
  z: 1,
};
test('PDF drops respect rotation, occluding objects, excluded moving inputs and ordinary frames', () => {
  const rotated = { ...pdf, rotation: 35 };
  const point = localToWorld(rotated, { x: 30, y: 20 });
  assert.equal(pdfComposerTargetAt([rotated], point), rotated);
  assert.equal(pdfComposerTargetAt([rotated], point, new Set(['pdf'])), null);
  const cover = { ...rotated, type: 'image', id: 'cover', z: 2 };
  assert.equal(pdfComposerTargetAt([rotated, cover], point), null);
  assert.equal(pdfComposerTargetAt([rotated, { ...cover, type: 'frame' }], point), rotated);
  const composer = { ...cover, type: 'frame', pdfComposer: { sources: [], columns: [] } };
  assert.equal(pdfComposerTargetAt([rotated, composer], point), composer);
  assert.equal(isPdfComposerInput({ ...pdf, text: 'notes.txt' }), true);
  assert.equal(isPdfComposerInput({ ...pdf, text: 'old.doc' }), true);
  assert.equal(isPdfComposerInput({ ...pdf, text: 'unknown.bin' }), false);
  assert.equal(formats.needsOfficeConversion({ ...pdf, text: 'sheet.xlsx' }), true);
  assert.equal(
    formats.needsOfficeConversion({ ...pdf, text: 'sheet.xlsx', documentMime: 'application/pdf' }),
    false,
  );
});
