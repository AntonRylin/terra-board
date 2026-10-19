import type { CanvasObject } from '../model';

// Web cards on the board. HTML embeds hold a page written in HTML, CSS and
// JavaScript; browser frames show a website by URL, like a browser tab. The
// board draws a captured picture of the page; the page itself runs only while
// someone interacts with it (an embed sandboxed, a website in its own session).

export const htmlSourceLimit = 1_000_000;
export const htmlCardSize = { width: 480, height: 320 };
export const browserCardSize = { width: 960, height: 640 };
// Height of a browser frame's address bar, above its page.
export const browserChrome = 40;
export const browserHome = 'https://www.google.com/';
// The page is laid out at its area's size in CSS pixels, within these bounds.
export const htmlViewportLimit = { min: 40, max: 4096 };
export const isWebCard = (o: Pick<CanvasObject, 'type'>) =>
  o.type === 'html' || o.type === 'browser';

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

const clampSide = (value: number) =>
  Math.round(Math.min(htmlViewportLimit.max, Math.max(htmlViewportLimit.min, value)));
// The page's CSS size: the whole embed, or a browser frame below its address bar.
export const pageViewport = (o: Pick<CanvasObject, 'type' | 'width' | 'height'>) => ({
  width: clampSide(o.width),
  height: clampSide(o.type === 'browser' ? o.height - browserChrome : o.height),
});

// What a picture was captured from: the page source (or address) and viewport.
// A card whose key no longer matches needs a new picture. electron/html-cards.cjs
// computes the same key.
export function snapshotKey(o: Pick<CanvasObject, 'type' | 'html' | 'url' | 'width' | 'height'>) {
  const { width, height } = pageViewport(o);
  const source = o.type === 'browser' ? 'url:' + (o.url || '') : o.html || '';
  return `${width}x${height}-${hash(source)}`;
}

export const snapshotCurrent = (o: CanvasObject) =>
  isWebCard(o) && !!o.assetId && o.snapshotKey === snapshotKey(o);

// What someone typed into a browser frame's address bar: an address, a bare
// domain, or words to search for.
export function browserAddress(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  let candidate = value;
  if (!/^https?:\/\//i.test(value))
    candidate =
      /^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(value) || /^localhost(:\d+)?(\/\S*)?$/i.test(value)
        ? // Local servers and bare IP addresses rarely speak https.
          (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(value) ? 'http://' : 'https://') +
          value
        : 'https://www.google.com/search?q=' + encodeURIComponent(value);
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) && url.href.length <= 8192 ? url.href : null;
  } catch {
    return null;
  }
}

// Pasted text that is a whole web page becomes an embed rather than a note.
export function pastedHtml(text: string): string | null {
  const value = text.trim();
  if (value.length > htmlSourceLimit) return null;
  return /^(<!doctype html[\s>]|<html[\s>])/i.test(value) && /<\/html>\s*$/i.test(value)
    ? value
    : null;
}
