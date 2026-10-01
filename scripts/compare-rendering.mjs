// Compare the current build with an existing packaged build on the same warm
// synthetic library. Fixture generation is deliberately outside startup timing.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const root = resolve('.local-test/rendering-scale-library');
mkdirSync(root, { recursive: true });
const store = new Store(root);
if (!store.library().boards.length) {
  const assets = [];
  for (let i = 0; i < 1000; i++) {
    const original = await sharp({
      create: {
        width: 512,
        height: 384,
        channels: 3,
        background: { r: i % 256, g: Math.floor(i / 256) * 60, b: 120 },
      },
    })
      .png()
      .toBuffer();
    const id = createHash('sha256').update(original).digest('hex');
    const preview = await sharp(original).webp().toBuffer();
    const thumb = await sharp(original).resize(256, 192).webp().toBuffer();
    // Test fixture writes only; production import durability is tested separately.
    for (const [variant, bytes] of [
      ['original', original],
      ['preview', preview],
      ['thumb', thumb],
    ])
      writeFileSync(join(root, 'assets', `${id}.${variant}`), bytes);
    store.db
      .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?)')
      .run(id, `fixture-${i}.png`, 'image/png', 512, 384, original.length);
    assets.push(id);
  }
  const board = store.createBoard({ name: '10,000 image performance fixture' });
  store.patchBoard({
    id: board.id,
    revision: 0,
    upserts: Array.from({ length: 10000 }, (_, i) => ({
      id: `image-${i}`,
      type: 'image',
      assetId: assets[i % 1000],
      x: (i % 100) * 520,
      y: Math.floor(i / 100) * 420,
      width: 480,
      height: 360,
      z: i,
      text: `fixture-${i % 1000}.png`,
    })),
    deleted: [],
  });
  store.setLastBoard({ id: board.id });
}
store.close();
const baseline = process.argv[2] || resolve('release/win-unpacked/Terra Board.exe');
if (!existsSync(baseline)) throw Error('Provide the existing baseline executable');
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
async function run(label) {
  const child = spawn(
    label === 'baseline' ? baseline : require('electron'),
    label === 'baseline' ? ['--smoke-test'] : ['.', '--smoke-test'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (errors += chunk));
  const timer = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  const match = /DESKTOP_SMOKE (\{.*\})/.exec(output);
  if (code !== 0 || !match) throw Error(`${label} smoke failed: ${output} ${errors}`);
  return { build: label, firstCanvasMs: JSON.parse(match[1]).firstCanvasMs };
}
const results = [];
for (const label of ['baseline', 'candidate', 'candidate', 'baseline']) {
  const result = await run(label);
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(
  resolve('.local-test/rendering-startup-results.json'),
  JSON.stringify(
    {
      scope:
        'First viewport, 10000 objects / 1000 distinct synthetic 512x384 images; same warm library; not sustained FPS or all images decoded',
      results,
    },
    null,
    2,
  ),
);
