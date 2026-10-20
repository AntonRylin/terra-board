const sharp = require('sharp');
const fs = require('node:fs');
const os = require('node:os');
const limitInputPixels = 40000000;

// For flat icon artwork, remove only a uniform, edge-connected backdrop.
// Keep enclosed regions (e.g. white lettering inside a logo) intact.
function flatIconMask(rgba, width, height) {
  const count = width * height;
  const bg = [rgba[0], rgba[1], rgba[2]];
  const distance = (i) =>
    Math.max(
      Math.abs(rgba[i * 4] - bg[0]),
      Math.abs(rgba[i * 4 + 1] - bg[1]),
      Math.abs(rgba[i * 4 + 2] - bg[2]),
    );
  const border = [];
  for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
  if (border.filter((i) => distance(i) <= 12).length < border.length * 0.98) return null;
  const seen = new Uint8Array(count),
    queue = new Uint32Array(count);
  let head = 0,
    tail = 0;
  const visit = (i) => {
    if (seen[i] || distance(i) > 48) return;
    seen[i] = 1;
    queue[tail++] = i;
  };
  border.forEach(visit);
  while (head < tail) {
    const i = queue[head++],
      x = i % width;
    if (x) visit(i - 1);
    if (x + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < count) visit(i + width);
  }
  if (tail < count * 0.02 || tail > count * 0.98) return null;
  const mask = Buffer.alloc(count, 255);
  for (let i = 0; i < count; i++) {
    if (!seen[i]) continue;
    mask[i] = Math.round(Math.max(0, Math.min(1, (distance(i) - 12) / 36)) * 255);
    // Remove backdrop color from partially covered antialiased edge pixels.
    if (mask[i] > 0 && mask[i] < 255) {
      const alpha = mask[i] / 255;
      for (let c = 0; c < 3; c++)
        rgba[i * 4 + c] = Math.max(
          0,
          Math.min(255, (rgba[i * 4 + c] - bg[c] * (1 - alpha)) / alpha),
        );
    }
  }
  return mask;
}

const NEEDS_EXTENSION =
  'Install Background removal in Settings → Extensions to remove backgrounds from photos.';

// `model` and `loadOrt` (which returns the onnxruntime-node module) come from
// the installed Background removal extension. Flat icons need neither.
async function cutout(file, { icon = false, model = null, loadOrt = null } = {}) {
  const { data, info } = await sharp(file, { limitInputPixels, animated: false })
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const raw = { width, height, channels: 4 };
  // Uploaded PNG cutouts must keep their existing alpha, including soft edges.
  if (icon && data.some((value, i) => i % 4 === 3 && value < 255)) return null;
  let mask = icon ? flatIconMask(data, width, height) : null;
  if (!mask) {
    if (!model || !loadOrt || !fs.existsSync(model)) throw Error(NEEDS_EXTENSION);
    const ort = loadOrt();
    const session = await ort.InferenceSession.create(model, {
      executionProviders: ['cpu'],
      intraOpNumThreads: Math.max(1, Math.min(4, os.availableParallelism() - 1)),
      interOpNumThreads: 1,
      executionMode: 'sequential',
    });
    try {
      const size = 320,
        area = size * size;
      const rgb = await sharp(data, { raw })
        .flatten({ background: '#ffffff' })
        .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
        .removeAlpha()
        .raw()
        .toBuffer();
      let peak = 1;
      for (const v of rgb) if (v > peak) peak = v;
      const input = new Float32Array(area * 3);
      const mean = [0.485, 0.456, 0.406],
        std = [0.229, 0.224, 0.225];
      for (let c = 0; c < 3; c++)
        for (let i = 0; i < area; i++)
          input[c * area + i] = (rgb[i * 3 + c] / peak - mean[c]) / std[c];
      const result = await session.run({
        [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]),
      });
      const prediction = result[session.outputNames[0]].data;
      let low = Infinity,
        high = -Infinity;
      for (const v of prediction) {
        low = Math.min(low, v);
        high = Math.max(high, v);
      }
      if (!Number.isFinite(high) || high - low < 1e-6)
        throw Error('Could not find a foreground subject in this image.');
      const small = Buffer.alloc(area);
      for (let i = 0; i < area; i++)
        small[i] = Math.round((255 * (prediction[i] - low)) / (high - low));
      // Sharp expands one-channel raw inputs to sRGB unless grayscale is explicit.
      mask = await sharp(small, { raw: { width: size, height: size, channels: 1 } })
        .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
        .greyscale()
        .raw()
        .toBuffer();
      for (const tensor of Object.values(result)) tensor.dispose();
    } finally {
      await session.release();
    }
  }
  for (let i = 0; i < width * height; i++)
    data[i * 4 + 3] = Math.round((data[i * 4 + 3] * mask[i]) / 255);
  return sharp(data, { raw }).png().toBuffer();
}
module.exports = { cutout, flatIconMask, NEEDS_EXTENSION };
