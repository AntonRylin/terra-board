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
  // The next screen frame (requestAnimationFrame).
  frame: (job: () => void) => unknown;
  cancelFrame: (id: unknown) => void;
};
const realTimers: Timers = {
  now: () => performance.now(),
  setTimeout: (job, ms) => setTimeout(job, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  frame: (job) => requestAnimationFrame(() => job()),
  cancelFrame: (id) => cancelAnimationFrame(id as number),
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

// --- Smooth motion -------------------------------------------------------------------
// Positions from other people arrive 10 to 20 times a second, while the screen draws 60 to
// 144 times. Each one glides from where the thing is on screen to where it was sent, over
// a little more than the time between updates, so motion stays steady instead of jumping.

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Degrees, the short way round.
const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * t) % 360) + 360) % 360;
};

// `b`, with its position, size, turn and arrow points part of the way from `a`.
export function between(a: CanvasObject, b: CanvasObject, t: number): CanvasObject {
  if (t >= 1) return b;
  const o: CanvasObject = {
    ...b,
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
  };
  if (a.rotation || b.rotation) o.rotation = lerpAngle(a.rotation || 0, b.rotation || 0, t);
  const from = a.arrow?.points,
    to = b.arrow?.points;
  if (from && to && b.arrow && from.length === to.length)
    o.arrow = {
      ...b.arrow,
      points: to.map((p, i) => ({ ...p, x: lerp(from[i].x, p.x, t), y: lerp(from[i].y, p.y, t) })),
    };
  return o;
}

const geometryChanged = (a: CanvasObject, b: CanvasObject) =>
  a.x !== b.x ||
  a.y !== b.y ||
  a.width !== b.width ||
  a.height !== b.height ||
  (a.rotation || 0) !== (b.rotation || 0) ||
  stable(a.arrow?.points ?? null) !== stable(b.arrow?.points ?? null);

// How long each glide lasts, from how often updates have been arriving from each person.
export class Pace {
  private last = new Map<string, number>();
  private gap = new Map<string, number>();
  private expected: number;
  constructor(expected: number) {
    this.expected = expected;
  }
  next(key: string, now: number) {
    const before = this.last.get(key);
    this.last.set(key, now);
    let gap = this.gap.get(key) ?? this.expected;
    // A pause (they held still) says nothing about the pace.
    if (before !== undefined && now - before < 400)
      gap = gap * 0.7 + Math.max(16, now - before) * 0.3;
    this.gap.set(key, gap);
    return Math.min(200, Math.max(30, gap * 1.25));
  }
}

