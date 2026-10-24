import type { ArrowEnd, ArrowStyle, CanvasObject } from '../model';
import { arrowFromPoints, arrowPath, arrowPoints, arrowStyle } from './arrows.ts';
import { localToWorld, worldToLocal, type Point } from './transform.ts';

export type ConnectorSide = 'n' | 'e' | 's' | 'w';
export const connectorSides: ConnectorSide[] = ['n', 'e', 's', 'w'];
/** Screen pixels between the selection outline and its connector dots. */
export const connectorGap = 22;

export const canConnect = (o: CanvasObject) => o.type !== 'arrow' && o.type !== 'highlight';

/** The middle of one side, in world coordinates: where a connection starts or ends. */
export function sidePoint(o: CanvasObject, side: ConnectorSide): Point {
  return localToWorld(o, {
    x: side === 'w' ? 0 : side === 'e' ? o.width : o.width / 2,
    y: side === 'n' ? 0 : side === 's' ? o.height : o.height / 2,
  });
}

/**
 * Connector dots float just outside each side, past any name drawn above the object.
 * `top` is the object's top in local coordinates including that name (zero or less).
 */
export function connectorDot(o: CanvasObject, side: ConnectorSide, zoom: number, top = 0): Point {
  const gap = connectorGap / zoom;
  return localToWorld(o, {
    x: side === 'w' ? -gap : side === 'e' ? o.width + gap : o.width / 2,
    y: side === 'n' ? Math.min(0, top) - gap : side === 's' ? o.height + gap : o.height / 2,
  });
}

/**
 * The side of `target` that faces `from`: judged from its center, with the
 * object's proportions taken out, so a tall card still connects on its long side.
 */
export function facingSide(target: CanvasObject, from: Point): ConnectorSide {
  const q = worldToLocal(target, from),
    dx = (q.x - target.width / 2) / Math.max(target.width / 2, 1e-9),
    dy = (q.y - target.height / 2) / Math.max(target.height / 2, 1e-9);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w';
  return dy > 0 ? 's' : 'n';
}

/**
 * The side an arrow dropped at `pointer` lands on: the edge the pointer is near,
 * so any side can be picked; in the middle, the side facing `from`.
 */
export function dropSide(target: CanvasObject, pointer: Point, from: Point): ConnectorSide {
  const q = worldToLocal(target, pointer),
    dx = (q.x - target.width / 2) / Math.max(target.width / 2, 1e-9),
    dy = (q.y - target.height / 2) / Math.max(target.height / 2, 1e-9);
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 0.5) return facingSide(target, from);
  return facingSide(target, pointer);
}

/**
 * Where an arrow dropped at `pointer` meets `side` of `target`: level with the
 * pointer along that side, pulled to its middle when within `snap` of it.
 */
export function connectionPoint(
  target: CanvasObject,
  side: ConnectorSide,
  pointer: Point,
  snap: number,
): Point {
  const q = worldToLocal(target, pointer),
    vertical = side === 'e' || side === 'w',
    length = vertical ? target.height : target.width,
    along = Math.max(0, Math.min(length, vertical ? q.y : q.x)),
    at = Math.abs(along - length / 2) < snap ? length / 2 : along;
  return localToWorld(target, {
    x: vertical ? (side === 'w' ? 0 : target.width) : at,
    y: vertical ? at : side === 'n' ? 0 : target.height,
  });
}

/** Holds an arrow end at world point `w` on `target`, so it follows the object. */
export function arrowEnd(target: CanvasObject, w: Point): ArrowEnd {
  const q = worldToLocal(target, w),
    fraction = (v: number, size: number) => Math.max(0, Math.min(1, v / Math.max(size, 1e-9)));
  return { id: target.id, x: fraction(q.x, target.width), y: fraction(q.y, target.height) };
}

/** Where a held arrow end sits on its object now, in world coordinates. */
export const arrowEndPoint = (target: CanvasObject, end: ArrowEnd): Point =>
  localToWorld(target, { x: end.x * target.width, y: end.y * target.height });

