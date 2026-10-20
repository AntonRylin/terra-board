import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { collectLicenses, bundledPackages } = require('../electron/licenses.cjs');

function writeJson(file, value) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test('collects main packages, optional natives, the renderer list and payloads', () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/licenses-'));
  const app = join(root, 'app');

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
  // Installed extensions: their payloads and the packages inside them.
  const extensions = join(root, 'Extensions');
  const file = (path) => {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, '');
  };
  file(join(extensions, 'song-links', 'yt-dlp.exe'));
  file(join(extensions, 'background-removal', 'u2net.onnx'));
  writeJson(join(extensions, 'background-removal/node_modules/onnxruntime-node/package.json'), {
    name: 'onnxruntime-node',
    version: '1.30.0',
    license: 'MIT',
  });
  file(
    join(
      extensions,
      'background-removal/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/vcruntime140.dll',
    ),
  );
  file(join(extensions, 'office-files/libreoffice-26.2.6/program/soffice.com'));

  const list = collectLicenses({ appPath: app, extensionsRoot: extensions });
  assert.deepEqual(
    list.map((entry) => entry.name),
    [
      'a',
      'b',
      'c',
      'LibreOffice',
      'Microsoft Visual C++ Runtime',
      'onnxruntime-node',
      'react',
      'U-2-Net background-removal model',
      'yt-dlp',
    ],
  );
  assert.deepEqual(list[1], {
    name: 'b',
    version: '1.0.0',
    license: 'Apache-2.0 AND LGPL-3.0-or-later',
  });
  assert.deepEqual(list[3], { name: 'LibreOffice', version: '26.2.6', license: 'MPL-2.0' });
  assert.equal(list[8].license, 'Unlicense');
  // Without extensions, only what the app itself ships is listed.
  assert.deepEqual(
    collectLicenses({ appPath: app, extensionsRoot: join(root, 'none') }).map((e) => e.name),
    ['a', 'b', 'c', 'react'],
  );
});

// jszip resolves to a prebuilt file that already contains lie and immediate,
// so the bundle never shows them as modules; their declared dependencies count.
test('bundled packages include the dependencies their prebuilt files contain', () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const base = mkdtempSync(resolve('.local-test/bundled-')).split('\\').join('/');
  writeJson(join(base, 'node_modules/jszip/package.json'), {
    name: 'jszip',
    version: '3.10.2',
    license: '(MIT OR GPL-3.0-or-later)',
    dependencies: { lie: '~3.3.0' },
  });
  writeJson(join(base, 'node_modules/jszip/node_modules/lie/package.json'), {
    name: 'lie',
    version: '3.3.0',
    license: 'MIT',
    dependencies: { immediate: '~3.0.5' },
  });
  writeJson(join(base, 'node_modules/immediate/package.json'), {
    name: 'immediate',
    version: '3.0.6',
    license: 'MIT',
  });
  writeJson(join(base, 'node_modules/@scope/react/package.json'), {
    name: '@scope/react',
    version: '1.0.0',
    license: 'MIT',
  });
  const list = bundledPackages(
    [
      `${base}/node_modules/jszip/dist/jszip.min.js`,
      `\0${base}/node_modules/@scope/react/index.js?commonjs-proxy`,
      `${base}/src/main.tsx`,
    ],
    base,
  );
  assert.deepEqual(
    list.map((entry) => `${entry.name}@${entry.version}`),
    ['@scope/react@1.0.0', 'immediate@3.0.6', 'jszip@3.10.2', 'lie@3.3.0'],
  );
});
