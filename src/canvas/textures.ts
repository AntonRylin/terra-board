import { Texture } from 'pixi.js';
import { mediaUrl } from '../bridge';
type Entry = { texture: Texture; bytes: number; time: number };
// Base image variants cover the same pixels. Detail tiles do not.
const fallbackKey = (key: string) => {
  const [id, variant] = key.split('/');
  return variant === 'thumb' ? `${id}/preview` : variant === 'preview' ? `${id}/thumb` : '';
};
export class TextureCache {
  private entries = new Map<string, Entry>();
  private requested = new Set<string>();
  private wanted = new Set<string>();
  private pending = new Set<string>();
  private queue: string[] = [];
  private loading = 0;
  private bytes = 0;
  private disposed = false;
  private failures = new Set<string>();
  private deferred = new Set<string>();
  constructor(private redraw: () => void) {}
  begin(wanted: Set<string>) {
    this.requested = wanted;
    // Pin the loaded variant before eviction while its replacement decodes.
    // Release that protection on the first frame with the new variant ready.
    const retained = new Set(wanted);
    for (const key of wanted) {
      const fallback = fallbackKey(key);
      if (!this.entries.has(key) && this.entries.has(fallback)) retained.add(fallback);
    }
    wanted = retained;
    if (wanted.size !== this.wanted.size || [...wanted].some((k) => !this.wanted.has(k)))
      this.deferred.clear();
    this.wanted = wanted;
    this.queue = this.queue.filter((k) => wanted.has(k));
    this.evict();
  }
  get(key: string) {
    const hit = this.entries.get(key);
    if (hit) {
      hit.time = performance.now();
      return hit.texture;
    }
    if (
      !this.pending.has(key) &&
      !this.queue.includes(key) &&
      !this.failures.has(key) &&
      !this.deferred.has(key)
    ) {
      this.queue.push(key);
      this.pump();
    }
    const fallback = this.entries.get(fallbackKey(key));
    if (fallback) {
      fallback.time = performance.now();
      return fallback.texture;
    }
    return null;
  }
  failed(key: string) {
    return this.failures.has(key);
  }
  private evict() {
    if (this.bytes < 160 * 1024 * 1024) return;
    for (const [key, e] of [...this.entries].sort((a, b) => a[1].time - b[1].time)) {
      if (this.wanted.has(key)) continue;
      this.entries.delete(key);
      this.bytes -= e.bytes;
      e.texture.destroy(true);
      if (this.bytes < 128 * 1024 * 1024) break;
    }
  }
  private pump() {
    while (this.loading < 4 && this.queue.length && !this.disposed) {
      const key = this.queue.shift()!;
      if (!this.wanted.has(key)) continue;
      this.pending.add(key);
      this.loading++;
      const [id, variant] = key.split('/'),
        img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = mediaUrl(id, variant);
      img
        .decode()
        .then(() => {
          if (this.disposed || !this.wanted.has(key)) return;
          const bytes = img.naturalWidth * img.naturalHeight * 4;
          this.evict();
          const fallbackId = fallbackKey(key);
          const fallback = !this.requested.has(fallbackId) && this.entries.get(fallbackId);
          // A loaded large preview must not prevent its smaller replacement
          // from fitting. Reclaim it only when needed, and only after the new
          // texture exists; another object's explicitly requested variant stays.
          const reclaim = this.bytes + bytes > 192 * 1024 * 1024 && fallback;
          if (this.bytes + bytes - (reclaim ? reclaim.bytes : 0) > 192 * 1024 * 1024) {
            this.deferred.add(key);
            return;
          }
          const texture = Texture.from(img);
          if (reclaim) {
            this.entries.delete(fallbackId);
            this.bytes -= reclaim.bytes;
            reclaim.texture.destroy(true);
            this.deferred.clear();
          }
          this.entries.set(key, { texture, bytes, time: performance.now() });
          this.bytes += bytes;
        })
        .catch(() => this.failures.add(key))
        .finally(() => {
          this.pending.delete(key);
          this.loading--;
          if (!this.disposed) {
            this.redraw();
            this.pump();
          }
        });
    }
  }
  destroy() {
    this.disposed = true;
    for (const e of this.entries.values()) e.texture.destroy(true);
    this.entries.clear();
    this.queue = [];
  }
}
