// Checks that every file in the extension catalog can be downloaded from its
// address, as installed copies will. Run it after publishing a release (npm run
// postrelease runs it after npm run release): a missing onnxruntime zip means
// nobody on that version can install Background removal.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function unreachable(catalog, fetch) {
  const missing = [];
  for (const extension of catalog.extensions || [])
    for (const file of extension.files || []) {
      let status = 0;
      try {
        status = (await fetch(file.url, { method: 'HEAD', redirect: 'follow' })).status;
      } catch {}
      if (status < 200 || status >= 300)
        missing.push({ id: extension.id, name: file.name, url: file.url, status });
    }
  return missing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(readFileSync('electron/generated/extensions.json', 'utf8'));
  const missing = await unreachable(catalog, fetch);
  for (const file of missing)
    console.error(`Missing: ${file.url} (HTTP ${file.status || 'error'})`);
  if (missing.length) {
    console.error('Upload these to the release, for example: gh release upload v<version> <file>');
    process.exit(1);
  }
  console.log('Every extension file can be downloaded.');
}
