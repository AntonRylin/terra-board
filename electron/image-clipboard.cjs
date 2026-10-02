const sharp = require('sharp');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { objectValue } = require('./store.cjs');
const objectMime = 'web application/x-terra-board-objects';
const maxObjectBytes = 16 * 1024 * 1024;

function objectsValue(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000)
    throw Error('Copy between 1 and 10,000 objects at once');
  const objects = input.map(objectValue);
  if (Buffer.byteLength(JSON.stringify(objects)) > maxObjectBytes)
    throw Error('The copied selection is too large');
  return objects;
}

async function imagePng(asset, object) {
  if (!asset.mime.startsWith('image/')) throw Error('Only images can be copied as an image');
  const input = sharp(asset.file, { limitInputPixels: 100000000, animated: false });
  const metadata = await input.metadata();
  // Most screenshots are already upright PNGs. Preserve their exact bytes
  // instead of decoding and compressing millions of pixels for every cut.
  if (
    metadata.format === 'png' &&
    (!metadata.orientation || metadata.orientation === 1) &&
    (!metadata.pages || metadata.pages === 1) &&
    !object.crop &&
    !(object.rotation % 360)
  )
    return Buffer.isBuffer(asset.file) ? asset.file : readFile(asset.file);
  const width = metadata.orientation >= 5 ? metadata.height : metadata.width;
  const height = metadata.orientation >= 5 ? metadata.width : metadata.height;
  input.autoOrient();
  if (object.crop) {
    const crop = object.crop;
    const left = Math.min(width - 1, Math.floor(crop.x * width));
    const top = Math.min(height - 1, Math.floor(crop.y * height));
    const right = Math.min(width, Math.max(left + 1, Math.round((crop.x + crop.width) * width)));
    const bottom = Math.min(height, Math.max(top + 1, Math.round((crop.y + crop.height) * height)));
    input.extract({ left, top, width: right - left, height: bottom - top });
  }
  // PNG preserves source detail and transparency; never use the 1600px preview.
  if (!object.rotation || object.rotation === 360)
    return input.png({ compressionLevel: 1 }).toBuffer();
  // A raw intermediate avoids an extra PNG compression/decompression round trip.
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .rotate(object.rotation, { background: '#00000000' })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

function createImageClipboard({ clipboard, ClipboardItem, loadAsset, saveImage }) {
  let generation = 0;
  let writes = Promise.resolve();
  const clipboardFingerprint = async () => {
    const hash = createHash('sha256');
    for (const item of await clipboard.read()) {
      const types = [...item.types].sort();
      hash.update(JSON.stringify(types));
      // A file list or Terra object payload identifies its image without
      // decoding the duplicate OS bitmap just to check for a newer copy.
      const known = types.filter((type) =>
        [objectMime, 'text/plain', 'text/html', 'text/rtf', 'text/uri-list', 'image/png'].includes(
          type,
        ),
      );
      const content = known.length ? known : types;
      for (const type of content) {
        if (type === 'image/png' && (types.includes(objectMime) || types.includes('text/uri-list')))
          continue;
        const data = await item.getType(type);
        hash.update(type);
        hash.update(
          data instanceof Blob ? Buffer.from(await data.arrayBuffer()) : JSON.stringify(data),
        );
      }
    }
    return hash.digest('hex');
  };
  return {
    cancel() {
      generation++;
    },
    async copy(input) {
      const current = ++generation;
      const objects = objectsValue(input);
      const image = objects.length === 1 && objects[0].type === 'image';
      // Wait for an already-committing copy before taking the external snapshot.
      await writes.catch(() => {});
      const previous = image ? await clipboardFingerprint() : null;
      const data = {
        [objectMime]: new Blob([JSON.stringify(objects)], { type: 'application/json' }),
      };
      if (image) {
        const object = objects[0];
        const asset = await loadAsset(object.assetId);
        const png = await imagePng(asset, object);
        if (current !== generation) return false;
        data['image/png'] = new Blob([png], { type: 'image/png' });
        // File-paste consumers receive exact PNG pixels, avoiding the native
        // bitmap's alpha premultiplication rounding. Keep the bitmap for others.
        if (saveImage)
          data['text/uri-list'] = new Blob([await saveImage(png)], { type: 'text/uri-list' });
      } else {
        data['text/plain'] = new Blob([objects.map((o) => o.text || o.url || o.type).join('\n')], {
          type: 'text/plain',
        });
      }
      // A slow image must not replace a newer copy. Serialize OS commits as well.
      const write = writes
        .catch(() => {})
        .then(async () => {
          if (current !== generation) return false;
          if (previous !== null && previous !== (await clipboardFingerprint())) return false;
          if (current !== generation) return false;
          await clipboard.write([new ClipboardItem(data)]);
          return true;
        });
      writes = write;
      return write;
    },
    async readObjects() {
      const items = await clipboard.read();
      const item = items.find((item) => item.types.includes(objectMime));
      if (!item) return null;
      const data = await item.getType(objectMime);
      // Empty custom data is not an editable selection. Let the renderer
      // fall back to any native image or files present on the clipboard.
      if (!data.size) return null;
      if (data.size > maxObjectBytes) throw Error('The copied selection is too large');
      return objectsValue(JSON.parse(await data.text()));
    },
  };
}
module.exports = { imagePng, createImageClipboard, objectMime };
