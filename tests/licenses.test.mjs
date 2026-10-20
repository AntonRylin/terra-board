import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { collectLicenses } = require('../electron/licenses.cjs');

function writeJson(file, value) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test('collects main packages, optional natives, the renderer list and payloads', () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/licenses-'));
  const app = join(root, 'app');
  const resources = join(root, 'resources');
  writeJson(join(app, 'package.json'), {
    dependencies: { a: '1.0.0' },
    optionalDependencies: { b: '1.0.0', missing: '1.0.0' },
  });
  writeJson(join(app, 'node_modules/a/package.json'), {
    name: 'a',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { c: '^2.0.0' },
  });
  writeJson(join(app, 'node_modules/c/package.json'), {
    name: 'c',
    version: '2.0.0',
    license: 'ISC',
  });
  writeJson(join(app, 'node_modules/b/package.json'), {
    name: 'b',
    version: '1.0.0',
    license: 'Apache-2.0 AND LGPL-3.0-or-later',
  });
  // What Vite bundled into the renderer; `a` is in both and is listed once.
  writeJson(join(app, 'dist/licenses.json'), [
    { name: 'react', version: '19.3.0', license: 'MIT' },
    { name: 'a', version: '1.0.0', license: 'MIT' },
  ]);
  mkdirSync(join(resources, 'yt-dlp'), { recursive: true });
  writeFileSync(join(resources, 'yt-dlp', 'yt-dlp.exe'), '');

  const list = collectLicenses({ appPath: app, resourcesPath: resources });
  assert.deepEqual(
    list.map((entry) => entry.name),
    ['a', 'b', 'c', 'react', 'yt-dlp'],
  );
  assert.deepEqual(list[1], {
    name: 'b',
    version: '1.0.0',
    license: 'Apache-2.0 AND LGPL-3.0-or-later',
  });
  assert.equal(list[4].license, 'Unlicense');
});
