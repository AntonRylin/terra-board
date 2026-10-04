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
      exePath: path.join(repo, 'release', 'win-unpacked', 'Terra Board.exe'),
    }),
    path.join(repo, 'Library'),
  );
});

test('an explicit test library overrides the default without accessing the real library', () => {
  const isolated = path.resolve('.local-test', 'isolated-library');
  assert.equal(libraryRoot({ isPackaged: true, dataDir: isolated }), isolated);
});

test('installed builds keep each user library outside the replaceable installation directory', () => {
  const localAppData = path.resolve('fixture', 'User with spaces', 'AppData', 'Local');
  const expected = path.join(localAppData, 'Terra Board', 'Library');
  for (const install of [
    path.resolve('fixture', 'Program Files', 'Terra Board'),
    path.resolve('fixture', 'Custom install'),
  ]) {
    assert.equal(
      libraryRoot({
        isPackaged: true,
        distribution: 'installed',
        localAppData,
        exePath: path.join(install, 'Terra Board.exe'),
      }),
      expected,
    );
  }
  const isolated = path.resolve('.local-test', 'installer-library');
  assert.equal(
    libraryRoot({ isPackaged: true, distribution: 'installed', dataDir: isolated }),
    isolated,
  );
});

test('installed builds reject missing or relative user storage instead of writing beside system files', () => {
  for (const localAppData of [undefined, '', 'relative-folder']) {
    assert.throws(
      () =>
        libraryRoot({
          isPackaged: true,
          distribution: 'installed',
          localAppData,
          exePath: path.resolve('fixture', 'Program Files', 'Terra Board', 'Terra Board.exe'),
        }),
      /local application data folder/i,
    );
  }
});
