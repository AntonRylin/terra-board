import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const testDirectory = fileURLToPath(new URL('../.local-test/', import.meta.url));
mkdirSync(testDirectory, { recursive: true });
const root = mkdtempSync(join(testDirectory, 'canvas-desktop-'));
if (process.env.CANVAS_SCALE === '1') {
  const { Store } = require('../electron/store.cjs'),
    sharp = require('sharp');
  const store = new Store(root),
    started = performance.now(),
    assets = [];
  try {
    for (let i = 0; i < 1000; i++) {
      const bytes = await sharp({
        create: {
          width: 512,
          height: 384,
          channels: 3,
          background: { r: i % 256, g: Math.floor(i / 256) * 60, b: 120 },
        },
      })
        .png()
        .toBuffer();
      assets.push(await store.importAsset({ bytes, name: `fixture-${i}.png` }));
    }
    const board = store.createBoard({ name: 'Scale fixture' });
    const objects = Array.from({ length: 10000 }, (_, i) => ({
      id: `image-${i}`,
      type: 'image',
      assetId: assets[i % assets.length].id,
      x: (i % 100) * 520,
      y: Math.floor(i / 100) * 420,
      width: 480,
      height: 360,
      z: i,
    }));
    store.patchBoard({
      id: board.id,
      revision: 0,
      operationId: 'scale-fixture',
      upserts: objects,
      deleted: [],
    });
    store.setLastBoard({ id: board.id });
    console.log(
      'SCALE_FIXTURE',
      JSON.stringify({
        objects: objects.length,
        distinctImages: assets.length,
        fixtureMs: Math.round(performance.now() - started),
        scope:
          'First viewport startup; synthetic 512x384 images; not full-board GPU or decode throughput',
      }),
    );
  } finally {
    store.close();
  }
}
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const child = spawn(
  process.env.CANVAS_EXECUTABLE || require('electron'),
  process.env.CANVAS_EXECUTABLE ? ['--smoke-test'] : ['.', '--smoke-test'],
  {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (d) => {
  output += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));
const timer = setTimeout(() => child.kill(), 30000);
child.on('exit', (code) => {
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
  process.exit(code === 0 && output.includes('DESKTOP_SMOKE') ? 0 : 1);
});
