// Build-time download of yt-dlp, for the Song links extension
// (build-extensions.mjs). Pinned to a release and its checksum.
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ytDlp } from './payloads.mjs';

const { version, url, sha256: digest } = ytDlp;
const file = fileURLToPath(new URL('../' + ytDlp.file, import.meta.url));
const valid = (bytes) => createHash('sha256').update(bytes).digest('hex') === digest;
let cached;
try {
  cached = await readFile(file);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (!cached || !valid(cached)) {
  console.log(`Downloading yt-dlp ${version} (18 MB)…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw Error(`yt-dlp download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw Error('yt-dlp checksum did not match.');
  await mkdir(new URL('../build/yt-dlp/', import.meta.url), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
console.log(`yt-dlp ${version} verified.`);
