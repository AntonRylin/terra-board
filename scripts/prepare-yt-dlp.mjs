// Build-time download of yt-dlp, which fetches the audio of a song link (YouTube
// and many other sites) for entrance songs. Pinned to a release and its checksum.
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const version = '2026.08.19';
const file = fileURLToPath(new URL('../build/yt-dlp/yt-dlp.exe', import.meta.url));
const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp.exe`;
// From the release's SHA2-256SUMS.
const digest = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a';
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
