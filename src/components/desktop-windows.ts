// One poll of Windows' desktops and windows for every Desktops frame and app
// frame on screen, every 1.5 s while any is mounted and the page is visible.
// Also remembers which window each app frame shows (only on this computer,
// for this session: boards store the program, never a window).
import { useSyncExternalStore } from 'react';
import type { DesktopWindow, DesktopsState } from '../canvas/file-link';

let state: DesktopsState | null = null;
let key = '';
let timer = 0;
let running = false;
const listeners = new Set<() => void>();

async function poll() {
  const files = window.canvas?.files;
  if (running || !files) return;
  running = true;
  let next: DesktopsState;
  try {
    next = await files.desktops();
  } catch (error) {
    next = { supported: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    running = false;
  }
  const nextKey = JSON.stringify(next);
  if (nextKey === key) return;
  key = nextKey;
  state = next;
  for (const listener of listeners) listener();
}

/** Reads again now (after switching, focusing or closing something). */
export function refreshDesktops(delay = 0) {
  window.setTimeout(() => void poll(), delay);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void poll();
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, 1500);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.clearInterval(timer);
  };
}

export function useDesktops() {
  return useSyncExternalStore(subscribe, () => state);
}

// App frame id → the window it shows.
const bindings = new Map<string, string>();
export function bindAppWindow(frameId: string, windowId: string) {
  bindings.set(frameId, windowId);
}
export function releaseAppWindow(frameId: string) {
  bindings.delete(frameId);
}

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/**
 * The window an app frame shows: the one it was given while it is open,
 * otherwise the first window of its program that no other frame shows.
 */
export function appWindowFor(frameId: string, exe: string | null, windows: DesktopWindow[]) {
  const bound = bindings.get(frameId);
  const kept = bound ? windows.find((w) => w.id === bound) : undefined;
  if (kept) return kept;
  if (!exe) return undefined;
  const taken = new Set([...bindings].filter(([id]) => id !== frameId).map(([, w]) => w));
  const found = windows.find((w) => w.exe && samePath(w.exe, exe) && !taken.has(w.id));
  if (found) bindings.set(frameId, found.id);
  else bindings.delete(frameId);
  return found;
}
