import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Ship PDF fonts, CMaps and codecs locally. No preview depends on a CDN.
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  const target = resolve('public/pdfjs', directory);
  mkdirSync(target, { recursive: true });
  cpSync(resolve('node_modules/pdfjs-dist', directory), target, { recursive: true });
}
