// ICOs can contain either PNGs or Windows bitmap frames. Decode the largest
// frame explicitly; Electron nativeImage does not decode bitmap-based ICOs.
async function iconPng(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 6 || data.readUInt32LE(0) !== 0x00010000) return data;
  const count = data.readUInt16LE(4);
  if (data.length > 512 * 1024 || !count || count > 64 || 6 + count * 16 > data.length)
    throw Error('Invalid site icon');
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16,
      width = data[entry] || 256,
      height = data[entry + 1] || 256;
    const size = data.readUInt32LE(entry + 8),
      offset = data.readUInt32LE(entry + 12);
    if (offset < 6 + count * 16 || size < 8 || offset + size > data.length)
      throw Error('Invalid icon frame');
    if (data.readUInt32BE(offset) === 0x89504e47) {
      if (
        size < 24 ||
        data.readUInt32BE(offset + 16) !== width ||
        data.readUInt32BE(offset + 20) !== height
      )
        throw Error('Invalid PNG icon');
    } else {
      if (
        size < 40 ||
        data.readUInt32LE(offset) !== 40 ||
        data.readUInt32LE(offset + 4) !== width ||
        data.readUInt32LE(offset + 8) !== height * 2
      )
        throw Error('Invalid bitmap icon');
      const bits = data.readUInt16LE(offset + 14);
      if (![1, 4, 8, 24, 32].includes(bits) || data.readUInt32LE(offset + 16) !== 0)
        throw Error('Unsupported bitmap icon');
      const required =
        40 + (bits <= 8 ? 2 ** bits * 4 : 0) + Math.ceil((width * bits) / 32) * 4 * height;
      if (size < required) throw Error('Truncated bitmap icon');
    }
  }
  const { decodeIco } = await import('icojs');
  const frames = await decodeIco(new Uint8Array(data), 'image/png');
  frames.sort((a, b) => b.width * b.height - a.width * a.height || b.bpp - a.bpp);
  if (!frames.length) throw Error('Empty site icon');
  return Buffer.from(frames[0].buffer);
}
module.exports = { iconPng };
