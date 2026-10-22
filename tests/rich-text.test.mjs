import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStyle,
  commonStyle,
  rebaseMarks,
  sanitizeMarks,
  spoilerRegions,
  styleRuns,
  trimTrailingBreaks,
  withoutTrailingBreaks,
} from '../src/canvas/rich-text.ts';

test('titles lose trailing line breaks but keep inner ones and their styles', () => {
  assert.deepEqual(trimTrailingBreaks('Plan\nQ3\n\r\n', [{ start: 5, end: 10, bold: true }]), {
    text: 'Plan\nQ3',
    marks: [{ start: 5, end: 7, bold: true }],
  });
  assert.deepEqual(trimTrailingBreaks('  Plan  '), { text: '  Plan  ', marks: [] });
  // A blank last line that only holds spaces is still an empty row.
  assert.deepEqual(trimTrailingBreaks('Title\n  '), { text: 'Title', marks: [] });
});

test('board text drops a trailing empty line and keeps its styles in range', () => {
  const text = { id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, z: 1 };
  assert.deepEqual(
    withoutTrailingBreaks({ ...text, text: 'Title\n', textMarks: [{ start: 0, end: 6, bold: true }] }),
    { ...text, text: 'Title', textMarks: [{ start: 0, end: 5, bold: true }] },
  );
  assert.deepEqual(withoutTrailingBreaks({ ...text, text: 'Title\n', textMarks: [{ start: 5, end: 6, bold: true }] }), {
    ...text,
    text: 'Title',
  });
  const plain = { ...text, text: 'Two\nlines' };
  assert.equal(withoutTrailingBreaks(plain), plain);
});

test('styles split, merge and toggle across ranges', () => {
  let marks = applyStyle(11, [], 0, 5, { bold: true });
  marks = applyStyle(11, marks, 3, 8, { bold: true, color: '#e5484d' });
  assert.deepEqual(marks, [
    { start: 0, end: 3, bold: true },
    { start: 3, end: 8, bold: true, color: '#e5484d' },
  ]);
  assert.deepEqual(commonStyle(11, marks, 1, 6), { bold: true });
  assert.deepEqual(commonStyle(11, marks, 1, 9), {});
  marks = applyStyle(11, marks, 0, 11, { bold: null, color: null });
  assert.deepEqual(marks, []);
});

test('edits move ranges and typed text inherits the style before the caret', () => {
  const marks = [{ start: 6, end: 11, bold: true }];
  // Typing at the end of a bold word continues it.
  assert.deepEqual(rebaseMarks('Hello world', 'Hello worlds', marks, null, 12), [
    { start: 6, end: 12, bold: true },
  ]);
  // Typing before it shifts it.
  assert.deepEqual(rebaseMarks('Hello world', 'Oh Hello world', marks, null, 3), [
    { start: 9, end: 14, bold: true },
  ]);
  // Deleting into it shrinks it; replacing styled text keeps the style.
  assert.deepEqual(rebaseMarks('Hello world', 'Hello wd', marks, null, 7), [
    { start: 6, end: 8, bold: true },
  ]);
  assert.deepEqual(rebaseMarks('Hello world', 'Hello X', marks, null, 7), [
    { start: 6, end: 7, bold: true },
  ]);
  // A pending style applies to new text only.
  assert.deepEqual(rebaseMarks('ab', 'abc', [], { italic: true }, 3), [
    { start: 2, end: 3, italic: true },
  ]);
  // Repeated letters: the caret decides where the insertion happened.
  assert.deepEqual(rebaseMarks('aa', 'aaa', [{ start: 1, end: 2, bold: true }], null, 1), [
    { start: 2, end: 3, bold: true },
  ]);
});

test('untrusted marks are clamped and cleaned, and spoilers group', () => {
  assert.deepEqual(
    sanitizeMarks(
      [
        { start: 0, end: 99, spoiler: true, evil: 'x', color: 'red' },
        { start: -1, end: 2, bold: true },
        'nope',
      ],
      4,
    ),
    [{ start: 0, end: 4, spoiler: true }],
  );
  assert.equal(sanitizeMarks([{ start: 0, end: 2 }], 4), undefined);
  const runs = styleRuns(10, [
    { start: 1, end: 3, spoiler: true },
    { start: 3, end: 5, spoiler: true, bold: true },
    { start: 7, end: 9, spoiler: true },
  ]);
  assert.deepEqual(spoilerRegions(runs), [
    { start: 1, end: 5 },
    { start: 7, end: 9 },
  ]);
});

