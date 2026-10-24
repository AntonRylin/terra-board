// Where each app frame's picture goes. Windows draws it into Terra's window
// over the page (see electron/app-pictures.cjs), so it is sent as the parts
// of the frame's area that nothing of Terra's covers: the area on screen,
// minus the menus, toolbars, dialogs and frames that lie over it. Laid out at
// most once per screen refresh while something changes, and sent only when
// it changed.
import type { AppPicturePart } from '../canvas/file-link';

type Box = { x0: number; y0: number; x1: number; y1: number };
export type AppPicture = {
  // The frame's picture area.
  body: HTMLElement;
  // The app window.
  id: string;
  // Changes with the window's own size, so the parts are laid out again.
  revision: string;
};

const pictures = new Map<string, AppPicture>();
const sent = new Map<string, string>();
let frame = 0;
let until = 0;
let observer: MutationObserver | null = null;

/** Shows a frame's picture, or with null stops showing it. */
export function setAppPicture(key: string, picture: AppPicture | null) {
  if (picture) pictures.set(key, picture);
  else {
    pictures.delete(key);
    if (sent.delete(key))
      window.canvas?.files?.appPicture({ frame: key, id: '0', whole: [1, 1], parts: [] });
  }
  watch();
  scheduleAppPictures();
}

/** Lays the pictures out again on the next screen refresh, and for ms after. */
export function scheduleAppPictures(ms = 0) {
  until = Math.max(until, performance.now() + ms);
  if (!frame && pictures.size) frame = requestAnimationFrame(tick);
}

function tick() {
  frame = 0;
  update();
  if (pictures.size && performance.now() < until) frame = requestAnimationFrame(tick);
}

// Anything that changes in the page may move or cover a frame (menus and
// dialogs often slide or fade in, so a change is followed for a while).
const changed = () => scheduleAppPictures(450);
const animating = () => scheduleAppPictures(800);
const visible = () => scheduleAppPictures();
function watch() {
  if (pictures.size && !observer) {
    observer = new MutationObserver(changed);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    addEventListener('resize', changed);
    document.addEventListener('transitionrun', animating, true);
    document.addEventListener('animationstart', animating, true);
    document.addEventListener('visibilitychange', visible);
  } else if (!pictures.size && observer) {
    observer.disconnect();
    observer = null;
    removeEventListener('resize', changed);
    document.removeEventListener('transitionrun', animating, true);
    document.removeEventListener('animationstart', animating, true);
    document.removeEventListener('visibilitychange', visible);
  }
}

function update() {
  const files = window.canvas?.files;
  if (!files || document.visibilityState !== 'visible') return;
  const dpr = window.devicePixelRatio || 1;
  for (const [key, picture] of pictures) {
    const layout = layoutOf(picture.body, dpr);
    const text = `${picture.id}|${picture.revision}|${JSON.stringify(layout)}`;
    if (sent.get(key) === text) continue;
    sent.set(key, text);
    files.appPicture({ frame: key, id: picture.id, ...layout });
  }
}

const none = () => ({ whole: [1, 1] as [number, number], parts: [] as AppPicturePart[] });

/** The parts of a frame's picture area that show, in screen pixels. */
export function layoutOf(body: HTMLElement, dpr: number) {
  if (!body.isConnected) return none();
  const r = body.getBoundingClientRect();
  const width = Math.round(r.width * dpr),
    height = Math.round(r.height * dpr);
  if (width < 2 || height < 2) return none();
  let shown: Box | null = clip(boxOf(r), { x0: 0, y0: 0, x1: innerWidth, y1: innerHeight });
  // Up from the frame: what clips it, and what is drawn over it.
  const covers: Box[] = [];
  let node: Element = body;
  while (shown && node !== document.body && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    const style = getComputedStyle(parent);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible')
      shown = clip(shown, boxOf(parent.getBoundingClientRect()));
    const rank = rankOf(node);
    let after = false;
    for (const sibling of parent.children) {
      if (sibling === node) {
        after = true;
        continue;
      }
      const other = rankOf(sibling);
      if (after ? other < rank : other <= rank) continue;
      const boxes: Box[] = [];
      collect(sibling, boxes, 0);
      const over = shown ? boxes.filter((b) => clip(b, shown!)) : [];
      // A busy cover (a folder full of icons) is left out as a whole.
      covers.push(...(over.length > 6 ? [union(over)] : over));
    }
    node = parent;
  }
  if (!shown) return none();
  let pieces = [shown];
  for (const cover of covers) {
    pieces = subtract(pieces, cover);
    if (!pieces.length) return none();
  }
  if (pieces.length > 48) return none();
  // Rounded from the area's corner, so each part has the same size in
  // Terra's window as in the picture.
  const ox = Math.round(r.left * dpr),
    oy = Math.round(r.top * dpr);
  const px = (v: number, from: number, max: number) =>
    Math.max(0, Math.min(max, Math.round((v - from) * dpr)));
  const parts: AppPicturePart[] = [];
  for (const p of pieces) {
    const x0 = px(p.x0, r.left, width),
      y0 = px(p.y0, r.top, height),
      x1 = px(p.x1, r.left, width),
      y1 = px(p.y1, r.top, height);
    if (x1 > x0 && y1 > y0)
      parts.push({ dest: [ox + x0, oy + y0, ox + x1, oy + y1], src: [x0, y0, x1, y1] });
  }
  return { whole: [width, height] as [number, number], parts };
}

