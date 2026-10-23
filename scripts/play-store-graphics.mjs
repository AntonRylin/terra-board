// Google Play listing graphics (docs/play-store.md): the 512×512 app icon and the
// 1024×500 feature graphic, made from assets/icon.png. Writes docs/play-store/.
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const local = (url) => url.pathname.replace(/^\/(\w:)/, '$1');
const out = new URL('../docs/play-store/', import.meta.url);
mkdirSync(local(out), { recursive: true });
const icon = local(new URL('../assets/icon.png', import.meta.url));

// Play wants a 512×512 PNG; its mask rounds the corners, so the mark keeps a margin.
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#f7f8fa' } })
  .composite([{ input: await sharp(icon).resize(448, 448).toBuffer(), gravity: 'center' }])
  .png()
  .toFile(local(new URL('icon-512.png', out)));

const font = "font-family='Segoe UI, Arial, sans-serif'";
// A sticky note with up to three lines of text.
const note = (x, y, w, h, fill, lines, size = 15, rotate = 0) => `
  <g transform="rotate(${rotate} ${x + w / 2} ${y + h / 2})">
    <rect x="${x + 2}" y="${y + 4}" width="${w}" height="${h}" rx="6" fill="#0b1f3a" opacity="0.10"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}"/>
    ${lines
      .map(
        (t, i) =>
          `<text x="${x + 12}" y="${y + 26 + i * (size + 6)}" ${font} font-size="${size}" fill="#27303d">${t}</text>`,
      )
      .join('')}
  </g>`;
// The board both devices show: notes, a checklist, a "photo", an arrow and a live cursor.
const board = (s) => `
  <g transform="scale(${s})">
    ${note(24, 24, 150, 96, '#fff2a8', ['Fly out Fri 7:40', 'Back Tue evening'])}
    ${note(196, 18, 150, 96, '#f4e5e9', ['Pastéis de nata', 'at Manteigaria'], 15, 2)}
    ${note(24, 142, 150, 96, '#d9ecff', ['Tram 28 early,', 'before the crowds'], 15, -2)}
    <g>
      <rect x="196" y="138" width="150" height="110" rx="8" fill="#ffffff" stroke="#e1e6ee"/>
      <text x="208" y="160" ${font} font-size="14" font-weight="600" fill="#27303d">Packing</text>
      ${['Passport', 'Shoes', 'Sunscreen']
        .map(
          (t, i) => `
        <rect x="208" y="${172 + i * 24}" width="13" height="13" rx="3" fill="${i < 2 ? '#387aca' : '#ffffff'}" stroke="#387aca"/>
        ${i < 2 ? `<path d="M 211 ${178 + i * 24} l 3 3 l 5 -6" stroke="#fff" stroke-width="2" fill="none"/>` : ''}
        <text x="228" y="${183 + i * 24}" ${font} font-size="13" fill="#4a5263">${t}</text>`,
        )
        .join('')}
    </g>
    <g>
      <rect x="370" y="30" width="170" height="120" rx="8" fill="url(#photo)"/>
      <path d="M 370 128 L 410 96 L 438 118 L 470 84 L 540 132 L 540 142 Q 540 150 532 150 L 378 150 Q 370 150 370 142 Z" fill="#2f6f5e" opacity="0.85"/>
      <circle cx="508" cy="58" r="12" fill="#ffe28a"/>
    </g>
    <path d="M 174 196 C 270 290, 400 260, 452 160" stroke="#387aca" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M 444 166 L 452 158 L 458 170" stroke="#387aca" stroke-width="3" fill="none" stroke-linecap="round"/>
    ${note(370, 176, 170, 74, '#e4eee8', ['Sintra – book Pena', 'Palace tickets!'])}
    <g transform="translate(300 196)">
      <path d="M 0 0 L 0 22 L 6 16 L 11 27 L 15 25 L 10 15 L 18 15 Z" fill="#e0567a" stroke="#fff" stroke-width="1.5"/>
      <rect x="14" y="22" width="52" height="20" rx="10" fill="#e0567a"/>
      <text x="40" y="36" text-anchor="middle" ${font} font-size="12" font-weight="600" fill="#fff">Anna</text>
    </g>
  </g>`;
