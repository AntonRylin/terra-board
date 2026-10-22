import type { CanvasObject, ImageAdded } from '../model';

// A profile name is short; anything longer than this is not one.
export const addedNameLimit = 200;

// A valid record of when an image was added (and by whom), or undefined.
export function addedValue(value: unknown): ImageAdded | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { at, by } = value as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1e14) return undefined;
  const name = typeof by === 'string' ? by.trim().slice(0, addedNameLimit) : '';
  return name ? { at, by: name } : { at };
}

// The record for an image added now; `name` is the profile name, if there is one.
export function addedNow(name?: string | null, now = Date.now()): ImageAdded {
  return addedValue({ at: now, by: name || undefined })!;
}

// Gives each image a fresh record of being added; other objects stay as they are.
// `added` null leaves images without one (recording is turned off).
export function stampAdded(objects: CanvasObject[], added: ImageAdded | null): CanvasObject[] {
  return objects.map((o) => {
    if (o.type !== 'image') return o;
    const { added: _old, ...rest } = o;
    const album = o.album && {
      ...o.album,
      images: o.album.images.map(({ added: _gone, ...image }) =>
        added ? { ...image, added: { ...added } } : image,
      ),
    };
    return {
      ...rest,
      ...(album ? { album } : {}),
      ...(added ? { added: { ...added } } : {}),
    };
  });
}

// "Thursday, 22 October 2026 at 14:05:32", in the computer's own format.
export function addedTimeText(at: number) {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}
