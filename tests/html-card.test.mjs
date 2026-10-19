import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  htmlSnapshotCurrent,
  htmlSnapshotKey,
  htmlViewport,
  pastedHtml,
  starterHtml,
} from '../src/canvas/html-card.ts';
import { clipboardObjects } from '../src/canvas/content.ts';

const require = createRequire(import.meta.url);
const { objectValue } = require('../electron/store.cjs');
const { createHtmlCards, embedRequest, fromEmbed } = require('../electron/html-cards.cjs');
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
  const key = htmlSnapshotKey(embed());
  assert.equal(htmlSnapshotKey(embed()), key);
  assert.equal(htmlSnapshotKey(embed({ x: 900, rotation: 40 })), key);
  assert.notEqual(htmlSnapshotKey(embed({ html: starterHtml + ' ' })), key);
  assert.notEqual(htmlSnapshotKey(embed({ width: 481 })), key);
  // Sub-pixel resizes lay the page out at the same CSS size.
  assert.equal(htmlSnapshotKey(embed({ width: 480.2 })), key);
  assert.match(key, /^[\w-]{1,100}$/);
  assert.ok(htmlSnapshotCurrent(embed({ assetId: asset, htmlSnapshotKey: key })));
  assert.ok(!htmlSnapshotCurrent(embed({ assetId: asset, htmlSnapshotKey: key, height: 200 })));
  assert.ok(!htmlSnapshotCurrent(embed({ htmlSnapshotKey: key })));
});

test('the page viewport stays within capturable bounds', () => {
  assert.deepEqual(htmlViewport({ width: 10, height: 99999 }), { width: 40, height: 4096 });
  assert.deepEqual(htmlViewport({ width: 640.6, height: 360.4 }), { width: 641, height: 360 });
});

test('only whole pasted web pages become embeds', () => {
  assert.equal(pastedHtml('  ' + starterHtml + '\n'), starterHtml.trim());
  assert.ok(pastedHtml('<html><body>Hi</body></html>'));
  assert.equal(pastedHtml('<div>a fragment</div>'), null);
  assert.equal(pastedHtml('Some notes about <html> tags'), null);
  assert.equal(pastedHtml('<!doctype html><p>unterminated'), null);
  assert.equal(pastedHtml('<!doctype html>' + 'x'.repeat(500000) + '</html>'), null);
});

test('storage keeps embed source and picture, and only on embeds', () => {
  const key = htmlSnapshotKey(embed());
  const saved = objectValue(embed({ assetId: asset, htmlSnapshotKey: key }));
  assert.equal(saved.html, starterHtml);
  assert.equal(saved.assetId, asset);
  assert.equal(saved.htmlSnapshotKey, key);
  // New embeds have no picture yet.
  assert.equal(objectValue(embed()).assetId, undefined);
  assert.throws(() => objectValue(embed({ html: 'x'.repeat(500001) })), /HTML source/);
  assert.throws(() => objectValue({ ...embed(), type: 'note' }), /HTML source/);
  assert.throws(() => objectValue(embed({ htmlSnapshotKey: '../x' })), /HTML snapshot/);
});

test('clipboard copies embeds whole and rejects foreign fields', () => {
  const key = htmlSnapshotKey(embed());
  const [copy] = clipboardObjects([embed({ assetId: asset, htmlSnapshotKey: key })]);
  assert.equal(copy.html, starterHtml);
  assert.equal(copy.htmlSnapshotKey, key);
  assert.equal(copy.assetId, asset);
  assert.throws(() => clipboardObjects([{ ...embed(), type: 'text' }]), /HTML source/);
  assert.throws(() => clipboardObjects([embed({ assetId: '../secret' })]), /HTML snapshot/);
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
  assert.throws(() => cards.register('x'.repeat(500001)), /500,000/);
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
