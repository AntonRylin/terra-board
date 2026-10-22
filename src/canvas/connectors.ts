import type { CanvasObject } from '../model';
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
