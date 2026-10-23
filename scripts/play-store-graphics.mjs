// Google Play listing graphics (docs/play-store.md): the 512×512 app icon and the
// 1024×500 feature graphic, made from assets/icon.png. Writes docs/play-store/.
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const out = new URL('../docs/play-store/', import.meta.url);
mkdirSync(out, { recursive: true });
const icon = new URL('../assets/icon.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

// Play wants a 32-bit PNG, 512×512, no transparency at the edges cut off by its mask.
await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#f7f8fa' },
})
  .composite([{ input: await sharp(icon).resize(448, 448).toBuffer(), gravity: 'center' }])
  .png()
  .toFile(new URL('icon-512.png', out).pathname.replace(/^\/(\w:)/, '$1'));

const feature = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f9fc"/>
      <stop offset="1" stop-color="#e4ecfa"/>
    </linearGradient>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.6" fill="#c9d4e3"/>
    </pattern>
  </defs>
  <rect width="1024" height="500" fill="url(#bg)"/>
  <rect width="1024" height="500" fill="url(#dots)" opacity="0.7"/>
  <rect x="640" y="78" width="250" height="150" rx="16" fill="#fff2a8"/>
  <rect x="700" y="252" width="250" height="150" rx="16" fill="#d9ecff"/>
  <rect x="600" y="270" width="80" height="80" rx="14" fill="#e4eee8"/>
  <path d="M 890 230 C 930 250, 940 270, 920 300" stroke="#387aca" stroke-width="5" fill="none" stroke-linecap="round"/>
  <text x="88" y="250" font-family="Segoe UI, Arial, sans-serif" font-size="68" font-weight="600" fill="#27303d">Terra Board</text>
  <text x="90" y="306" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#5d6878">Your boards from your computer,</text>
  <text x="90" y="346" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#5d6878">on your phone.</text>
</svg>`;
await sharp(Buffer.from(feature))
  .composite([{ input: await sharp(icon).resize(120, 120).toBuffer(), left: 88, top: 70 }])
  .png()
  .toFile(new URL('feature-1024x500.png', out).pathname.replace(/^\/(\w:)/, '$1'));
console.log('Wrote docs/play-store/icon-512.png and feature-1024x500.png');