test('formatting survives storage and clipboard validation, malformed ranges are dropped', async () => {
  const { createRequire } = await import('node:module');
  const { objectValue } = createRequire(import.meta.url)('../electron/store.cjs');
  const { clipboardObjects } = await import('../src/canvas/content.ts');
  const list = {
    id: 'list',
    type: 'list',
    x: 0,
    y: 0,
    width: 320,
    height: 190,
    z: 1,
    text: 'Plan',
    textMarks: [{ start: 0, end: 4, font: 'hand', highlight: '#ffd43b' }],
    listScale: 1,
    items: [
      {
        id: 'a',
        text: 'Secret ending',
        checked: false,
        marks: [
          { start: 0, end: 6, bold: true, color: '#e5484d' },
          { start: 7, end: 13, spoiler: true, size: 1.25 },
          { start: 9, end: 99, italic: true, script: 'x' },
        ],
      },
      { id: 'b', text: 'Plain', checked: true },
    ],
  };
  const expectedItems = [
    {
      id: 'a',
      text: 'Secret ending',
      checked: false,
      marks: [
        { start: 0, end: 6, bold: true, color: '#e5484d' },
        { start: 7, end: 13, spoiler: true, size: 1.25 },
      ],
    },
    { id: 'b', text: 'Plain', checked: true },
  ];
  for (const value of [objectValue(list), clipboardObjects([list])[0]]) {
    assert.deepEqual(value.items, expectedItems);
    assert.deepEqual(value.textMarks, [{ start: 0, end: 4, highlight: '#ffd43b', font: 'hand' }]);
  }
});

test('the bundled Inter font is a font choice in storage, clipboard and MCP', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { objectValue } = require('../electron/store.cjs');
  const { tools } = require('../electron/mcp-tools.cjs');
  const { z } = require('zod');
  const { clipboardObjects } = await import('../src/canvas/content.ts');
  const { cleanStyle, fontFamilies } = await import('../src/canvas/rich-text.ts');
  const note = {
    id: 'n',
    type: 'note',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    z: 1,
    text: 'Title body',
    textMarks: [
      { start: 0, end: 5, font: 'inter', bold: true },
      { start: 6, end: 10, font: 'inter' },
    ],
  };
  for (const value of [objectValue(note), clipboardObjects([note])[0]])
    assert.deepEqual(value.textMarks, note.textMarks);
  assert.deepEqual(cleanStyle({ font: 'inter' }), { font: 'inter' });
  assert.match(fontFamilies.inter, /^"Inter Variable"/);
  const edit = tools(() => {}).find((t) => t.name === 'edit_board');
  const parsed = z.object(edit.schema).parse({ id: 'board', revision: 0, upserts: [note] });
  assert.deepEqual(parsed.upserts[0].textMarks, note.textMarks);
});

test('frame, image and document names keep their formatting', async () => {
  const { createRequire } = await import('node:module');
  const { objectValue } = createRequire(import.meta.url)('../electron/store.cjs');
  const { clipboardObjects } = await import('../src/canvas/content.ts');
  const { withDocumentTitle, withImageTitle } = await import('../src/canvas/document-files.ts');
  const big = { start: 0, end: 4, bold: true, size: 2 };
  const frame = {
    id: 'frame',
    type: 'frame',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    z: -1,
    text: 'Plan B',
    textMarks: [big],
  };
  const image = {
    id: 'image',
    type: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    z: 1,
    text: 'photo.png',
    imageTitle: 'Plan B',
    // Formats the title, not the file name; past its end it is cut back.
    titleMarks: [{ start: 0, end: 99, italic: true }],
  };
  for (const value of [objectValue(frame), clipboardObjects([frame])[0]])
    assert.deepEqual(value.textMarks, [big]);
  for (const value of [objectValue(image), clipboardObjects([image])[0]])
    assert.deepEqual(value.titleMarks, [{ start: 0, end: 6, italic: true }]);
  // Marks only belong to an image's or document's title.
  assert.equal(objectValue({ ...frame, titleMarks: [big] }).titleMarks, undefined);

  // Saving trims the title and moves its formatting along with the text.
  assert.deepEqual(
    withImageTitle({ ...image, titleMarks: [{ start: 2, end: 6, bold: true }] }, '  Plan B '),
    {
      ...image,
      imageTitle: 'Plan B',
      titleMarks: [{ start: 0, end: 4, bold: true }],
    },
  );
  const { titleMarks: _, ...untitled } = withImageTitle({ ...image, titleMarks: [big] }, '   ');
  assert.deepEqual(withImageTitle({ ...image, titleMarks: [big] }, '   '), {
    ...untitled,
    imageTitle: '',
  });
  const document = { ...image, type: 'document', documentTitle: 'Old', imageTitle: undefined };
  assert.deepEqual(
    withDocumentTitle(
      document,
      { ...document, titleMarks: [{ start: 1, end: 4, code: true }] },
      ' Spec ',
    ).titleMarks,
    [{ start: 0, end: 3, code: true }],
  );
});

// A context whose characters are half an em wide, with fixed font metrics.
function halfEm() {
  return {
    font: '10px sans-serif',
    measureText(text) {
      const size = parseFloat(/([\d.e-]+)px/.exec(this.font)[1]);
      return {
        width: [...text].length * size * 0.5,
        fontBoundingBoxAscent: size * 0.9,
        fontBoundingBoxDescent: size * 0.25,
        actualBoundingBoxAscent: size * 0.7,
        actualBoundingBoxDescent: size * 0.2,
      };
    },
  };
}
const base = { size: 10, weight: 400, family: 'sans-serif', lineHeight: 1.5 };
const lineText = (text, lines) => lines.map((line) => text.slice(line.start, line.end));

