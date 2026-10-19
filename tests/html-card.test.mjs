import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  snapshotCurrent,
  snapshotKey,
  pageViewport,
  pastedHtml,
  starterHtml,
  browserAddress,
} from '../src/canvas/html-card.ts';
import { clipboardObjects } from '../src/canvas/content.ts';

const require = createRequire(import.meta.url);
const { objectValue } = require('../electron/store.cjs');
const {
  createHtmlCards,
  embedRequest,
  fromEmbed,
  snapshotKey: appSnapshotKey,
} = require('../electron/html-cards.cjs');
const { plainUserAgent } = require('../electron/browser-frames.cjs');
const { applyEdits, placeBeside, compactObject } = require('../electron/mcp-html.cjs');
const asset = 'a'.repeat(64);
const embed = (patch = {}) => ({
  id: 'embed',
  type: 'html',
  x: 0,
  y: 0,
  width: 480,
  height: 320,
  z: 1,
  html: starterHtml,
  ...patch,
});

test('a picture belongs to the source and size it was captured from', () => {
  const key = snapshotKey(embed());
  assert.equal(snapshotKey(embed()), key);
  assert.equal(snapshotKey(embed({ x: 900, rotation: 40 })), key);
  assert.notEqual(snapshotKey(embed({ html: starterHtml + ' ' })), key);
  assert.notEqual(snapshotKey(embed({ width: 481 })), key);
  // Sub-pixel resizes lay the page out at the same CSS size.
  assert.equal(snapshotKey(embed({ width: 480.2 })), key);
  assert.match(key, /^[\w-]{1,100}$/);
  assert.ok(snapshotCurrent(embed({ assetId: asset, snapshotKey: key })));
  assert.ok(!snapshotCurrent(embed({ assetId: asset, snapshotKey: key, height: 200 })));
  assert.ok(!snapshotCurrent(embed({ snapshotKey: key })));
});

test('the page viewport stays within capturable bounds', () => {
  assert.deepEqual(pageViewport({ width: 10, height: 99999 }), { width: 40, height: 4096 });
  assert.deepEqual(pageViewport({ width: 640.6, height: 360.4 }), { width: 641, height: 360 });
});

test('only whole pasted web pages become embeds', () => {
  assert.equal(pastedHtml('  ' + starterHtml + '\n'), starterHtml.trim());
  assert.ok(pastedHtml('<html><body>Hi</body></html>'));
  assert.equal(pastedHtml('<div>a fragment</div>'), null);
  assert.equal(pastedHtml('Some notes about <html> tags'), null);
  assert.equal(pastedHtml('<!doctype html><p>unterminated'), null);
  assert.equal(pastedHtml('<!doctype html>' + 'x'.repeat(1000000) + '</html>'), null);
});

test('storage keeps embed source and picture, and only on embeds', () => {
  const key = snapshotKey(embed());
  const saved = objectValue(embed({ assetId: asset, snapshotKey: key }));
  assert.equal(saved.html, starterHtml);
  assert.equal(saved.assetId, asset);
  assert.equal(saved.snapshotKey, key);
  // New embeds have no picture yet.
  assert.equal(objectValue(embed()).assetId, undefined);
  assert.throws(() => objectValue(embed({ html: 'x'.repeat(1000001) })), /HTML source/);
  assert.throws(() => objectValue({ ...embed(), type: 'note' }), /HTML source/);
  assert.throws(() => objectValue(embed({ snapshotKey: '../x' })), /HTML snapshot/);
});

test('clipboard copies embeds whole and rejects foreign fields', () => {
  const key = snapshotKey(embed());
  const [copy] = clipboardObjects([embed({ assetId: asset, snapshotKey: key })]);
  assert.equal(copy.html, starterHtml);
  assert.equal(copy.snapshotKey, key);
  assert.equal(copy.assetId, asset);
  assert.throws(() => clipboardObjects([{ ...embed(), type: 'text' }]), /HTML source/);
  assert.throws(() => clipboardObjects([embed({ assetId: '../secret' })]), /web page picture/);
});

test('embed pages are served once registered, from their own origin', async () => {
  const cards = createHtmlCards({ BrowserWindow: null, session: null, call: null });
  const { url } = cards.register('<p>Hi</p>');
  assert.match(url, /^terra-html:\/\/page\/[\w-]{36}\/$/);
  const response = cards.handle({ url });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<p>Hi</p>');
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(cards.handle({ url: url + 'style.css' }).status, 404);
  assert.equal(cards.handle({ url: url.replace('page', 'other') }).status, 404);
  assert.throws(() => cards.register('x'.repeat(1000001)), /1,000,000/);
  // Only recent pages are kept.
  for (let i = 0; i < 64; i++) cards.register(String(i));
  assert.equal(cards.handle({ url }).status, 404);
});

