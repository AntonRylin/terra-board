import type { CanvasObject } from '../model';
import { containsObject } from './transform.ts';
import { selectionWithGalleryImages } from './gallery.ts';

// An object pinned to the screen: a live copy floating over every board, in
// screen pixels. The object itself keeps its place and size on its board.
export interface ScreenPin {
  boardId: string;
  objectId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
export type PinKind = 'paper' | 'list' | 'telegram' | 'picture';
type Size = { width: number; height: number };

// Documents and checklists stay editable and Telegram frames keep running;
// everything else is a live picture.
export const pinKind = (
  o: Pick<CanvasObject, 'type'> & { file?: CanvasObject['file'] },
): PinKind =>
  o.type === 'paper'
    ? 'paper'
    : o.type === 'list'
      ? 'list'
      : o.type === 'file' && o.file?.kind === 'telegram'
        ? 'telegram'
        : 'picture';
export const pinBar = 34;
export const pinMinimum: Record<PinKind, Size> = {
  paper: { width: 260, height: 180 },
  list: { width: 200, height: 120 },
  telegram: { width: 320, height: 300 },
  picture: { width: 80, height: pinBar + 48 },
};
export const pinKey = (pin: Pick<ScreenPin, 'boardId' | 'objectId'>) =>
  `${pin.boardId}/${pin.objectId}`;

// What a pin shows: the object, and for a frame everything inside it, the way
// dragging or exporting the frame takes its contents along.
export function pinnedObjects(all: CanvasObject[], id: string): CanvasObject[] {
  const root = all.find((o) => o.id === id);
  if (!root) return [];
  const contents =
    root.type === 'frame' && !root.gallery && !root.pdfComposer && !root.frameLink
      ? all.filter((o) => o.id !== id && containsObject(root, o))
      : [];
  return selectionWithGalleryImages([root, ...contents], all).sort((a, b) => a.z - b.z);
}

export function unionBounds(boxes: { x: number; y: number; width: number; height: number }[]) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

// Keeps a pin on screen and at least its minimum size.
export function clampPin(pin: ScreenPin, view: Size, minimum: Size): ScreenPin {
  const width = Math.max(minimum.width, Math.min(view.width - 16, pin.width));
  const height = Math.max(minimum.height, Math.min(view.height - 16, pin.height));
  return {
    ...pin,
    width,
    height,
    left: Math.max(8, Math.min(view.width - width - 8, pin.left)),
    top: Math.max(8, Math.min(view.height - height - 8, pin.top)),
  };
}

// A picture keeps the shape of what it shows; the bar above it is extra.
export function fitAspect(pin: ScreenPin, aspect: number, byWidth: boolean): ScreenPin {
  if (!(aspect > 0)) return pin;
  return byWidth
    ? { ...pin, height: pin.width / aspect + pinBar }
    : { ...pin, width: (pin.height - pinBar) * aspect };
}

// Moving (no handle) or resizing from an edge or corner, in screen pixels.
export function dragPin(
  from: ScreenPin,
  handle: string | null,
  dx: number,
  dy: number,
  view: Size,
  minimum: Size,
  aspect?: number,
): ScreenPin {
  if (!handle)
    return clampPin({ ...from, left: from.left + dx, top: from.top + dy }, view, minimum);
  let next = { ...from };
  if (handle.includes('e')) next.width = from.width + dx;
  if (handle.includes('w')) next.width = from.width - dx;
  if (handle.includes('s')) next.height = from.height + dy;
  next.width = Math.max(minimum.width, next.width);
  next.height = Math.max(minimum.height, next.height);
  if (aspect) {
    // Follow whichever edge moved further; the opposite one stays put.
    const byWidth =
      handle === 'e' || handle === 'w' || (handle !== 's' && Math.abs(dx) >= Math.abs(dy) * aspect);
    next = fitAspect(next, aspect, byWidth);
    const fits = Math.min(
      1,
      (view.width - 16) / next.width,
      (view.height - 16 - pinBar) / (next.height - pinBar),
    );
    if (fits < 1) next = fitAspect({ ...next, width: next.width * fits }, aspect, true);
    if (next.width < minimum.width)
      next = fitAspect({ ...next, width: minimum.width }, aspect, true);
  }
  if (handle.includes('w')) next.left = from.left + from.width - next.width;
  return clampPin(next, view, minimum);
}

// A new pin starts over the object on screen, at a size that is easy to use.
export function placePin(
  boardId: string,
  objectId: string,
  kind: PinKind,
  screen: { left: number; top: number; width: number; height: number },
  view: Size,
  aspect?: number,
): ScreenPin {
  const minimum = pinMinimum[kind];
  let pin: ScreenPin = {
    boardId,
    objectId,
    left: screen.left,
    top: screen.top - pinBar,
    width: 0,
    height: 0,
  };
  if (kind === 'paper') {
    pin.width = Math.max(minimum.width, Math.min(view.width * 0.6, 720, screen.width));
    pin.height = Math.min(view.height - 16, screen.height + pinBar, view.height * 0.85);
  } else if (kind === 'telegram') {
    // Big enough for the chat list beside the chat, however far out the
    // board is zoomed; a little aside, so the frame's own note shows.
    pin.width = Math.min(view.width - 32, Math.max(screen.width, 760));
    pin.height = Math.min(view.height - 32, Math.max(screen.height + pinBar, 560));
    pin.left += 40;
    pin.top += 40;
  } else if (kind === 'list') {
    pin.width = Math.max(minimum.width, Math.min(view.width * 0.4, 480, screen.width));
    pin.height = Math.min(view.height * 0.7, screen.height * (pin.width / screen.width) + pinBar);
  } else {
    const a = aspect || screen.width / screen.height || 1;
    const width = Math.min(screen.width, view.width * 0.45, (view.height * 0.6 - pinBar) * a);
    pin = fitAspect({ ...pin, width: Math.max(minimum.width, Math.max(160, width)) }, a, true);
  }
  return clampPin(pin, view, minimum);
}

const storageKey = 'terra-board.pins';
export function readPins(value: string | null): ScreenPin[] {
  try {
    const list = JSON.parse(value || '[]');
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    return list
      .filter(
        (pin) =>
          pin &&
          typeof pin.boardId === 'string' &&
          typeof pin.objectId === 'string' &&
          ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(pin[k])),
      )
      .map(({ boardId, objectId, left, top, width, height }) => ({
        boardId,
        objectId,
        left,
        top,
        width,
        height,
      }))
      .filter((pin) => !seen.has(pinKey(pin)) && !!seen.add(pinKey(pin)))
      .slice(0, 64);
  } catch {
    return [];
  }
}

// Pins belong to this window, not to a board: they stay on screen while
// switching boards and after restarting the app.
let pins: ScreenPin[] | null = null;
const listeners = new Set<() => void>();
export function screenPins(): ScreenPin[] {
  if (!pins) {
    try {
      pins = readPins(localStorage.getItem(storageKey));
    } catch {
      pins = [];
    }
  }
  return pins;
}
export function setScreenPins(update: (current: ScreenPin[]) => ScreenPin[]) {
  pins = update(screenPins());
  try {
    localStorage.setItem(storageKey, JSON.stringify(pins));
  } catch {
    // Pins still work for this session.
  }
  for (const listener of listeners) listener();
}
export function subscribeScreenPins(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
