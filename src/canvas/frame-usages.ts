import type { CanvasObject, Document } from '../model';
import { stackingHierarchy } from './stacking.ts';

export type FrameReference = NonNullable<CanvasObject['frameLink']>;
export interface FrameUsage {
  boardId: string;
  boardName: string;
  objectId: string;
  processId: string | null;
  processName: string;
  processPath: string[];
  occurrence: number;
  total: number;
}

export function frameReference(boardId: string, frame: CanvasObject): FrameReference {
  return frame.frameLink || { boardId, frameId: frame.id };
}

/** One result per stored link, using the same ownership as canvas interactions. */
export function findFrameUsages(source: FrameReference, documents: Document[]): FrameUsage[] {
  const results: FrameUsage[] = [];
  for (const { board, objects } of documents) {
    if (board.trashed) continue;
    const links = objects.filter(
      (o) =>
        o.type === 'frame' &&
        o.frameLink?.boardId === source.boardId &&
        o.frameLink.frameId === source.frameId,
    );
    if (!links.length) continue;
    const { parent } = stackingHierarchy(objects);
    const byId = new Map(objects.map((o) => [o.id, o]));
    const groups = new Map<string | null, FrameUsage[]>();
    for (const link of links.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))) {
      const processId = parent.get(link.id) || null;
      const path: string[] = [];
      const seen = new Set<string>();
      let ancestor = processId;
      while (ancestor && !seen.has(ancestor)) {
        seen.add(ancestor);
        path.unshift(byId.get(ancestor)?.text?.trim() || 'Untitled frame');
        ancestor = parent.get(ancestor) || null;
      }
      const group = groups.get(processId) || [];
      const result: FrameUsage = {
        boardId: board.id,
        boardName: board.name,
        objectId: link.id,
        processId,
        processName: path.at(-1) || 'On board canvas',
        processPath: path,
        occurrence: group.length + 1,
        total: 0,
      };
      group.push(result);
      groups.set(processId, group);
      results.push(result);
    }
    for (const group of groups.values()) for (const result of group) result.total = group.length;
  }
  return results.sort(
    (a, b) =>
      a.boardName.localeCompare(b.boardName) ||
      a.boardId.localeCompare(b.boardId) ||
      a.processPath.join(' / ').localeCompare(b.processPath.join(' / ')) ||
      (a.processId || '').localeCompare(b.processId || '') ||
      a.occurrence - b.occurrence,
  );
}