type Point = { x: number; y: number };
// One gliding point per key: other people's cursors.
export class Glides {
  private items = new Map<string, { from: Point; to: Point; start: number; duration: number }>();
  private pace: Pace;
  private now: () => number;
  constructor(expected: number, now: () => number = () => performance.now()) {
    this.pace = new Pace(expected);
    this.now = now;
  }
  set(key: string, to: Point) {
    const now = this.now();
    const from = this.at(key, now) ?? to;
    this.items.set(key, { from, to, start: now, duration: this.pace.next(key, now) });
  }
  at(key: string, now = this.now()): Point | null {
    const g = this.items.get(key);
    if (!g) return null;
    const t = Math.min(1, (now - g.start) / g.duration);
    return { x: lerp(g.from.x, g.to.x, t), y: lerp(g.from.y, g.to.y, t) };
  }
  delete(key: string) {
    this.items.delete(key);
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

// An object on its way from what is on screen to where it was sent.
type Glide = {
  from: CanvasObject;
  to: CanvasObject;
  shown: CanvasObject;
  start: number;
  duration: number;
};
// Mid-drag, with what it was before the drag.
type Moving = Glide & { key: string; base: CanvasObject; at: number };
// Objects moved without a drag (aligned, nudged, undone over there) glide this long.
export const LAND_MS = 140;

// The other people's side: shows what arrives, and keeps it until sync catches up.
export class LiveReceiver {
  private moving = new Map<string, Moving>();
  // Objects gliding to where an edit from elsewhere put them; the edit is already applied.
  private landing = new Map<string, Glide>();
  // Edits that arrived live (null: deleted), until the stored copy has them.
  private held = new Map<string, { object: CanvasObject | null; at: number }>();
  private timer: unknown = null;
  private frameId: unknown = null;
  private pace = new Pace(FRAME_MS);
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
    const duration = this.pace.next(key, now);
    let any = false;
    for (const o of message.objects) {
      const current = this.target.get(o.id);
      if (!current || this.target.busy(o.id)) continue;
      const landing = this.landing.get(o.id);
      this.landing.delete(o.id);
      const entry = this.moving.get(o.id);
      const shown = entry?.shown ?? landing?.shown ?? current;
      if (entry) Object.assign(entry, { key, at: now, from: shown, to: o, start: now, duration });
      else
        this.moving.set(o.id, {
          key,
          at: now,
          base: landing?.to ?? current,
          from: shown,
          to: o,
          shown,
          start: now,
          duration,
        });
      any = true;
    }
    if (!any) return;
    this.animate();
    this.watch();
  }

  private receiveEdit(message: Extract<LiveMessage, { kind: 'edit' }>) {
    const upserts = message.upserts.filter((o) => {
      if (this.target.busy(o.id)) return false;
      const current =
        this.moving.get(o.id)?.base ?? this.landing.get(o.id)?.to ?? this.target.get(o.id);
      const known = new Set(current ? assetsOf(current) : []);
      return assetsOf(o).every((id) => known.has(id));
    });
    const deleted = message.deleted.filter((id) => this.target.get(id) && !this.target.busy(id));
    if (!upserts.length && !deleted.length) return;
    // What is on screen now: the objects glide from there to where they landed. Before the
    // edit the board goes back to where they were before any drag, which undo returns to.
    const touched = new Set([...upserts.map((o) => o.id), ...deleted]);
    const onScreen = new Map<string, { object: CanvasObject; duration: number }>();
    const bases: CanvasObject[] = [];
    for (const id of touched) {
      const entry = this.moving.get(id),
        landing = this.landing.get(id),
        shown = entry?.shown ?? landing?.shown ?? this.target.get(id);
      if (shown) onScreen.set(id, { object: shown, duration: entry?.duration ?? LAND_MS });
      if (entry) bases.push(entry.base);
      else if (landing) bases.push(landing.to);
      this.moving.delete(id);
      this.landing.delete(id);
    }
    if (bases.length) this.target.show(bases);
    const now = this.timers.now();
    for (const o of upserts) this.held.set(o.id, { object: o, at: now });
    for (const id of deleted) this.held.set(id, { object: null, at: now });
    this.target.accept({ upserts, deleted });
    const starts: CanvasObject[] = [];
    for (const o of upserts) {
      const from = onScreen.get(o.id);
      if (!from || !geometryChanged(from.object, o)) continue;
      const shown = between(from.object, o, 0);
      this.landing.set(o.id, {
        from: from.object,
        to: o,
        shown,
        start: now,
        duration: from.duration,
      });
      starts.push(shown);
    }
    // Shown before the board draws them where they landed.
    if (starts.length) {
      this.target.show(starts);
      this.animate();
    }
  }

  // This person's own edits win over anything shown from elsewhere.
  local(edit: Edit) {
    for (const id of [...edit.upserts.map((o) => o.id), ...edit.deleted]) {
      this.moving.delete(id);
      this.landing.delete(id);
      this.held.delete(id);
    }
  }

  // Before the board takes the stored copy after a sync: drags shown from elsewhere go
  // back to where they started (their next frame shows them again), and edits that
  // arrived live but are not stored yet stay instead of jumping back.
  merge(objects: CanvasObject[]): CanvasObject[] {
    this.land();
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
    this.land();
    this.revert(() => true);
    this.held.clear();
    return objects;
  }

  stop() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    if (this.frameId !== null) this.timers.cancelFrame(this.frameId);
    this.timer = this.frameId = null;
    this.moving.clear();
    this.landing.clear();
    this.held.clear();
  }

  private revert(which: (entry: Moving) => boolean) {
    const bases: CanvasObject[] = [];
    for (const [id, entry] of this.moving)
      if (which(entry)) {
        this.moving.delete(id);
        if (!this.target.busy(id)) bases.push(entry.base);
      }
    if (bases.length) this.target.show(bases);
  }

  // Glides still under way end where they are going, at once.
  private land() {
    const ends = [...this.landing].filter(([id]) => !this.target.busy(id)).map(([, g]) => g.to);
    this.landing.clear();
    if (ends.length) this.target.show(ends);
  }

  private animate() {
    this.frameId ??= this.timers.frame(() => this.tick());
  }

  private tick() {
    this.frameId = null;
    const now = this.timers.now();
    const shown: CanvasObject[] = [];
    let going = false;
    const step = (g: Glide) => {
      const t = (now - g.start) / g.duration;
      g.shown = t >= 1 ? g.to : between(g.from, g.to, t);
      shown.push(g.shown);
      return g.shown !== g.to;
    };
    for (const [id, m] of this.moving)
      if (m.shown !== m.to && !this.target.busy(id) && step(m)) going = true;
    for (const [id, g] of this.landing)
      if (this.target.busy(id) || !step(g)) this.landing.delete(id);
      else going = true;
    if (shown.length) this.target.show(shown);
    if (going) this.animate();
  }

  // Drags whose end never came (the other app closed mid-drag) go back.
  private watch() {
    if (this.timer !== null || !this.moving.size) return;
    const oldest = Math.min(...[...this.moving.values()].map((m) => m.at));
    const wait = Math.max(16, oldest + MOVING_HOLD_MS - this.timers.now());
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      const now = this.timers.now();
      this.revert((m) => now - m.at >= MOVING_HOLD_MS);
      this.watch();
    }, wait);
  }
}