/** The unit direction pointing straight out of `side`, in world coordinates. */
export function sideNormal(o: CanvasObject, side: ConnectorSide): Point {
  const c = localToWorld(o, { x: o.width / 2, y: o.height / 2 }),
    w = localToWorld(o, {
      x: o.width / 2 + (side === 'e' ? 1 : side === 'w' ? -1 : 0),
      y: o.height / 2 + (side === 's' ? 1 : side === 'n' ? -1 : 0),
    }),
    length = Math.hypot(w.x - c.x, w.y - c.y) || 1;
  return { x: (w.x - c.x) / length, y: (w.y - c.y) / length };
}

/** The outward direction of the side a held end sits on, or none when it is not on a side. */
export function endNormal(o: CanvasObject, end: { x: number; y: number }): Point | undefined {
  const e = 1e-6,
    side: ConnectorSide | undefined =
      end.x <= e ? 'w' : end.x >= 1 - e ? 'e' : end.y <= e ? 'n' : end.y >= 1 - e ? 's' : undefined;
  return side && sideNormal(o, side);
}

const dot = (p: Point, q: Point) => p.x * q.x + p.y * q.y;

/**
 * Ways from `a` to `b`, straight first: arcs bulging out past both ends, then
 * paths that leave each end straight out of its side (`na`, `nb`).
 */
function routeCandidates(a: Point, b: Point, na?: Point, nb?: Point): Point[][] {
  const list: Point[][] = [[a, b]];
  if (!na && !nb) return list;
  const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1,
    mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    sum = { x: (na?.x ?? 0) + (nb?.x ?? 0), y: (na?.y ?? 0) + (nb?.y ?? 0) },
    sumLength = Math.hypot(sum.x, sum.y),
    across = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord },
    directions = [
      ...(sumLength > 0.2 ? [{ x: sum.x / sumLength, y: sum.y / sumLength }] : []),
      across,
      { x: -across.x, y: -across.y },
    ];
  for (const n of directions)
    for (const f of [0.35, 0.7, 1.2]) {
      const out = Math.max(dot(a, n), dot(b, n)) - dot(mid, n) + f * chord;
      list.push([a, { x: mid.x + n.x * out, y: mid.y + n.y * out }, b]);
    }
  for (const f of [0.3, 0.6]) {
    const k = f * chord;
    list.push([
      a,
      ...(na ? [{ x: a.x + na.x * k, y: a.y + na.y * k }] : []),
      ...(nb ? [{ x: b.x + nb.x * k, y: b.y + nb.y * k }] : []),
      b,
    ]);
  }
  return list;
}

/** Whether a line through `points` drawn as `line` passes inside any of `objects`. */
function routeCrosses(points: Point[], line: ArrowStyle['line'], objects: CanvasObject[]) {
  const arrow = arrowFromPoints(
      {
        id: '',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        z: 0,
        arrow: { ...defaultStyle, line },
      },
      points,
    ),
    path = arrowPath(arrow).map((p) => localToWorld(arrow, p));
  for (let i = 1; i < path.length; i++)
    for (let t = 0; t <= 8; t++) {
      const p = {
        x: path[i - 1].x + ((path[i].x - path[i - 1].x) * t) / 8,
        y: path[i - 1].y + ((path[i].y - path[i - 1].y) * t) / 8,
      };
      for (const o of objects) {
        const q = worldToLocal(o, p),
          m = Math.max(0.5, Math.min(o.width, o.height) * 0.01);
        if (q.x > m && q.y > m && q.x < o.width - m && q.y < o.height - m) return true;
      }
    }
  return false;
}
const defaultStyle: ArrowStyle = {
  points: [],
  line: 'curve',
  start: 'none',
  end: 'arrow',
  dash: 'solid',
  thickness: 1,
};

/**
 * The points of an arrow from `a` to `b` whose ends leave sides facing `na` and
 * `nb`: straight when that stays clear of `objects`, otherwise the first arc or
 * detour around them.
 */
export function arrowRoute(
  a: Point,
  b: Point,
  na: Point | undefined,
  nb: Point | undefined,
  objects: CanvasObject[],
  line: ArrowStyle['line'] = 'curve',
): Point[] {
  const list = routeCandidates(a, b, na, nb);
  return list.find((c) => !routeCrosses(c, line, objects)) ?? list[1] ?? list[0];
}

const heldBy = (arrow: CanvasObject, key: 'from' | 'to', find: Find) => {
  const end = arrow.arrow?.[key],
    o = end && find(end.id);
  return o ? { o, normal: endNormal(o, end) } : undefined;
};
type Find = (id: string) => CanvasObject | undefined;

