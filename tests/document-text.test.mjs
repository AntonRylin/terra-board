import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDocumentTitle } from '../src/canvas/document-files.ts';

test('finishing a title draft preserves text saved meanwhile and current geometry', () => {
  const draft = {
    id: 'file',
    type: 'document',
    assetId: 'old',
    text: 'notes.txt',
    documentBytes: 4,
    documentExcerpt: 'old',
    x: 0,
    y: 0,
    width: 320,
    height: 400,
    z: 1,
    bold: true,
  };
  const current = {
    ...draft,
    assetId: 'edited',
    documentBytes: 12,
    documentExcerpt: 'edited body',
    x: 50,
    width: 640,
  };
  const result = withDocumentTitle(current, draft, ' Board title ');
  assert.equal(result.assetId, 'edited');
  assert.equal(result.documentExcerpt, 'edited body');
  assert.equal(result.documentBytes, 12);
  assert.equal(result.x, 50);
  assert.equal(result.width, 640);
  assert.equal(result.text, 'notes.txt');
  assert.equal(result.documentTitle, 'Board title');
  assert.equal(result.bold, true);
});
import {
  documentKind,
  decodeDocumentText,
  encodeDocumentText,
  MAX_TEXT_BYTES,
} from '../src/canvas/document-files.ts';

test('preview classification distinguishes editable text from office attachments', () => {
  assert.equal(documentKind('REPORT.PDF', ''), 'pdf');
  assert.equal(documentKind('draft.docx', ''), 'docx');
  for (const name of ['readme.txt', 'README.md', 'notes.csv', 'events.log'])
    assert.equal(documentKind(name, ''), 'text');
  for (const name of ['legacy.doc', 'budget.xlsx', 'cloud.gdoc', 'cloud.gsheet', 'archive.zip'])
    assert.equal(documentKind(name, 'application/octet-stream'), 'file');
});

test('text editing preserves UTF-8 BOM, Unicode and Windows newlines', () => {
  const bytes = Buffer.from('\ufeffHello résumé 👋\r\nSecond line\r\n');
  const decoded = decodeDocumentText(bytes);
  assert.equal(decoded.text, 'Hello résumé 👋\nSecond line\n');
  assert.equal(decoded.encoding, 'utf-8');
  assert.equal(decoded.newline, '\r\n');
  assert.deepEqual(Buffer.from(encodeDocumentText(decoded.text, decoded)), bytes);
  assert.match(
    Buffer.from(encodeDocumentText(decoded.text + 'Edited', decoded)).toString(),
    /\r\nEdited$/,
  );
});

test('UTF-16 little and big endian documents and empty text roundtrip', () => {
  for (const encoding of ['utf-16le', 'utf-16be']) {
    const bytes = Buffer.from('\ufeffCafé 漢字\r\n', 'utf16le');
    if (encoding === 'utf-16be') bytes.swap16();
    const decoded = decodeDocumentText(bytes);
    assert.equal(decoded.encoding, encoding);
    assert.equal(decoded.text, 'Café 漢字\n');
    assert.deepEqual(Buffer.from(encodeDocumentText(decoded.text, decoded)), bytes);
  }
  assert.equal(decodeDocumentText(new Uint8Array()).text, '');
  assert.equal(encodeDocumentText('', decodeDocumentText(new Uint8Array())).length, 0);
});

test('binary and oversized text cannot be silently rewritten', () => {
  assert.throws(() => decodeDocumentText(Uint8Array.from([0xc3, 0x28])), /encoding/i);
  assert.throws(() => decodeDocumentText(Uint8Array.from([0, 1, 2])), /text/i);
  assert.throws(() => decodeDocumentText(new Uint8Array(MAX_TEXT_BYTES + 1)), /2 MB/);
  assert.throws(
    () =>
      encodeDocumentText('é'.repeat(MAX_TEXT_BYTES), {
        encoding: 'utf-8',
        bom: false,
        newline: '\n',
      }),
    /2 MB/,
  );
});
