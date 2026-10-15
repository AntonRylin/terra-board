import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import {
  cropRecognizedText,
  lineText,
  pdfRunsToText,
  recognizedString,
} from '../src/canvas/recognized-text.ts';
const require = createRequire(import.meta.url);
const {
  createOcr,
  matchLanguages,
  mergeRecognitions,
  normalizeLines,
  prepareImage,
  scriptOf,
} = require('../electron/ocr.cjs');

const word = (t, x, y = 10, w = 50, h = 20) => ({ t, x, y, w, h });

test('recognizer languages follow the Windows display language order', () => {
  assert.deepEqual(matchLanguages(['en-GB', 'ru-RU', 'fr'], ['de-DE', 'en-US', 'ru']), [
    'en-US',
    'ru',
  ]);
  assert.deepEqual(matchLanguages(['ja'], ['de-DE', 'en-US']), ['en-US']);
  assert.deepEqual(matchLanguages([], []), []);
});

test('scripts separate Latin, Cyrillic look-alikes and distinct letters', () => {
  assert.equal(scriptOf('copy'), 'latin');
  assert.equal(scriptOf('0CR.'), 'latin');
  assert.equal(scriptOf('сору'), 'lookalike');
  assert.equal(scriptOf('Привет,'), 'other');
});

test('mixed English and Russian text takes the best reading of each word', () => {
  const english = {
    language: 'en-US',
    lines: [
      [word('Mixed:', 0), word('noAAeP>KVlBaeT', 60), word('copy', 120)],
      [word("np',1BeT,", 0, 50), word('OCR.', 60, 50)],
    ],
  };
  const russian = {
    language: 'ru',
    lines: [
      [word('Mixed:', 0), word('поддерживает', 60), word('сору', 120)],
      [word('Привет,', 0, 50), word('0CR.', 60, 50), word('для', 120, 50)],
    ],
  };
  const lines = mergeRecognitions([english, russian]).map((line) =>
    line.map((item) => item.t).join(' '),
  );
  assert.deepEqual(lines, ['Mixed: поддерживает copy', 'Привет, OCR. для']);
});

test('ambiguous words stay Cyrillic on a Russian line', () => {
  const lines = mergeRecognitions([
    { language: 'en-US', lines: [[word('Bce', 0), word('cyxo', 60)]] },
    { language: 'ru', lines: [[word('Все', 0), word('сухо', 60), word('здесь', 120)]] },
  ]);
  assert.equal(lines[0].map((item) => item.t).join(' '), 'Все сухо здесь');
});

test('recognized words share their line height and normalize to the image', () => {
  const [line] = normalizeLines(
    [[word('漢', 0, 10, 20, 20), word('字', 20, 14, 20, 10)]],
    200,
    100,
  );
  assert.equal(line.words[0].y, 0.1);
  assert.equal(line.words[1].height, 0.2);
  assert.equal(line.words[1].join, true);
  assert.equal(line.words[0].x, 0);
  assert.equal(line.words[1].width, 0.1);
});

test('images are enlarged for small text and flattened onto white', async () => {
  const input = await sharp({
    create: { width: 400, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const prepared = await prepareImage(input);
  assert.equal(prepared.width, 800);
  assert.equal(prepared.height, 200);
  const { data } = await sharp(prepared.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[0], 255);
  const huge = await prepareImage(
    await sharp({ create: { width: 3000, height: 200, channels: 3, background: '#fff' } })
      .png()
      .toBuffer(),
    1000,
  );
  assert.equal(huge.width, 1000);
});

function fakeHost(reply) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit');
  child.stdout.write(
    JSON.stringify({
      ready: true,
      languages: ['en-US'],
      preferred: ['en-US'],
      maxDimension: 10000,
    }) + '\n',
  );
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    const index = buffer.indexOf('\n');
    if (index < 0) return;
    const request = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    child.stdout.write(JSON.stringify({ id: request.id, ...reply(request) }) + '\n');
  });
  child.stdin.on('finish', () => child.emit('exit'));
  return child;
}

test('the recognition host answers requests and caches asset results', async () => {
  const png = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  let starts = 0,
    requests = 0;
  const ocr = createOcr({
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    spawnHost: () => {
      starts++;
      return fakeHost((request) => {
        requests++;
        assert.deepEqual(request.languages, ['en-US']);
        return {
          results: [
            {
              language: 'en-US',
              lines: [[word('Hello', 160, 80, 320, 80), word('world', 520, 80, 320, 80)]],
            },
          ],
        };
      });
    },
  });
  if (process.platform !== 'win32') {
    await assert.rejects(ocr.recognizeAsset('a'), /Windows/);
    return;
  }
  const first = await ocr.recognizeAsset('a'.repeat(64));
  assert.equal(lineText(first.lines[0]), 'Hello world');
  assert.equal(first.lines[0].words[0].x, 0.1);
  await ocr.recognizeAsset('a'.repeat(64));
  assert.equal(requests, 1);
  await ocr.recognizeImage(new Uint8Array(png));
  assert.equal(requests, 2);
  assert.equal(starts, 1);
  ocr.dispose();
});

test('recognition errors reach the caller', async () => {
  if (process.platform !== 'win32') return;
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const ocr = createOcr({
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    spawnHost: () => fakeHost(() => ({ error: 'bad image' })),
  });
  await assert.rejects(ocr.recognizeImage(new Uint8Array(png)), /bad image/);
  await assert.rejects(ocr.recognizeAsset('b'), /bad image/);
  ocr.dispose();
});

test('plain text keeps line breaks and separates paragraphs', () => {
  const box = (text, x, y, extra = {}) => ({ text, x, y, width: 0.1, height: 0.05, ...extra });
  const text = {
    lines: [
      { words: [box('First', 0, 0), box('line', 0.12, 0)] },
      { words: [box('second', 0, 0.06), box('line', 0.12, 0.06)] },
      { words: [box('New', 0, 0.3), box('para', 0.12, 0.3, { join: true })] },
    ],
  };
  assert.equal(recognizedString(text), 'First line\nsecond line\n\nNewpara');
  const loose = { lines: [0, 0.2, 0.4].map((y) => ({ words: [box('Line', 0, y)] })) };
  assert.equal(recognizedString(loose), 'Line\nLine\nLine');
  const cropped = cropRecognizedText(text, { x: 0, y: 0, width: 0.5, height: 0.1 });
  assert.equal(recognizedString(cropped), 'First line\nsecond line');
  assert.equal(cropped.lines[0].words[1].x, 0.24);
});

test('PDF text runs become positioned lines', () => {
  const viewport = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, -1, 0, 800] };
  const run = (str, x, y, width, extra = {}) => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
    ...extra,
  });
  const text = pdfRunsToText(
    [
      run('Hello', 100, 700, 30),
      run('world', 135, 700, 32),
      run('ly', 167, 700, 10, { hasEOL: true }),
      run('Next line', 100, 680, 50),
    ],
    viewport,
  );
  assert.equal(text.lines.length, 2);
  assert.equal(lineText(text.lines[0]), 'Hello worldly');
  assert.equal(lineText(text.lines[1]), 'Next line');
  const first = text.lines[0].words[0];
  assert.equal(first.x, 100 / 600);
  assert.ok(Math.abs(first.y - (100 - 9.6) / 800) < 1e-9);
  assert.equal(first.height, 12 / 800);
});
