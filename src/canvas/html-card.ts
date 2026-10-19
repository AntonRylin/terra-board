import type { CanvasObject } from '../model';

// HTML embeds: a web page written in HTML, CSS and JavaScript. The board draws
// a captured picture of the page; the page itself runs, sandboxed, only while
// someone interacts with it or edits its code.

export const htmlSourceLimit = 500_000;
export const htmlCardSize = { width: 480, height: 320 };
// The page is laid out at the card's size in CSS pixels, within these bounds.
export const htmlViewportLimit = { min: 40, max: 4096 };

export const starterHtml = `<!doctype html>
<html>
<head>
<style>
  body {
    margin: 0;
    height: 100vh;
    display: grid;
    place-items: center;
    font-family: "Segoe UI", system-ui, sans-serif;
    background: linear-gradient(135deg, #f6f8fb, #e6ecf5);
    color: #1f2a37;
  }
  .card { text-align: center; }
  h1 { margin: 0 0 6px; font-size: 28px; font-weight: 650; }
  p { margin: 0 0 18px; color: #5b6878; }
  button {
    font: inherit;
    padding: 9px 18px;
    border: 0;
    border-radius: 999px;
    background: #2f6fed;
    color: white;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Hello from HTML</h1>
    <p>Double-click to interact. Edit the code to make it yours.</p>
    <button id="count">Clicked 0 times</button>
  </div>
  <script>
    let clicks = 0;
    const button = document.getElementById('count');
    button.addEventListener('click', () => {
      clicks++;
      button.textContent = 'Clicked ' + clicks + (clicks === 1 ? ' time' : ' times');
    });
  </script>
</body>
</html>
`;

// 53-bit string hash (cyrb53). Identifies a snapshot, not a security check.
function hash(value: string) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const htmlViewport = (o: Pick<CanvasObject, 'width' | 'height'>) => ({
  width: Math.round(Math.min(htmlViewportLimit.max, Math.max(htmlViewportLimit.min, o.width))),
  height: Math.round(Math.min(htmlViewportLimit.max, Math.max(htmlViewportLimit.min, o.height))),
});

// The source and viewport a picture was captured from. A card whose key no
// longer matches needs a new picture.
export function htmlSnapshotKey(o: Pick<CanvasObject, 'html' | 'width' | 'height'>) {
  const { width, height } = htmlViewport(o);
  return `${width}x${height}-${hash(o.html || '')}`;
}

export const htmlSnapshotCurrent = (o: CanvasObject) =>
  o.type === 'html' && !!o.assetId && o.htmlSnapshotKey === htmlSnapshotKey(o);

// Pasted text that is a whole web page becomes an embed rather than a note.
export function pastedHtml(text: string): string | null {
  const value = text.trim();
  if (value.length > htmlSourceLimit) return null;
  return /^(<!doctype html[\s>]|<html[\s>])/i.test(value) && /<\/html>\s*$/i.test(value)
    ? value
    : null;
}
