import { Texture } from 'pixi.js';
import { mediaUrl } from '../bridge';
type Entry = { texture: Texture; bytes: number; time: number };
export class TextureCache {
  private entries = new Map<string, Entry>();
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
          if (this.bytes + bytes > 192 * 1024 * 1024) {
            this.deferred.add(key);
            return;
          }
          const texture = Texture.from(img);
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
