import type { CanvasObject } from '../model';
import { copySelection } from './stacking.ts';
import { containsObject, worldToLocal } from './transform.ts';

export interface FrameScene {
  object: CanvasObject;
  source?: CanvasObject;
  children: FrameScene[];
  status?: 'missing' | 'loading' | 'circular' | 'limit';
}
export type FrameBoards = Map<string, CanvasObject[] | null>;

/** Projection only: source objects are never inserted into the destination document. */
export function linkedFrameScene(object: CanvasObject, boards: FrameBoards): FrameScene {
  let remaining = 5000;
  const visit = (object: CanvasObject, path: Set<string>): FrameScene => {
    const scene: FrameScene = { object, children: [] };
    if (!object.frameLink) return scene;
    const { boardId, frameId } = object.frameLink;
    const key = `${boardId}/${frameId}`;
    if (path.has(key)) return { ...scene, status: 'circular' };
    if (path.size >= 12 || --remaining < 0) return { ...scene, status: 'limit' };
    if (!boards.has(boardId)) return { ...scene, status: 'loading' };
    const all = boards.get(boardId);
    const source = all?.find((o) => o.id === frameId && o.type === 'frame' && !o.frameLink);
    if (!source) return { ...scene, status: 'missing' };
    scene.source = source;
    const next = new Set(path).add(key);
    scene.children = all!
      .filter(
        (o) =>
          o.id !== frameId &&
          (source.gallery
            ? o.galleryId === source.id
            : !source.pdfComposer && containsObject(source, o)),
      )
      .sort((a, b) => a.z - b.z)
      .slice(0, Math.max(0, remaining))
      .map((o) => {
        remaining--;
        const center = worldToLocal(source, { x: o.x + o.width / 2, y: o.y + o.height / 2 });
        return visit(
          {
            ...o,
            x: center.x - o.width / 2,
            y: center.y - o.height / 2,
            rotation: ((o.rotation || 0) - (source.rotation || 0) + 360) % 360,
          },
          next,
        );
      });
    return scene;
  };
  return visit(object, new Set());
}

export function sceneObjects(scene: FrameScene): CanvasObject[] {
  return [
    scene.object,
    ...(scene.source?.pdfComposer ? [scene.source] : []),
    ...scene.children.flatMap(sceneObjects),
  ];
}

export function linkedFrameTitle(scene: FrameScene): string {
  return scene.source?.text || scene.object.text || 'Linked frame';
}

/**
 * An independent copy of a linked frame's original: the source frame and its
 * contents, placed over the link. The result keeps source ids; pasting remaps them.
 */
export function independentFrameCopy(
  link: CanvasObject,
  sourceObjects: CanvasObject[],
): CanvasObject[] | null {
  if (!link.frameLink) return null;
  const source = sourceObjects.find(
    (o) => o.id === link.frameLink!.frameId && o.type === 'frame' && !o.frameLink,
  );
  if (!source) return null;
  const dx = link.x + link.width / 2 - (source.x + source.width / 2);
  const dy = link.y + link.height / 2 - (source.y + source.height / 2);
  return copySelection(sourceObjects, [source]).map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }));
}
