import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imagePng, createImageClipboard, objectMime } = require('../electron/image-clipboard.cjs');

const object = {
  id: 'image',
  type: 'image',
  assetId: 'a'.repeat(64),
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  z: 1,
  imageTitle: 'Keep my title',
};
async function fixture() {
  const pixels = Buffer.alloc(4096 * 2048 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i / 4) % 2 ? 250 : 10;
    pixels[i + 1] = 80;
    pixels[i + 2] = 170;
    pixels[i + 3] = 128;
  }
  const bytes = await sharp(pixels, { raw: { width: 4096, height: 2048, channels: 4 } })
    .png()
    .toBuffer();
  return { pixels, bytes, asset: { file: bytes, mime: 'image/png' } };
}
test('image copy retains every source pixel and alpha regardless of board size', async () => {
  const { pixels, asset } = await fixture();
  const png = await imagePng(asset, object);
  const result = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 4096);
  assert.equal(result.info.height, 2048);
  assert.deepEqual(result.data, pixels);
});
test('image copy applies normalized crop and rotation at source resolution', async () => {
  const { bytes, asset } = await fixture();
  const png = await imagePng(asset, {
    ...object,
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    rotation: 90,
  });
  const expected = await sharp(bytes)
    .extract({ left: 1024, top: 512, width: 2048, height: 1024 })
    .rotate(90)
    .raw()
    .toBuffer();
  const result = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(result.info.width, 1024);
  assert.equal(result.info.height, 2048);
  assert.deepEqual(result.data, expected);
});
test('image copy respects EXIF orientation before crop and rejects non-images', async () => {
  const bytes = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#ef1234' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const png = await imagePng(
    { file: bytes, mime: 'image/jpeg' },
    { ...object, crop: { x: 0, y: 0, width: 0.5, height: 1 } },
  );
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, 10);
  assert.equal(meta.height, 40);
  await assert.rejects(() => imagePng({ file: bytes, mime: 'video/mp4' }, object), /image/i);
});
class Item {
  constructor(data) {
    this.data = data;
    this.types = Object.keys(data);
  }
  async getType(type) {
    return this.data[type];
  }
}
test('empty custom clipboard data falls back to native image paste', async () => {
  const service = createImageClipboard({
    clipboard: { read: async () => [new Item({ [objectMime]: new Blob([]) })] },
    ClipboardItem: Item,
  });
  assert.equal(await service.readObjects(), null);
});
test('clipboard writes native image and editable object data atomically; failure keeps previous content', async () => {
  const { asset } = await fixture();
  let items = [],
    writes = 0;
  const clipboard = {
    async write(next) {
      items = next;
      writes++;
    },
    async read() {
      return items;
    },
  };
  const service = createImageClipboard({
    clipboard,
    ClipboardItem: Item,
    loadAsset: async () => asset,
  });
  await service.copy([object]);
  assert.equal(writes, 1);
  assert.deepEqual(items[0].types.sort(), ['image/png', objectMime].sort());
  assert.equal(
    (await sharp(Buffer.from(await items[0].data['image/png'].arrayBuffer())).metadata()).width,
    4096,
  );
  assert.deepEqual(await service.readObjects(), [object]);
  await assert.rejects(
    () => service.copy([{ ...object, crop: { x: 2, y: 0, width: 1, height: 1 } }]),
    /crop/i,
  );
  assert.equal(writes, 1);
});
test('a later text copy wins over a slow earlier image copy', async () => {
  const { asset } = await fixture();
  let release,
    items = [];
  const blocked = new Promise((r) => {
    release = r;
  });
  const service = createImageClipboard({
    clipboard: {
      async write(next) {
        items = next;
      },
      async read() {
        return items;
      },
    },
    ClipboardItem: Item,
    loadAsset: async () => {
      await blocked;
      return asset;
    },
  });
  const first = service.copy([object]);
  const text = {
    id: 'text',
    type: 'text',
    x: 0,
    y: 0,
    width: 120,
    height: 40,
    z: 1,
    text: 'new copy',
  };
  await service.copy([text]);
  release();
  assert.equal(await first, false);
  assert.deepEqual(await service.readObjects(), [text]);
  assert.equal(await items[0].data['text/plain'].text(), 'new copy');
});
test('lossless file payload accompanies the bitmap and canceled copies leave the clipboard alone', async () => {
  const { asset, pixels } = await fixture();
  let items = [],
    saved;
  const service = createImageClipboard({
    clipboard: {
      async write(next) {
        items = next;
      },
      async read() {
        return items;
      },
    },
    ClipboardItem: Item,
    loadAsset: async () => asset,
    saveImage: async (png) => {
      saved = png;
      return 'file:///test/Clipboard.png';
    },
  });
  await service.copy([object]);
  assert.equal(await items[0].data['text/uri-list'].text(), 'file:///test/Clipboard.png');
  assert.deepEqual(await sharp(saved).raw().toBuffer(), pixels);
  const previous = items;
  const canceled = service.copy([object]);
  service.cancel();
  assert.equal(await canceled, false);
  assert.equal(items, previous);
});
test('a newer copy in another app is not overwritten by a pending image', async () => {
  const { asset } = await fixture();
  let release,
    started,
    items = [];
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const loading = new Promise((resolve) => {
    started = resolve;
  });
  const service = createImageClipboard({
    clipboard: {
      async read() {
        return items;
      },
      async write(next) {
        items = next;
      },
    },
    ClipboardItem: Item,
    loadAsset: async () => {
      started();
      await blocked;
      return asset;
    },
  });
  const pending = service.copy([object]);
  await loading;
  const external = [new Item({ 'text/plain': new Blob(['Copied in another app']) })];
  items = external;
  release();
  assert.equal(await pending, false);
  assert.equal(items, external);
});

test('unchanged screenshot PNG bytes are reused and compressed source quality is retained', async () => {
  const { bytes, asset } = await fixture();
  const copied = await imagePng(asset, object);
  assert.equal(copied, bytes, 'no PNG re-encode for an unmodified screenshot');
  const jpeg = await sharp(bytes).jpeg({ quality: 88 }).toBuffer();
  const png = await imagePng({ mime: 'image/jpeg', file: jpeg }, object);
  assert.deepEqual(await sharp(png).raw().toBuffer(), await sharp(jpeg).raw().toBuffer());
});
