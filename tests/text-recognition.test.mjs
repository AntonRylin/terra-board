import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  findTesseract,
  parseLanguageList,
  parseTesseractTsv,
  runProcess,
  tesseractLanguages,
  textRecognitionAvailable,
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
    platform: 'win32',
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
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const ocr = createOcr({
    platform: 'win32',
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

// Linux: the system's Tesseract. These run on every system with a fake CLI.
const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '1\t1\t0\t0\t0\t0\t0\t0\t1600\t800\t-1\t',
  '2\t1\t1\t0\t0\t0\t160\t80\t680\t200\t-1\t',
  '3\t1\t1\t1\t0\t0\t160\t80\t680\t200\t-1\t',
  '4\t1\t1\t1\t1\t0\t160\t80\t680\t80\t-1\t',
  '5\t1\t1\t1\t1\t1\t160\t80\t320\t80\t96.5\tHello',
  '5\t1\t1\t1\t1\t2\t520\t90\t320\t70\t95.1\tworld',
  '4\t1\t1\t1\t2\t0\t160\t200\t400\t60\t-1\t',
  '5\t1\t1\t1\t2\t1\t160\t200\t300\t60\t91.0\tПривет',
  '5\t1\t1\t1\t2\t2\t500\t200\t20\t60\t12.0\t|',
  '5\t1\t1\t1\t2\t3\t540\t200\t20\t60\t88.0\t ',
  '',
].join('\n');
const LIST =
  'List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (4):\nchi_sim\neng\nosd\nrus\n';

test('Tesseract TSV becomes lines of word boxes', () => {
  const lines = parseTesseractTsv(TSV);
  assert.deepEqual(
    lines.map((line) => line.map((item) => item.t)),
    [['Hello', 'world'], ['Привет']],
  );
  assert.deepEqual(lines[0][1], { t: 'world', x: 520, y: 90, w: 320, h: 70 });
  assert.deepEqual(parseTesseractTsv(''), []);
});

test('Tesseract languages follow the preferred languages', () => {
  const installed = parseLanguageList(LIST);
  assert.deepEqual(installed, ['chi_sim', 'eng', 'osd', 'rus']);
  assert.deepEqual(tesseractLanguages(['ru-RU', 'en-US', 'de'], installed), ['rus', 'eng']);
  assert.deepEqual(tesseractLanguages(['zh-CN'], installed), ['chi_sim']);
  assert.deepEqual(tesseractLanguages(['zh-TW'], installed), ['eng']);
  assert.deepEqual(tesseractLanguages(['ja-JP'], installed), ['eng']);
  assert.deepEqual(tesseractLanguages([], ['osd', 'deu']), ['deu']);
  assert.deepEqual(tesseractLanguages(['en'], ['osd']), []);
  // Tesseract 3 printed the list on stderr, without a trailing count.
  assert.deepEqual(parseLanguageList('List of available languages (2):\neng\nfra'), ['eng', 'fra']);
});

test('text recognition is offered on Windows and on Linux with Tesseract', () => {
  assert.equal(textRecognitionAvailable('win32', {}), true);
  assert.equal(textRecognitionAvailable('darwin', {}), false);
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'terra-tesseract-'));
  try {
    const file = join(dir, 'tesseract');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    assert.notEqual(findTesseract({ PATH: dir }), file, 'not executable');
    chmodSync(file, 0o755);
    assert.equal(findTesseract({ PATH: `/nonexistent:${dir}` }), file);
    assert.equal(textRecognitionAvailable('linux', { PATH: dir }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux reads images with the tesseract program', async () => {
  const png = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const calls = [];
  const env = { PATH: '/usr/bin' };
  const ocr = createOcr({
    platform: 'linux',
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    spawnHost: () => assert.fail('Linux does not start the Windows host'),
    tesseract: {
      env,
      find: (given) => (assert.equal(given, env), '/usr/bin/tesseract'),
      preferredLanguages: () => ['ru-RU', 'en-US'],
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        assert.equal(file, '/usr/bin/tesseract');
        assert.equal(options.env, env);
        if (args[0] === '--list-langs') return { stdout: LIST, stderr: '' };
        assert.ok(Buffer.isBuffer(options.input));
        const { width } = await sharp(options.input).metadata();
        assert.equal(width, 1600);
        return { stdout: TSV, stderr: 'Estimating resolution as 300\n' };
      },
    },
  });
  const text = await ocr.recognizeAsset('c'.repeat(64));
  assert.deepEqual(text.lines.map(lineText), ['Hello world', 'Привет']);
  assert.equal(text.lines[0].words[0].x, 0.1);
  assert.equal(text.lines[0].words[0].y, 0.1);
  assert.equal(text.lines[0].words[1].height, 0.1);
  await ocr.recognizeImage(new Uint8Array(png));
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['--list-langs'],
      ['stdin', 'stdout', '--dpi', '300', '-l', 'rus+eng', 'tsv'],
      ['stdin', 'stdout', '--dpi', '300', '-l', 'rus+eng', 'tsv'],
    ],
  );
  ocr.dispose();
});