test('canvas lines wrap like the pre-wrap editor', async () => {
  const { layoutRichText } = await import('../src/canvas/rich-text-canvas.ts');
  // Five characters fit. The space after a word hangs instead of pushing it down.
  let text = 'abcde fghij';
  let lines = layoutRichText(halfEm(), text, [], base, 25);
  assert.deepEqual(lineText(text, lines), ['abcde ', 'fghij']);
  assert.equal(lines[0].width, 25, 'hanging space is not counted');
  // An over-long word moves to its own line, then breaks between characters.
  text = 'ab cdefghijkl';
  lines = layoutRichText(halfEm(), text, [], base, 25);
  assert.deepEqual(lineText(text, lines), ['ab ', 'cdefg', 'hijkl']);
  // Explicit and trailing line breaks keep their (empty) lines for the caret.
  text = 'one\n\ntwo\n';
  assert.deepEqual(lineText(text, layoutRichText(halfEm(), text, [], base, 100)), [
    'one',
    '',
    'two',
    '',
  ]);
  // Unwrapped free text keeps each paragraph on one line.
  text = 'a long line of free text';
  assert.equal(layoutRichText(halfEm(), text, [], base, Infinity).length, 1);
});

test('formatted runs size their pieces and lines', async () => {
  const { layoutRichText, richTextHeight, placeRichText } =
    await import('../src/canvas/rich-text-canvas.ts');
  const text = 'big small';
  const lines = layoutRichText(
    halfEm(),
    text,
    [
      { start: 0, end: 3, size: 2 },
      { start: 4, end: 9, code: true },
    ],
    base,
    1000,
  );
  assert.equal(lines.length, 1);
  const [big, space, code] = lines[0].pieces;
  assert.equal(big.text, 'big');
  assert.equal(big.width, 30);
  assert.equal(space.width, 5);
  // Monospace is 0.92em with 0.18em padding on both sides, like .rt-code.
  const size = 10 * 0.92;
  assert.ok(Math.abs(code.width - (5 * size * 0.5 + 2 * size * 0.18)) < 1e-9);
  assert.ok(Math.abs(code.lead - size * 0.18) < 1e-9);
  // The doubled run sets the line box: 20px at 1.5 line height.
  assert.ok(Math.abs(lines[0].height - 30) < 1e-9);
  assert.ok(Math.abs(richTextHeight(lines) - 30) < 1e-9);
  // Shared baseline: the big run's half leading sits above it.
  assert.ok(Math.abs(lines[0].baseline - (18 + (30 - 23) / 2)) < 1e-9);
  // Centred lines sit around their anchor.
  const placed = placeRichText(lines, { x: 100, y: 0, align: 'center' });
  assert.ok(Math.abs(placed[0].left - (100 - lines[0].width / 2)) < 1e-9);
});

test('spoiler boxes cover each hidden region, keyed by where it starts', async () => {
  const { layoutRichText, spoilerBoxes } = await import('../src/canvas/rich-text-canvas.ts');
  const text = 'see secret\nending here';
  const lines = layoutRichText(
    halfEm(),
    text,
    [
      { start: 4, end: 17, spoiler: true },
      { start: 19, end: 23, spoiler: true },
    ],
    base,
    1000,
  );
  const boxes = spoilerBoxes(lines, { x: 10, y: 20 });
  // One region across the line break reveals as one; the second is separate.
  assert.deepEqual(
    boxes.map((b) => b.start),
    [4, 4, 19],
  );
  assert.equal(boxes[0].x, 10 + 4 * 5);
  assert.equal(boxes[0].width, 6 * 5);
  assert.equal(boxes[1].x, 10);
  assert.ok(boxes[1].y > boxes[0].y);
});

test('drawing hides unrevealed spoilers and paints revealed ones', async () => {
  const { layoutRichText, drawRichText } = await import('../src/canvas/rich-text-canvas.ts');
  const text = 'open shut';
  const marks = [
    { start: 0, end: 4, spoiler: true },
    { start: 5, end: 9, spoiler: true, bold: true },
  ];
  const drawn = [];
  const ctx = {
    ...halfEm(),
    fillStyle: '',
    globalAlpha: 1,
    textBaseline: '',
    textAlign: '',
    save() {},
    restore() {},
    beginPath() {},
    roundRect() {},
    arc() {},
    fill() {},
    fillRect() {},
    fillText(value) {
      if (value.trim()) drawn.push(value);
    },
  };
  const lines = layoutRichText(ctx, text, marks, base, 1000);
  drawRichText(ctx, lines, base, { x: 0, y: 0, color: '#000000', hidden: 'veil' });
  assert.deepEqual(drawn, [], 'nothing readable before a click');
  drawRichText(ctx, lines, base, {
    x: 0,
    y: 0,
    color: '#000000',
    revealed: (start) => start === 0,
  });
  assert.deepEqual(drawn, ['open'], 'only the clicked region shows');
});
