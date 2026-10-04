import type { Camera, Edit, CanvasObject } from '../model';
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';
// View state has no content revision or save indicator. Keep one snapshot,
// including during long animated zoom gestures, and persist after idle.
export class CameraSaveQueue {
  private saved: Camera;
  private pending: Camera | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private send: (camera: Camera) => Promise<unknown>;
  private onError: (error: unknown) => void;
  constructor(
    camera: Camera,
    send: (camera: Camera) => Promise<unknown>,
    onError: (error: unknown) => void,
  ) {
    this.saved = { ...camera };
    this.send = send;
    this.onError = onError;
  }
  enqueue(camera: Camera) {
    const previous = this.pending || (!this.running ? this.saved : null);
    if (
      previous &&
      previous.x === camera.x &&
      previous.y === camera.y &&
      previous.zoom === camera.zoom
    )
      return;
    this.pending = { ...camera };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(this.onError), 1200);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running.then(() => this.flush());
    if (!this.pending) return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async run() {
    while (this.pending) {
      const camera = this.pending;
      this.pending = null;
      try {
        await this.send(camera);
        this.saved = camera;
      } catch (error) {
        this.pending ||= camera;
        throw error;
      }
    }
  }
}
interface Request extends Edit {
  id: string;
  revision: number;
  operationId: string;
  camera?: Camera;
}
export class SaveQueue {
  private id: string;
  private revision: number;
  private status: (s: SaveState, message?: string) => void;
  private send: (r: Request) => Promise<{ revision: number }>;
  private queue: (Edit & { camera?: Camera })[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private inflight: { request: Request; count: number } | null = null;
  constructor(
    id: string,
    revision: number,
    status: (s: SaveState, message?: string) => void,
    send: (r: Request) => Promise<{ revision: number }>,
  ) {
    this.id = id;
    this.revision = revision;
    this.status = status;
    this.send = send;
  }
  enqueue(edit: Edit, camera?: Camera) {
    this.queue.push({ ...edit, camera });
    this.status('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), 350);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running)
      return this.running.then(() => (this.queue.length ? this.flush() : undefined));
    if (!this.queue.length) return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async run() {
    while (this.queue.length) {
      if (!this.inflight) {
        const count = this.queue.length,
          upserts = new Map<string, CanvasObject>(),
          deleted = new Set<string>();
        let camera: Camera | undefined;
        for (const e of this.queue.slice(0, count)) {
          for (const o of e.upserts) {
            upserts.set(o.id, o);
            deleted.delete(o.id);
          }
          for (const id of e.deleted) {
            deleted.add(id);
            upserts.delete(id);
          }
          if (e.camera) camera = e.camera;
        }
        this.inflight = {
          count,
          request: {
            id: this.id,
            revision: this.revision,
            operationId: crypto.randomUUID(),
            upserts: [...upserts.values()],
            deleted: [...deleted],
            camera,
          },
        };
      }
      this.status('saving');
      try {
        const result = await this.send(this.inflight.request);
        this.revision = result.revision;
        this.queue.splice(0, this.inflight.count);
        this.inflight = null;
      } catch (e) {
        this.status('error', String(e));
        throw e;
      }
    }
    this.status('saved');
  }
}
