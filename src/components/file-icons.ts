// Icons of files and folders for folder frames, fetched from the desktop app
// (Explorer's own icons and thumbnails) at the size they cover on screen.
// Newest requests go first, so what was just scrolled into view loads first.
import { useSyncExternalStore } from 'react';

type Request = { key: string; path: string; size: number; modified: number };
const tiers = [256, 128, 64, 32];
const cache = new Map<string, string | null>();
const pending: Request[] = [];
const queued = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let running = false;
let timer = 0;

const keyOf = (path: string, modified: number, size: number) => `${size}|${modified}|${path}`;

function notify() {
  version++;
  for (const listener of listeners) listener();
}

async function run() {
  const files = window.canvas?.files;
  if (running || !files) return;
  running = true;
  try {
    while (pending.length) {
      const batch = pending.splice(Math.max(0, pending.length - 12));
      let urls: (string | null)[] = [];
      try {
        urls = await files.icons(
          batch.map(({ path, size, modified }) => ({ path, size, modified })),
        );
      } catch {}
      batch.forEach((request, i) => {
        queued.delete(request.key);
        cache.set(request.key, urls[i] ?? null);
      });
      while (cache.size > 3000) cache.delete(cache.keys().next().value!);
      notify();
    }
  } finally {
    running = false;
  }
}

/** The best icon there is now for an item, asking for the wanted size if missing. */
export function fileIcon(path: string, modified: number, size: number): string | null | undefined {
  const exact = cache.get(keyOf(path, modified, size));
  if (exact !== undefined) return exact;
  const key = keyOf(path, modified, size);
  if (!queued.has(key)) {
    queued.add(key);
    pending.push({ key, path, size, modified });
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 16);
  }
  for (const tier of tiers) {
    const url = cache.get(keyOf(path, modified, tier));
    if (url) return url;
  }
  return undefined;
}

/** Any icon already loaded for these items (the picture a drag carries). */
export function loadedIcon(path: string, modified: number) {
  for (const tier of tiers) {
    const url = cache.get(keyOf(path, modified, tier));
    if (url) return url;
  }
  return undefined;
}

/** Forgets queued requests nobody shows any more (a folder that was left). */
export function dropQueued(paths: Set<string>) {
  for (let i = pending.length - 1; i >= 0; i--)
    if (paths.has(pending[i].path)) {
      queued.delete(pending[i].key);
      pending.splice(i, 1);
    }
}

/** Re-renders when icons arrive. */
export function useFileIcons() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
