import type { CanvasObject } from '../model';
import { youtubeId } from './link-preview.ts';

export type LinkPreview = {
  text: string;
  linkDescription: string;
  assetId?: string;
  linkIconId?: string;
};

// Retry incomplete results without requiring a click or starting video playback.
// The caller guards board lifetime; a late result must not revive a closed board.
export async function loadLinkPreview(
  object: CanvasObject,
  fetch: (url: string) => Promise<LinkPreview | null>,
  current: () => boolean,
  apply: (preview: LinkPreview) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; attempt < 3 && current(); attempt++) {
    if (attempt) await wait(attempt * 1500);
    if (!current()) return;
    try {
      const preview = await fetch(object.url!);
      if (!current()) return;
      if (preview) {
        apply(preview);
        if (
          preview.assetId ||
          (!youtubeId(object.url!) && (preview.linkDescription || preview.linkIconId))
        )
          return;
      }
    } catch {
      /* Offline or transient failures leave a usable card and retry. */
    }
  }
}
