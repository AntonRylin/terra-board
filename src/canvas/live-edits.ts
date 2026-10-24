import type { CanvasObject, Edit } from '../model';

// Edits on a cloud board reach the other people on it the moment they happen, over the
// board's live channel, the way cursors do. Sync stores the same edits a moment later;
// until it has, the live copy is what the board shows. While someone drags, resizes or
// turns objects, those objects are sent too, up to 20 times a second.

export type LiveMessage =
  | { kind: 'edit'; upserts: CanvasObject[]; deleted: string[] }
  | { kind: 'moving'; objects: CanvasObject[]; done?: boolean };

// Each message costs money on the server, and Realtime refuses large ones: bigger edits
// (a big paste) and drags of many objects wait for sync.
export const FRAME_MS = 50;
const MAX_OBJECTS = 200;
const MAX_CHARACTERS = 100_000;
// How long an edit that arrived live outranks an older stored copy (sync is behind).
export const LIVE_HOLD_MS = 20_000;
// A drag shown from elsewhere goes back if its end never arrives.
export const MOVING_HOLD_MS = 3000;

type Timers = {
  now: () => number;
  setTimeout: (job: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};
const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (job, ms) => setTimeout(job, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const fits = (objects: unknown[], extra: unknown[] = []) =>
  objects.length + extra.length <= MAX_OBJECTS &&
  JSON.stringify(objects).length + JSON.stringify(extra).length <= MAX_CHARACTERS;

// Files an object shows. Another computer may not have them yet, so objects that bring
// new ones wait for sync, which downloads the files first.
export function assetsOf(o: CanvasObject): string[] {
  const ids = [
    o.assetId,
    o.linkIconId,
    o.documentPreviewId,
    ...(o.pdfComposer?.sources || []).map((s) => s.assetId),
    ...(o.album?.images || []).map((image) => image.assetId),
  ];
  return ids.filter((id): id is string => typeof id === 'string' && !!id);
}

// The same object, whatever the order of its keys.
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
export const sameObject = (a: CanvasObject, b: CanvasObject) => stable(a) === stable(b);

// This person's side: what to send, and when.
export class LiveSender {
  private next: CanvasObject[] | null = null;
  private timer: unknown = null;
  private last = -Infinity;
  private moved = false;
  private send: (message: LiveMessage) => void;
  private timers: Timers;
  constructor(send: (message: LiveMessage) => void, timers: Timers = realTimers) {
    this.send = send;
    this.timers = timers;
  }

  edit(edit: Edit) {
    // The drag's frames are over: where the objects landed follows.
    this.dropFrame();
    if (!edit.upserts.length && !edit.deleted.length) return;
    if (!fits(edit.upserts, edit.deleted)) return;
    this.send({ kind: 'edit', upserts: edit.upserts, deleted: edit.deleted });
  }

  // The objects a gesture changes, as it goes; null when it ends.
  moving(objects: CanvasObject[] | null) {
    if (!objects) {
      this.dropFrame();
      if (this.moved) {
        this.moved = false;
        this.send({ kind: 'moving', objects: [], done: true });
      }
      return;
    }
    this.next = objects;
    const wait = FRAME_MS - (this.timers.now() - this.last);
    if (wait <= 0) this.frame();
    else this.timer ??= this.timers.setTimeout(() => this.frame(), wait);
  }

  stop() {
    this.dropFrame();
  }

  private frame() {
    this.timer = null;
    const objects = this.next;
    this.next = null;
    if (!objects?.length || !fits(objects)) return;
    this.last = this.timers.now();
    this.moved = true;
    this.send({ kind: 'moving', objects });
  }

  private dropFrame() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.next = null;
  }
}

// The board as the live receiver sees it.
export interface LiveTarget {
  get(id: string): CanvasObject | undefined;
  // Shows objects where someone else has them right now: no history, nothing saved.
  show(objects: CanvasObject[]): void;
  // Applies an edit someone else made; sync stores it, so it is not saved here.
  accept(edit: Edit): void;
  // Being changed here right now (typed into, dragged): this person's version wins.
  busy(id: string): boolean;
}

// The other people's side: shows what arrives, and keeps it until sync catches up.
export class LiveReceiver {
  // Objects shown mid-drag, with what they were before it.
  private moving = new Map<string, { key: string; base: CanvasObject; at: number }>();
  // Edits that arrived live (null: deleted), until the stored copy has them.
  private held = new Map<string, { object: CanvasObject | null; at: number }>();
  private timer: unknown = null;
  private target: LiveTarget;
  private timers: Timers;
  constructor(target: LiveTarget, timers: Timers = realTimers) {
    this.target = target;
    this.timers = timers;
  }

  receive(key: string, message: LiveMessage) {
    if (message.kind === 'moving') this.receiveMoving(key, message);
    else this.receiveEdit(message);
  }

  private receiveMoving(key: string, message: Extract<LiveMessage, { kind: 'moving' }>) {
    if (message.done) {
      this.revert((m) => m.key === key);
      return;
    }
    const now = this.timers.now();
    const shown: CanvasObject[] = [];
    for (const o of message.objects) {
      const current = this.target.get(o.id);
      if (!current || this.target.busy(o.id)) continue;
      const entry = this.moving.get(o.id);
      if (entry) {
        entry.key = key;
        entry.at = now;
      } else this.moving.set(o.id, { key, base: current, at: now });
      shown.push(o);
    }
    if (!shown.length) return;
    this.target.show(shown);
    this.watch();
  }

  private receiveEdit(message: Extract<LiveMessage, { kind: 'edit' }>) {
    const upserts = message.upserts.filter((o) => {
      if (this.target.busy(o.id)) return false;
      const current = this.moving.get(o.id)?.base ?? this.target.get(o.id);
      const known = new Set(current ? assetsOf(current) : []);
      return assetsOf(o).every((id) => known.has(id));
    });
    const deleted = message.deleted.filter((id) => this.target.get(id) && !this.target.busy(id));
    if (!upserts.length && !deleted.length) return;
    // A drag shown from elsewhere ends where the objects really landed; undo here goes
    // back to where they were before it.
    const touched = new Set([...upserts.map((o) => o.id), ...deleted]);
    const bases = [...touched].flatMap((id) => {
      const entry = this.moving.get(id);
      this.moving.delete(id);
      return entry ? [entry.base] : [];
    });
    if (bases.length) this.target.show(bases);
    const at = this.timers.now();
    for (const o of upserts) this.held.set(o.id, { object: o, at });
    for (const id of deleted) this.held.set(id, { object: null, at });
    this.target.accept({ upserts, deleted });
  }

  // This person's own edits win over anything shown from elsewhere.
  local(edit: Edit) {
    for (const id of [...edit.upserts.map((o) => o.id), ...edit.deleted]) {
      this.moving.delete(id);
      this.held.delete(id);
    }
  }

  // Before the board takes the stored copy after a sync: drags shown from elsewhere go
  // back to where they started (their next frame shows them again), and edits that
  // arrived live but are not stored yet stay instead of jumping back.
  merge(objects: CanvasObject[]): CanvasObject[] {
    this.revert(() => true);
    const now = this.timers.now();
    for (const [id, h] of this.held) if (now - h.at > LIVE_HOLD_MS) this.held.delete(id);
    if (!this.held.size) return objects;
    const byId = new Map(objects.map((o) => [o.id, o]));
    let kept = false;
    for (const [id, h] of this.held) {
      const stored = byId.get(id);
      const caughtUp = h.object ? !!stored && sameObject(stored, h.object) : !stored;
      if (caughtUp) this.held.delete(id);
      else {
        kept = true;
        if (h.object) byId.set(id, h.object);
        else byId.delete(id);
      }
    }
    return kept ? [...byId.values()] : objects;
  }

  // Before the board takes a stored copy that is newer than anything shown live (an AI
  // edit): drags shown from elsewhere go back, and the stored copy is taken as it is.
  settle(objects: CanvasObject[]): CanvasObject[] {
    this.revert(() => true);
    this.held.clear();
    return objects;
  }

  stop() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.moving.clear();
    this.held.clear();
  }

  private revert(which: (entry: { key: string; base: CanvasObject; at: number }) => boolean) {
    const bases: CanvasObject[] = [];
    for (const [id, entry] of this.moving)
      if (which(entry)) {
        this.moving.delete(id);
        if (!this.target.busy(id)) bases.push(entry.base);
      }
    if (bases.length) this.target.show(bases);
  }

  // Drags whose end never came (the other app closed mid-drag) go back.
  private watch() {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      const now = this.timers.now();
      this.revert((m) => now - m.at >= MOVING_HOLD_MS);
      if (this.moving.size) this.watch();
    }, MOVING_HOLD_MS);
  }
}
