import type { Library, SharingMark } from '../model';
import type { ShareRole } from '../bridge';

/** 245 MB, 2.4 MB, 812 KB: one decimal below 10, binary units like Explorer. */
export function formatBytes(bytes: number) {
  if (!(bytes > 0)) return '0 KB';
  if (bytes < 1024) {
    const whole = Math.round(bytes);
    return `${whole} ${whole === 1 ? 'byte' : 'bytes'}`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // 1023.6 KB rounds up into the next unit.
  if (rounded >= 1024 && unit < units.length - 1) return `1 ${units[unit + 1]}`;
  return `${rounded} ${units[unit]}`;
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export interface SizeInput {
  objects: number;
  contentBytes: number;
  files: number;
  fileBytes: number;
  linkedFiles: number;
}
/** "245 MB · 1,203 objects · 87 files (+2 linked files not counted)" */
export function sizeText(info: SizeInput) {
  const parts = [
    formatBytes(info.contentBytes + info.fileBytes),
    count(info.objects, 'object', 'objects'),
  ];
  if (info.files) parts.push(count(info.files, 'file', 'files'));
  const text = parts.join(' · ');
  return info.linkedFiles
    ? `${text} (+${count(info.linkedFiles, 'linked file', 'linked files')} not counted)`
    : text;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", "2 months ago". */
export function relativeTime(then: number, now = Date.now()) {
  const seconds = (now - then) / 1000;
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return ago(Math.max(1, minutes), 'minute');
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (days <= 0) return ago(Math.max(1, Math.floor(minutes / 60)), 'hour');
  if (days === 1) return 'yesterday';
  if (days < 7) return ago(days, 'day');
  if (days < 30) return ago(Math.floor(days / 7), 'week');
  if (days < 365) return ago(Math.max(1, Math.floor(days / 30.44)), 'month');
  return ago(Math.floor(days / 365.25), 'year');
}

export type BoardPlace =
  | { kind: 'local' }
  | { kind: 'kept' }
  | { kind: 'library' }
  | { kind: 'owner'; board: boolean; folder: { id: string; name: string } | null }
  | { kind: 'received'; owner: string; role: ShareRole };

export interface PlaceInput {
  boardId: string;
  folderId: string | null;
  library: Pick<Library, 'folders' | 'sharing'>;
  /** The cloud service is set up in this build. Unknown while its status loads: undefined. */
  configured: boolean | undefined;
  /** Whole-library sync is on. */
  librarySync: boolean;
  /** The board is in the store's synced set (boardSyncs). Unknown: undefined. */
  syncs: boolean | undefined;
}

/** Where the board lives, read the way the share dialog reads it. Null while unknown. */
export function boardPlace(input: PlaceInput): BoardPlace | null {
  const { boardId, folderId, library } = input;
  const sharing = library.sharing;
  const boardMark: SharingMark | undefined = sharing?.boards[boardId];
  const folderMark: SharingMark | undefined = folderId ? sharing?.folders[folderId] : undefined;
  const mark = boardMark || folderMark;
  if (input.configured === undefined) return null;
  if (!input.configured) return { kind: 'local' };
  if (mark && mark.shared !== 'owner')
    return { kind: 'received', owner: mark.owner || 'Someone', role: mark.shared };
  if (sharing?.local?.includes(boardId)) return { kind: 'kept' };
  const folder =
    folderId && folderMark?.shared === 'owner'
      ? library.folders.find((f) => f.id === folderId)
      : undefined;
  if (boardMark?.shared === 'owner' || folder)
    return {
      kind: 'owner',
      board: boardMark?.shared === 'owner',
      folder: folder ? { id: folder.id, name: folder.name } : null,
    };
  if (input.syncs === undefined && input.librarySync) return null;
  return input.librarySync && input.syncs ? { kind: 'library' } : { kind: 'local' };
}

export function placeText(place: BoardPlace) {
  switch (place.kind) {
    case 'local':
      return 'Local board';
    case 'kept':
      return 'Local board, removed from the cloud';
    case 'library':
      return 'Cloud board, synced to your devices';
    case 'owner':
      return place.board || !place.folder
        ? 'Cloud board, shared by you'
        : `Cloud board, shared through the folder “${place.folder.name}”`;
    case 'received':
      return `Shared with you by ${place.owner}, you can ${place.role}`;
  }
}

export const roleText = (role: ShareRole) => (role === 'edit' ? 'can edit' : 'can view');

/** One entry per person, keeping the stronger right when both shares include them. */
export function mergePeople<T extends { id: string; role: ShareRole }>(...lists: T[][]) {
  const people = new Map<string, T>();
  for (const list of lists)
    for (const person of list) {
      const known = people.get(person.id);
      if (!known || (known.role === 'view' && person.role === 'edit'))
        people.set(person.id, person);
    }
  return [...people.values()];
}
