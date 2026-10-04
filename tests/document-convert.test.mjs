import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as files from '../src/canvas/document-files.ts';

const object = (text, patch = {}) => ({
  id: text,
  type: 'document',
  text,
  assetId: 'a'.repeat(64),
  documentTitle: 'Keep title',
  x: 10,
  y: 20,
  width: 320,
  height: 400,
  z: 1,
  ...patch,
});

function fixture(options = {}) {
  const prints = [],
    reads = [],
    exports = {};
  const context = {
    exports,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    Error,
    DOMException,
    Promise,
    window: options.browser
      ? {}
      : {
          canvas: {
            printDocument: async (args) => {
              prints.push(args);
              if (options.print) return options.print(args);
              return { id: 'b'.repeat(64), name: args.name, bytes: 2048, mime: 'application/pdf' };
            },
          },
        },
    require(name) {
      if (name === './document-files') return files;
      if (name === './document-preview')
        return {
          documentBytes: async (value, limit, signal) => {
            reads.push({ value, limit, signal });
            return (
              options.bytes ||
              new TextEncoder().encode(options.text ?? 'café 日本語 <b>plain</b> & symbols')
            );
          },
          docxHtml: async () =>
            '<!doctype html><html><head></head><body><section class="docx">Word contents</section></body></html>',
        };
      if (name === 'dompurify') return { default: { sanitize: (value) => value } };
      throw Error(`Unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/document-convert.ts', import.meta.url), 'utf8'),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      },
    ).outputText,
    context,
  );
  return { ...exports, prints, reads };
}

test('text conversion escapes markup, retains Unicode and original metadata, and references a new PDF', async () => {
  const f = fixture();
  const original = object('日本語.txt', {
    documentPreviewId: 'c'.repeat(64),
    documentPageCount: 6,
  });
  const before = structuredClone(original);
  const [converted] = await f.convertComposerInputs([original]);
  assert.deepEqual(original, before);
  assert.equal(converted.text, original.text);
  assert.equal(converted.documentTitle, original.documentTitle);
  assert.equal(converted.assetId, 'b'.repeat(64));
  assert.equal(converted.documentMime, 'application/pdf');
  assert.equal(converted.documentBytes, 2048);
  assert.equal(converted.documentPreviewId, undefined);
  assert.equal(converted.documentPageCount, undefined);
  assert.match(f.prints[0].html, /café 日本語 &lt;b&gt;plain&lt;\/b&gt; &amp; symbols/);
  assert.match(f.prints[0].html, /white-space:\s*pre-wrap/);
  assert.match(f.prints[0].html, /Content-Security-Policy/);
  assert.equal(f.prints[0].name, '日本語.pdf');
});

test('empty and UTF-16 text convert without replacing or losing the filename', async () => {
  for (const [bytes, content] of [
    [new Uint8Array(), ''],
    [new Uint8Array([255, 254, 233, 0, 10, 0]), 'é\n'],
  ]) {
    const f = fixture({ bytes });
    const [converted] = await f.convertComposerInputs([object('empty.txt')]);
    assert.equal(converted.text, 'empty.txt');
    assert.ok(f.prints[0].html.includes(content));
  }
});

test('DOCX conversion uses its rendered content plus print pagination styles', async () => {
  const f = fixture();
  await f.convertComposerInputs([object('Word.docx')]);
  assert.match(f.prints[0].html, /Word contents/);
  assert.match(f.prints[0].html, /@page/);
  assert.match(f.prints[0].html, /break-after:\s*page/);
  assert.equal(f.reads[0].limit, files.MAX_PREVIEW_BYTES);
});

test('PDF MIME takes precedence over the retained original filename; PDF and images pass through', async () => {
  const f = fixture();
  const pdf = object('original.docx', { documentMime: 'application/pdf' });
  const image = object('photo.webp', { type: 'image' });
  const result = await f.convertComposerInputs([pdf, image]);
  assert.equal(result[0], pdf);
  assert.equal(result[1], image);
  assert.equal(f.prints.length, 0);
  assert.equal(f.reads.length, 0);
});

test('unsupported files, browser-only conversion, and pre-aborted requests do not create assets', async () => {
  const f = fixture();
  await assert.rejects(
    f.convertComposerInputs([object('notes.txt'), object('legacy.doc')]),
    /not supported|cannot.*convert/i,
  );
  assert.equal(f.prints.length, 0);
  const browser = fixture({ browser: true });
  await assert.rejects(browser.convertComposerInputs([object('notes.txt')]), /desktop/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.convertComposerInputs([object('notes.txt')], controller.signal), {
    name: 'AbortError',
  });
  assert.equal(f.reads.length, 0);
});

test('aborting a native conversion discards the late result and does not convert the next file', async () => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture({
    print: () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = f.convertComposerInputs(
    [object('one.txt'), object('two.txt')],
    controller.signal,
  );
  await ready;
  controller.abort();
  finish({ id: 'b'.repeat(64), bytes: 2048 });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.prints.length, 1);
});
