import type { ArrowEnd, CanvasObject } from '../model';
import { arrowFromPoints, arrowPoints } from './arrows.ts';
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