test('Linux without Tesseract says how to install it', async () => {
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const missing = createOcr({
    platform: 'linux',
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    tesseract: { find: () => null, run: () => assert.fail('nothing to run') },
  });
  await assert.rejects(
    missing.recognizeImage(new Uint8Array(png)),
    /sudo apt install tesseract-ocr/,
  );
  const noLanguages = createOcr({
    platform: 'linux',
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    tesseract: {
      find: () => '/usr/bin/tesseract',
      run: async () => ({ stdout: 'List of available languages (1):\nosd\n', stderr: '' }),
    },
  });
  await assert.rejects(noLanguages.recognizeImage(new Uint8Array(png)), /tesseract-ocr-eng/);
  const failing = createOcr({
    platform: 'linux',
    loadAsset: async () => ({ mime: 'image/png', file: png }),
    tesseract: {
      find: () => '/usr/bin/tesseract',
      run: async (file, args) => {
        if (args[0] === '--list-langs') return { stdout: LIST, stderr: '' };
        throw Error('Text recognition failed: Error in pixReadMem');
      },
    },
  });
  await assert.rejects(failing.recognizeAsset('d'.repeat(64)), /pixReadMem/);
  // A failed read is not cached.
  await assert.rejects(failing.recognizeAsset('d'.repeat(64)), /pixReadMem/);
});

test('programs get their input and report failures', async () => {
  const echo = await runProcess(
    process.execPath,
    ['-e', "let n=0;process.stdin.on('data',d=>n+=d.length).on('end',()=>console.log('bytes',n))"],
    { input: Buffer.alloc(300000, 1) },
  );
  assert.equal(echo.stdout.trim(), 'bytes 300000');
  await assert.rejects(
    runProcess(process.execPath, [
      '-e',
      "console.error('warning\\nError: bad input');process.exit(3)",
    ]),
    /Text recognition failed: Error: bad input/,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    /took too long/,
  );
  await assert.rejects(runProcess(join(tmpdir(), 'no-such-tesseract'), []), /could not start/);
});

// The real program, where installed (the Linux workflow installs tesseract-ocr).
test(
  'Tesseract reads rendered English text',
  { skip: process.platform === 'win32' || !findTesseract() ? 'tesseract is not installed' : false },
  async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="160">
      <rect width="100%" height="100%" fill="#fff"/>
      <text x="30" y="100" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="56" fill="#111">Terra Board reads text</text>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const ocr = createOcr({
      platform: 'linux',
      loadAsset: async () => ({ mime: 'image/png', file: png }),
      tesseract: { preferredLanguages: () => ['en-US'] },
    });
    const text = await ocr.recognizeImage(new Uint8Array(png));
    assert.match(text.lines.map(lineText).join('\n'), /Terra Board reads text/);
  },
);
