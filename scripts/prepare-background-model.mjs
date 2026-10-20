// Build-time download of the background-removal model, for tests and for the
// Background removal extension (build-extensions.mjs). Images never leave the PC.
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { u2net } from './payloads.mjs';

const file = fileURLToPath(new URL('../' + u2net.file, import.meta.url));
const { url, sha256: digest } = u2net;
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
