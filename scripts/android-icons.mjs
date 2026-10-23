// Writes the Android launcher icons and splash screens (android/app/src/main/res)
// from assets/icon.png. Run after changing the icon: node scripts/android-icons.mjs
import sharp from 'sharp';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const res = 'android/app/src/main/res';
const icon = 'assets/icon.png';
const paper = { r: 247, g: 248, b: 250, alpha: 1 };
const white = { r: 255, g: 255, b: 255, alpha: 1 };
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

async function onCanvas(size, artSize, background, round = false) {
  const art = await sharp(icon).resize(artSize, artSize).png().toBuffer();
  let base = sharp({ create: { width: size, height: size, channels: 4, background } });
  const layers = [{ input: art, gravity: 'center' }];
  if (round) {
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`,
    );
    layers.push({ input: mask, blend: 'dest-in' });
  }
  return base.composite(layers).png().toBuffer();
}

for (const [name, scale] of Object.entries(densities)) {
  const dir = join(res, 'mipmap-' + name);
  const legacy = Math.round(48 * scale),
    adaptive = Math.round(108 * scale);
  await sharp(await onCanvas(legacy, Math.round(legacy * 0.78), white)).toFile(
    join(dir, 'ic_launcher.png'),
  );
  await sharp(await onCanvas(legacy, Math.round(legacy * 0.78), white, true)).toFile(
    join(dir, 'ic_launcher_round.png'),
  );
  // Adaptive icons crop to the middle 66dp of 108dp.
  await sharp(
    await onCanvas(adaptive, Math.round(adaptive * 0.56), { r: 0, g: 0, b: 0, alpha: 0 }),
  ).toFile(join(dir, 'ic_launcher_foreground.png'));
}

for (const dir of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
  const file = join(res, dir, 'splash.png');
  if (!existsSync(file)) continue;
  const { width, height } = await sharp(file).metadata();
  const art = await sharp(icon)
    .resize(Math.round(Math.min(width, height) * 0.22))
    .png()
    .toBuffer();
  const out = await sharp({ create: { width, height, channels: 4, background: paper } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toBuffer();
  await sharp(out).toFile(file);
}
console.log('Android icons and splash screens written.');
