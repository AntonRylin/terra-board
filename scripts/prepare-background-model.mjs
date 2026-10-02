// Build-time download only. The packaged app never downloads models or uploads images.
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../assets/models/u2net.onnx', import.meta.url));
const url = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx';
// Pinned after verifying rembg's published MD5: 60024c5c889badc19c04ad937298a77b.
const digest = '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491';
const valid = (bytes) => createHash('sha256').update(bytes).digest('hex') === digest;
let cached;
try {
  cached = await readFile(file);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (!cached || !valid(cached)) {
  console.log('Preparing the local background-removal model (176 MB)…');
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw Error(`Model download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw Error('Background-removal model checksum did not match.');
  await mkdir(new URL('../assets/models/', import.meta.url), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
console.log('Local background-removal model verified.');
