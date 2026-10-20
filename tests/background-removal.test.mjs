import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Store } = require('../electron/store.cjs');
const { cutout } = require('../electron/image-cutout.cjs');
const {
  createBackgroundRemoval,
  removeAssetBackground,
} = require('../electron/background-removal.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/cutout-tests-'));
const store = new Store(root);
const model = resolve('assets/models/u2net.onnx');
// The installed extension provides the model and the ONNX runtime; here the
// runtime comes from node_modules and inference runs in this process.
const loadOrt = () => require('onnxruntime-node');
const installed = { model, loadOrt };
const removal = (paths) => (args) =>
  removeAssetBackground(args, {
    readAsset: (a) => store.readAsset(a),
    importAsset: (a) => store.importAsset(a),
    run: (file, icon) => cutout(file, { icon, ...paths }),
  });
const removeBackground = removal(installed);
const pixel = (bytes, x, y, width) => [
  ...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
];

// Deliberately include an enclosed white center, matching the background color.
const logo = await sharp(
  Buffer.from(
    '<svg width="96" height="64"><rect width="96" height="64" fill="white"/><circle cx="48" cy="32" r="22" fill="#e14035"/><circle cx="48" cy="32" r="10" fill="white"/></svg>',
  ),
)
  .png()
  .toBuffer();

test('icon background removal preserves enclosed logo details, size, and original bytes', async () => {
  const source = await store.importAsset({ bytes: logo, name: 'Logo.png' });
  const result = await removeBackground({ id: source.id, icon: true });
  assert.notEqual(result.id, source.id);
  assert.equal(result.mime, 'image/png');
  assert.deepEqual([result.width, result.height], [96, 64]);
  const file = store.asset({ id: result.id, variant: 'original' }).file;
  const raw = await sharp(file).ensureAlpha().raw().toBuffer();
  assert.equal(pixel(raw, 0, 0, 96)[3], 0);
  assert.deepEqual(pixel(raw, 48, 32, 96), [255, 255, 255, 255]);
  assert.equal(pixel(raw, 65, 32, 96)[3], 255);
  assert.deepEqual(readFileSync(store.asset({ id: source.id, variant: 'original' }).file), logo);
  for (const variant of ['preview', 'thumb']) {
    const bytes = await sharp(store.asset({ id: result.id, variant }).file)
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.equal(bytes[3], 0, `${variant} retains transparency`);
  }
});

test('already-transparent PNG icon preserves exact soft alpha and original asset', async () => {
  const data = Buffer.from([
    20, 80, 140, 0, 40, 90, 150, 127, 50, 100, 180, 255, 60, 110, 190, 220,
  ]);
  const bytes = await sharp(data, { raw: { width: 2, height: 2, channels: 4 } })
    .png()
    .toBuffer();
  const original = await store.importAsset({ bytes, name: 'transparent.png' });
  const result = await removeBackground({ id: original.id, icon: true });
  assert.equal(result.id, original.id);
  assert.deepEqual(readFileSync(store.asset({ id: result.id, variant: 'original' }).file), bytes);
});

test('invalid assets and options fail without creating output', async () => {
  await assert.rejects(removeBackground({ id: '../not-an-asset' }), /Invalid asset/);
  const asset = await store.importAsset({ bytes: logo, name: 'Icon.png' });
  await assert.rejects(removeBackground({ id: asset.id, icon: 'yes' }), /Invalid icon option/);
  await assert.rejects(
    cutout(logo, { model: join(root, 'missing.onnx'), loadOrt }),
    /Install Background removal in Settings → Extensions/,
  );
});

test('real local model produces a soft, nonempty cutout and never increases source alpha', async () => {
  // A shaded product against a textured backdrop exercises the model path.
  const image = await sharp(
    Buffer.from(`<svg width="240" height="180">
    <defs><linearGradient id="bg"><stop stop-color="#dce6d0"/><stop offset="1" stop-color="#9baa97"/></linearGradient>
    <linearGradient id="body"><stop stop-color="#a11c1c"/><stop offset="0.45" stop-color="#ed6355"/><stop offset="1" stop-color="#941c20"/></linearGradient></defs>
    <rect width="240" height="180" fill="url(#bg)"/><path d="M0 130H240M0 150H240" stroke="#c4cfb8"/>
    <ellipse cx="120" cy="158" rx="47" ry="9" fill="#61715b" opacity="0.3"/>
    <path d="M105 20H135V46L150 62V148Q120 166 90 148V62L105 46Z" fill="url(#body)"/>
    <rect x="104" y="14" width="32" height="14" rx="3" fill="#293443"/>
    <rect x="95" y="78" width="50" height="46" rx="4" fill="#f6e9cb"/>
    <circle cx="120" cy="100" r="13" fill="#c83b37"/></svg>`),
  )
    .png()
    .toBuffer();
  const png = await cutout(image, installed);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [240, 180]);
  assert.ok(pixel(data, 120, 100, 240)[3] > 240, 'foreground preserved');
  assert.ok(pixel(data, 0, 0, 240)[3] < 10, 'background removed');
  assert.ok(
    data.some((v, i) => i % 4 === 3 && v > 0 && v < 255),
    'soft mask edges',
  );
  const faded = await sharp(image).ensureAlpha(0.5).raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < faded.data.length; i += 4) faded.data[i] = 100;
  const semitransparent = await sharp(faded.data, { raw: { width: 240, height: 180, channels: 4 } })
    .png()
    .toBuffer();
  const processed = await sharp(await cutout(semitransparent, installed))
    .raw()
    .toBuffer();
  assert.ok(processed.every((v, i) => i % 4 !== 3 || v <= 100));
});

test('flat icons work without the extension', async () => {
  const source = await store.importAsset({ bytes: logo, name: 'Flat.png' });
  const result = await removal({})({ id: source.id, icon: true });
  assert.notEqual(result.id, source.id);
  const raw = await sharp(store.asset({ id: result.id, variant: 'original' }).file)
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.equal(pixel(raw, 0, 0, 96)[3], 0);
});

test('photos without the extension ask to install it', async () => {
  const source = await store.importAsset({ bytes: logo, name: 'Photo.png' });
  await assert.rejects(
    removal({})({ id: source.id }),
    /Install Background removal in Settings → Extensions/,
  );
});

// A cut-out runs in a utility process; removing the extension or quitting
// ends it, and jobs still waiting are turned away.
test('stop ends the running job and turns away waiting ones', async () => {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    child.postMessage = (message) => (child.received = message);
    child.kill = () => (child.killed = true);
    children.push(child);
    return child;
  };
  const removal = createBackgroundRemoval({
    fork,
    location: () => ({ model: 'u2net.onnx', runtime: 'runtime' }),
  });
  const first = removal.run('photo.png', false);
  const second = removal.run('other.png', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 1, 'one job at a time');
  assert.deepEqual(children[0].received, {
    file: 'photo.png',
    icon: false,
    model: 'u2net.onnx',
    runtime: 'runtime',
  });
  removal.stop();
  await assert.rejects(first, /stopped/);
  await assert.rejects(second, /stopped/);
  assert.equal(children[0].killed, true);
  assert.equal(children.length, 1, 'the waiting job never started');
  // After stopping, new jobs run again and finish with the process's answer.
  const third = removal.run('again.png', true);
  await new Promise((resolve) => setImmediate(resolve));
  children[1].emit('message', { bytes: new Uint8Array([1, 2, 3]) });
  assert.deepEqual([...(await third)], [1, 2, 3]);
  assert.equal(children[1].killed, true, 'the process ends after its job');
});

test.after(() => store.close());
