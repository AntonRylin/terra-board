import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { libraryRoot } = require('../electron/storage-paths.cjs');

test('development and packaged apps use the same repository library from any working directory', () => {
  const repo = path.resolve('fixture', 'Проект с пробелами');
  assert.equal(libraryRoot({ isPackaged: false, appPath: repo }), path.join(repo, 'Library'));
  assert.equal(
    libraryRoot({
      isPackaged: true,
      appPath: path.join(repo, 'release', 'win-unpacked', 'resources', 'app.asar'),
      exePath: path.join(repo, 'release', 'win-unpacked', 'Local Canvas.exe'),
    }),
    path.join(repo, 'Library'),
  );
});

test('an explicit test library overrides the default without accessing the real library', () => {
  const isolated = path.resolve('.local-test', 'isolated-library');
  assert.equal(libraryRoot({ isPackaged: true, dataDir: isolated }), isolated);
});
