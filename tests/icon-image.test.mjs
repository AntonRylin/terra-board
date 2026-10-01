import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { iconPng } = require('../electron/icon-image.cjs');

function ico(frame) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = header[7] = 2;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(frame.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, frame]);
}
function bitmap() {
  const frame = Buffer.alloc(64);
  frame.writeUInt32LE(40, 0);
  frame.writeUInt32LE(2, 4);
  frame.writeUInt32LE(4, 8);
  frame.writeUInt16LE(1, 12);
  frame.writeUInt16LE(32, 14);
  for (let i = 40; i < 56; i += 4) {
    frame[i + 2] = 255;
    frame[i + 3] = 255;
  }
  frame[55] = 0; // Transparent top-right pixel.
  return frame;
}
test('Windows bitmap icons become PNG with orientation and alpha intact', async () => {
  const png = await iconPng(ico(bitmap()));
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
  assert.deepEqual([...data.subarray(0, 8)], [255, 0, 0, 255, 255, 0, 0, 0]);
});
test('PNG frames and ordinary PNG icons remain decodable', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4285f4' } })
    .png()
    .toBuffer();
  assert.deepEqual(await iconPng(ico(png)), png);
  assert.deepEqual(await iconPng(png), png);
});
test('truncated and oversized bitmap icon headers fail before allocation', async () => {
  const frame = bitmap();
  frame.writeUInt32LE(0x7fffffff, 4);
  await assert.rejects(iconPng(ico(frame)), /Invalid bitmap/);
  await assert.rejects(iconPng(ico(bitmap()).subarray(0, 24)), /Invalid icon frame/);
});
