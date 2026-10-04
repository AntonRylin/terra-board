// Detect stale or changing source files and malformed ASAR offsets before launch.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const executable = process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe');
const archive = join(dirname(executable), 'resources', 'app.asar');
let files = 0;
for (const absolute of asar.listPackage(archive)) {
  const file = absolute.replace(/^[\\/]+/, '');
  const metadata = asar.statFile(archive, file);
  if (!metadata.integrity || metadata.unpacked) continue;
  const bytes = asar.extractFile(archive, file);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    metadata.integrity.hash,
    `ASAR integrity: ${file}`,
  );
  files++;
}
function verifyTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) verifyTree(file);
    else
      assert.ok(
        asar.extractFile(archive, relative(process.cwd(), file)).equals(readFileSync(file)),
        `Packaged source differs: ${file}`,
      );
  }
}
verifyTree(resolve('electron'));
verifyTree(resolve('dist'));
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString());
const source = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.main, source.main);
assert.equal(manifest.version, source.version);
assert.ok(
  !asar.listPackage(archive).some((file) => /^[\\/]Library[\\/]/i.test(file)),
  'Personal Library must not ship',
);
console.log(
  `PACKAGE_CONTENT_OK ${files} integrity hashes; Electron sources and renderer match; version ${manifest.version}`,
);