const dots = `<pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse">
  <circle cx="2" cy="2" r="1.3" fill="#c9d4e3"/></pattern>`;

const feature = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16325c"/>
      <stop offset="0.55" stop-color="#2a5ea8"/>
      <stop offset="1" stop-color="#5b9bea"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.72" cy="0.45" r="0.55">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="photo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8ec5f0"/>
      <stop offset="1" stop-color="#f6d7a8"/>
    </linearGradient>
    ${dots}
    <clipPath id="laptopScreen"><rect x="440" y="62" width="520" height="320" rx="6"/></clipPath>
    <clipPath id="phoneScreen"><rect x="808" y="196" width="150" height="270" rx="18"/></clipPath>
  </defs>
  <rect width="1024" height="500" fill="url(#bg)"/>
  <rect width="1024" height="500" fill="url(#glow)"/>
  <g opacity="0.18" fill="none" stroke="#ffffff" stroke-width="2">
    <circle cx="-40" cy="520" r="220"/><circle cx="-40" cy="520" r="300"/>
  </g>

  <g transform="translate(78 22) scale(0.9)">
  <!-- Laptop -->
  <rect x="428" y="50" width="544" height="344" rx="16" fill="#0e1a2b"/>
  <g clip-path="url(#laptopScreen)">
    <rect x="440" y="62" width="520" height="320" fill="#f7f9fc"/>
    <rect x="440" y="62" width="520" height="320" fill="url(#dots)"/>
    <rect x="440" y="62" width="44" height="320" fill="#eef2f7"/>
    ${[0, 1, 2, 3]
      .map(
        (i) =>
          `<rect x="450" y="${78 + i * 40}" width="24" height="24" rx="6" fill="${['#ffd9a8', '#cfe0fa', '#d9ecdf', '#eadff5'][i]}"/>`,
      )
      .join('')}
    <g transform="translate(496 74)">${board(0.84)}</g>
  </g>
  <path d="M 396 394 L 1004 394 L 1016 410 Q 1018 418 1008 418 L 392 418 Q 382 418 384 410 Z" fill="#c8d2e0"/>
  <rect x="650" y="394" width="100" height="6" rx="3" fill="#a9b6c8"/>

  <!-- Phone -->
  <rect x="798" y="184" width="170" height="294" rx="26" fill="#0e1a2b"/>
  <g clip-path="url(#phoneScreen)">
    <rect x="808" y="196" width="150" height="270" fill="#f7f9fc"/>
    <rect x="808" y="196" width="150" height="270" fill="url(#dots)"/>
    <g transform="translate(812 214)">${board(0.38)}</g>
    <rect x="822" y="428" width="122" height="26" rx="13" fill="#ffffff" stroke="#e1e6ee"/>
    ${[0, 1, 2, 3, 4]
      .map(
        (i) => `<circle cx="${838 + i * 22}" cy="441" r="5" fill="${i ? '#9aa6b8' : '#387aca'}"/>`,
      )
      .join('')}
  </g>
  <rect x="862" y="190" width="42" height="6" rx="3" fill="#0e1a2b"/>

  </g>

  <!-- Words -->
  <text x="64" y="218" ${font} font-size="58" font-weight="700" fill="#ffffff">Terra Board</text>
  <text x="66" y="268" ${font} font-size="23" fill="#dbe7f8">Your whiteboards, on every screen.</text>
  ${['Live sync', 'Works offline', 'No ads']
    .map((t, i) => {
      const w = [104, 134, 86][i];
      const x = 66 + [0, 116, 262][i];
      return `<rect x="${x}" y="300" width="${w}" height="34" rx="17" fill="#ffffff" fill-opacity="0.14" stroke="#ffffff" stroke-opacity="0.35"/>
        <text x="${x + w / 2}" y="322" text-anchor="middle" ${font} font-size="15" fill="#ffffff">${t}</text>`;
    })
    .join('')}
</svg>`;
await sharp(Buffer.from(feature))
  .composite([{ input: await sharp(icon).resize(96, 96).toBuffer(), left: 62, top: 72 }])
  .png()
  .toFile(local(new URL('feature-1024x500.png', out)));
console.log('Wrote docs/play-store/icon-512.png and feature-1024x500.png');