// Painting order among siblings: positioned elements over the rest, then by
// z-index (a later sibling paints over an earlier one of the same rank).
function rankOf(el: Element) {
  const style = getComputedStyle(el);
  if (style.position === 'static') return -1;
  const z = parseInt(style.zIndex, 10);
  return Number.isFinite(z) ? z : 0;
}

// Elements that always paint their box.
const solid = new Set([
  'IMG',
  'svg',
  'CANVAS',
  'VIDEO',
  'IFRAME',
  'WEBVIEW',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'BUTTON',
  'HR',
  'OBJECT',
  'EMBED',
]);

// The boxes an element paints: its own when it has a background, border,
// shadow or text of its own, otherwise those of its children.
function collect(el: Element, out: Box[], depth: number) {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
    return;
  const r = el.getBoundingClientRect();
  if (painted(el, style) || depth >= 12 || out.length >= 200) {
    if (r.width > 0 && r.height > 0) out.push(boxOf(r));
    return;
  }
  for (const child of el.children) collect(child, out, depth + 1);
}

function painted(el: Element, style: CSSStyleDeclaration) {
  if (solid.has(el.tagName)) return true;
  if (alpha(style.backgroundColor) > 0 || style.backgroundImage !== 'none') return true;
  if (style.boxShadow !== 'none') return true;
  const backdrop = style.getPropertyValue('backdrop-filter');
  if (backdrop && backdrop !== 'none') return true;
  for (const side of ['top', 'right', 'bottom', 'left'])
    if (
      parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
      style.getPropertyValue(`border-${side}-style`) !== 'none' &&
      alpha(style.getPropertyValue(`border-${side}-color`)) > 0
    )
      return true;
  for (const n of el.childNodes)
    if (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) return true;
  return false;
}

// A CSS color's opacity (0 to 1).
export function alpha(color: string) {
  const value = color.trim();
  if (!value || value === 'transparent') return 0;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3];
    return a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
  }
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
  if (slash) return slash[2] ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
  return 1;
}

const boxOf = (r: DOMRect): Box => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });

function clip(a: Box, b: Box): Box | null {
  const box = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

function union(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Boxes minus a cover: each box splits into up to four around it. */
export function subtract(pieces: Box[], cover: Box): Box[] {
  const out: Box[] = [];
  for (const p of pieces) {
    if (cover.x1 <= p.x0 || cover.x0 >= p.x1 || cover.y1 <= p.y0 || cover.y0 >= p.y1) {
      out.push(p);
      continue;
    }
    if (cover.y0 > p.y0) out.push({ x0: p.x0, y0: p.y0, x1: p.x1, y1: cover.y0 });
    if (cover.y1 < p.y1) out.push({ x0: p.x0, y0: cover.y1, x1: p.x1, y1: p.y1 });
    const y0 = Math.max(p.y0, cover.y0),
      y1 = Math.min(p.y1, cover.y1);
    if (cover.x0 > p.x0) out.push({ x0: p.x0, y0, x1: cover.x0, y1 });
    if (cover.x1 < p.x1) out.push({ x0: cover.x1, y0, x1: p.x1, y1 });
  }
  return out;
}
