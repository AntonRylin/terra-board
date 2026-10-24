import type { CloudStatus } from '../../bridge';
import type { Board, Library } from '../../model';
import { boardPlace, type BoardPlace } from '../board-info-text';

export type PlaceGroup = 'local' | 'cloud' | 'received';

export interface PlacedBoard {
  board: Board;
  place: BoardPlace;
  group: PlaceGroup;
  folder: string | null;
  /** People who reach it through your shares (board and folder), when you share it. */
  people: number;
}

// Where every board in the library lives, read the way the share dialog reads it. With
// whole-library sync on, every board that isn't kept local syncs (store-sync sync_tracked).
export function placeBoards(library: Library, status: CloudStatus | null): PlacedBoard[] {
  const shares = status?.shared ?? [];
  return library.boards
    .filter((b) => !b.trashed)
    .map((board) => {
      const place = boardPlace({
        boardId: board.id,
        folderId: board.folderId,
        library,
        configured: status ? status.configured : false,
        librarySync: !!status?.identity && !!status?.library,
        syncs: !!status?.identity && !!status?.library,
      }) ?? { kind: 'local' as const };
      const group: PlaceGroup =
        place.kind === 'received'
          ? 'received'
          : place.kind === 'owner' || place.kind === 'library'
            ? 'cloud'
            : 'local';
      const people = shares
        .filter(
          (s) =>
            (s.kind === 'board' && s.targetId === board.id) ||
            (s.kind === 'folder' && s.targetId === board.folderId),
        )
        .reduce((n, s) => n + s.people, 0);
      const folder = board.folderId
        ? (library.folders.find((f) => f.id === board.folderId)?.name ?? null)
        : null;
      return { board, place, group, folder, people };
    })
    .sort((a, b) => a.board.name.localeCompare(b.board.name));
}

export function countPlaces(boards: PlacedBoard[]) {
  const counts = { local: 0, cloud: 0, shared: 0, received: 0 };
  for (const b of boards) {
    counts[b.group]++;
    if (b.group === 'cloud' && b.place.kind === 'owner') counts.shared++;
  }
  return counts;
}

export const plural = (n: number, one: string, many = one + 's') =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