test('running embeds may use the web but not frames or local schemes', () => {
  const page = 'terra-html://page/00000000-0000-0000-0000-000000000000/';
  const from = (url, resourceType, frame = page) => ({ url, resourceType, frame: { url: frame } });
  assert.ok(embedRequest(from(page, 'subFrame', 'canvas-app://app/')));
  assert.ok(!embedRequest(from(page, 'mainFrame')));
  assert.ok(embedRequest(from('https://cdn.example.com/lib.js', 'script')));
  assert.ok(embedRequest(from('wss://example.com/socket', 'webSocket')));
  assert.ok(!embedRequest(from('https://example.com/', 'subFrame')));
  assert.ok(!embedRequest(from('file:///C:/secret.txt', 'xhr')));
  assert.ok(!embedRequest(from('canvas-media://asset/abc/original', 'image')));
  // The same request from the board itself is not an embed's.
  assert.ok(!embedRequest(from('https://cdn.example.com/lib.js', 'script', 'canvas-app://app/')));
  assert.ok(!embedRequest({ url: 'https://example.com/', resourceType: 'xhr', frame: null }));
  // Local schemes from an embed are its requests, and refused.
  assert.ok(fromEmbed(from('canvas-media://asset/abc/original', 'xhr')));
  assert.ok(!fromEmbed(from('canvas-media://asset/abc/original', 'xhr', 'canvas-app://app/')));
});

const browser = (patch = {}) => ({
  id: 'tab',
  type: 'browser',
  x: 0,
  y: 0,
  width: 960,
  height: 640,
  z: 1,
  url: 'https://example.com/',
  ...patch,
});

test('the app and the board name pictures the same way', () => {
  for (const o of [
    embed(),
    embed({ width: 333.4, html: '<p>é</p>' }),
    browser(),
    browser({ height: 20 }),
  ])
    assert.equal(appSnapshotKey(o), snapshotKey(o));
  // A browser frame's page is below its 40-unit address bar, and its key follows the address.
  assert.match(snapshotKey(browser()), /^960x600-/);
  assert.notEqual(snapshotKey(browser()), snapshotKey(browser({ url: 'https://example.org/' })));
});

test('the address bar takes addresses, bare domains and searches', () => {
  assert.equal(browserAddress('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(browserAddress('example.com/docs'), 'https://example.com/docs');
  assert.equal(browserAddress('localhost:5173'), 'http://localhost:5173/');
  assert.equal(browserAddress('192.168.1.20:8080/app'), 'http://192.168.1.20:8080/app');
  assert.equal(
    browserAddress('terra board help'),
    'https://www.google.com/search?q=terra%20board%20help',
  );
  assert.equal(browserAddress('   '), null);
  assert.equal(
    browserAddress('javascript:alert(1)'),
    'https://www.google.com/search?q=javascript%3Aalert(1)',
  );
});

test('browser frames store a web address and their picture', () => {
  const key = snapshotKey(browser());
  const saved = objectValue(browser({ text: 'Example', assetId: asset, snapshotKey: key }));
  assert.equal(saved.url, 'https://example.com/');
  assert.equal(saved.snapshotKey, key);
  assert.throws(() => objectValue(browser({ url: 'file:///C:/secret.txt' })), /URL/);
  assert.throws(() => objectValue(browser({ url: undefined })), /URL/);
  const [copy] = clipboardObjects([browser({ assetId: asset, snapshotKey: key })]);
  assert.equal(copy.url, 'https://example.com/');
  assert.equal(copy.snapshotKey, key);
  assert.throws(() => clipboardObjects([browser({ url: 'javascript:alert(1)' })]), /address/);
});

test('browser frames present as plain Chrome', () => {
  assert.equal(
    plainUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) terra-board/0.1.27 Chrome/140.0.0.0 Electron/44.5.1 Safari/537.36',
    ),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  );
});

test('page edits need an unambiguous match', () => {
  const page = '<h1>A</h1><p>A</p>';
  assert.equal(applyEdits(page, [{ find: '<h1>A', replace: '<h1>B' }]), '<h1>B</h1><p>A</p>');
  assert.equal(applyEdits(page, [{ find: 'A', replace: '$&', all: true }]), '<h1>$&</h1><p>$&</p>');
  assert.equal(applyEdits(page, [{ find: '<p>A', replace: '$1' }]), '<h1>A</h1>$1</p>');
  assert.throws(() => applyEdits(page, [{ find: 'A', replace: 'B' }]), /appears 2 times/);
  assert.throws(() => applyEdits(page, [{ find: 'Z', replace: 'B' }]), /not in the page/);
});

test('new embeds go beside the board content; reads leave sources out', () => {
  assert.deepEqual(placeBeside([], 800), { x: -400, y: 0 });
  assert.deepEqual(
    placeBeside(
      [
        { type: 'note', x: 0, y: 50, width: 200, height: 100 },
        { type: 'rect', x: 300, y: -20, width: 100, height: 100 },
        { type: 'arrow', x: 5000, y: -900, width: 10, height: 10 },
      ],
      800,
    ),
    { x: 480, y: -20 },
  );
  const { html, ...rest } = embed();
  assert.deepEqual(compactObject(embed()), { ...rest, htmlChars: html.length });
  assert.deepEqual(compactObject(browser()), browser());
});