/** Whether the arrow's bends are none, or ones `arrowRoute` made for its held ends. */
export function hasAutoBends(arrow: CanvasObject, find: Find) {
  const points = arrowPoints(arrow).map((p) => localToWorld(arrow, p));
  if (points.length === 2) return true;
  const na = heldBy(arrow, 'from', find)?.normal,
    nb = heldBy(arrow, 'to', find)?.normal;
  if (!na && !nb) return false;
  const a = points[0],
    b = points[points.length - 1],
    tolerance = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y) * 1e-4);
  return routeCandidates(a, b, na, nb).some(
    (c) =>
      c.length === points.length &&
      c.every((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y) <= tolerance),
  );
}

/** Fresh points for `arrow` from `a` to `b`, around the objects its ends hold. */
export function routedPoints(arrow: CanvasObject, a: Point, b: Point, find: Find): Point[] {
  const from = heldBy(arrow, 'from', find),
    to = heldBy(arrow, 'to', find);
  return arrowRoute(
    a,
    b,
    from?.normal,
    to?.normal,
    [from?.o, to?.o].filter((o): o is CanvasObject => !!o),
    arrowStyle(arrow).line,
  );
}

/** Whether `arrow` has an end held by one of `ids`. */
export const arrowHeldBy = (arrow: CanvasObject, ids: Set<string>) =>
  arrow.type === 'arrow' &&
  (ids.has(arrow.arrow?.from?.id ?? '') || ids.has(arrow.arrow?.to?.id ?? ''));

/**
 * The arrow redrawn with its held ends on their objects (`find` looks them up).
 * Bends shift by the ends' average move, so an arrow whose two objects move
 * together keeps its shape. Returns `arrow` itself when nothing moved.
 */
export function followArrow(
  arrow: CanvasObject,
  find: (id: string) => CanvasObject | undefined,
): CanvasObject {
  const style = arrow.arrow;
  if (arrow.type !== 'arrow' || !style || (!style.from && !style.to)) return arrow;
  const points = arrowPoints(arrow).map((p) => localToWorld(arrow, p)),
    last = points.length - 1,
    from = style.from && find(style.from.id),
    to = style.to && find(style.to.id),
    a = from ? arrowEndPoint(from, style.from!) : points[0],
    b = to ? arrowEndPoint(to, style.to!) : points[last],
    da = { x: a.x - points[0].x, y: a.y - points[0].y },
    db = { x: b.x - points[last].x, y: b.y - points[last].y };
  if (Math.hypot(da.x, da.y) < 1e-6 && Math.hypot(db.x, db.y) < 1e-6) return arrow;
  // Arcs made to get around the objects are made afresh for where they are now.
  if (hasAutoBends(arrow, find)) return arrowFromPoints(arrow, routedPoints(arrow, a, b, find));
  const shift = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 };
  return arrowFromPoints(
    arrow,
    points.map((p, i) => (i === 0 ? a : i === last ? b : { x: p.x + shift.x, y: p.y + shift.y })),
  );
}

/** The arrow with only the held ends whose objects are in `keep`. */
export function keepArrowEnds(arrow: CanvasObject, keep: (id: string) => boolean): CanvasObject {
  const style = arrow.arrow;
  if (!style || (!style.from && !style.to)) return arrow;
  const from = style.from && keep(style.from.id) ? style.from : undefined,
    to = style.to && keep(style.to.id) ? style.to : undefined;
  if (from === style.from && to === style.to) return arrow;
  const { from: _from, to: _to, ...rest } = style;
  return { ...arrow, arrow: { ...rest, ...(from ? { from } : {}), ...(to ? { to } : {}) } };
}

/** A copied arrow holds the copies of its objects, or lets go of ones not copied. */
export function copyArrowEnds(arrow: CanvasObject, ids: ReadonlyMap<string, string>): CanvasObject {
  const kept = keepArrowEnds(arrow, (id) => ids.has(id)),
    style = kept.arrow;
  if (!style || (!style.from && !style.to)) return kept;
  return {
    ...kept,
    arrow: {
      ...style,
      ...(style.from ? { from: { ...style.from, id: ids.get(style.from.id)! } } : {}),
      ...(style.to ? { to: { ...style.to, id: ids.get(style.to.id)! } } : {}),
    },
  };
}
