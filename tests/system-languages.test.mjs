import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acceptLanguages, spellcheckLanguages } = require('../electron/system-languages.cjs');

// The app ships only Chromium's English locale, so websites and the
// spellchecker learn the languages from Windows instead of from the UI locale.
test('accept-languages keeps valid unique tags', () => {
  assert.equal(acceptLanguages(['en-US', 'ru', 'en-US', 'x y', '']), 'en-US,ru');
  assert.equal(acceptLanguages(['zh-Hans-CN', 'de-CH-1996']), 'zh-Hans-CN,de-CH-1996');
  assert.equal(acceptLanguages([]), '');
  assert.equal(acceptLanguages(undefined), '');
  const many = Array.from({ length: 14 }, (_, i) => `l${'abcdefghijklmn'[i]}`);
  assert.equal(acceptLanguages(many).split(',').length, 10);
});

test('spellcheck uses the Windows languages that have a dictionary', () => {
  const available = ['en-US', 'en-GB', 'ru', 'de-DE', 'pt-BR'];
  assert.deepEqual(spellcheckLanguages(['ru-RU', 'en-US'], available), ['ru', 'en-US']);
  assert.deepEqual(spellcheckLanguages(['de-AT'], available), ['de-DE']);
  assert.deepEqual(spellcheckLanguages(['en-US', 'en-AU'], available), ['en-US']);
  assert.deepEqual(spellcheckLanguages(['ja-JP', 'x y'], available), []);
  assert.deepEqual(spellcheckLanguages(undefined, undefined), []);
});
