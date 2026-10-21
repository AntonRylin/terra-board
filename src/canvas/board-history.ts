// Board history (store.cjs boardHistory): naming and grouping changes for the History panel.
import type { CanvasObject, HistoryEntry } from '../model.ts';

const typeNames: Record<string, string> = {
  list: 'List',
  table: 'Table',
  paper: 'Document',
  text: 'Text',
  note: 'Note',
  frame: 'Frame',
  image: 'Image',
  document: 'Document',
  video: 'Video',
  link: 'Link',
  rect: 'Shape',
  ellipse: 'Shape',
  arrow: 'Arrow',
  highlight: 'Highlight',
  html: 'HTML embed',
  browser: 'Browser',
};
export const typeName = (o: CanvasObject) => typeNames[o.type] || 'Object';

// The words a person would recognise the object by.
export function objectExcerpt(o: CanvasObject, max = 160): string {
  const parts = [
    o.text,
    o.documentTitle,
    o.imageTitle,
    o.url,
    ...(o.items || []).map((item) => item.text),
  ];
  const value = parts
    .filter((part): part is string => typeof part === 'string' && !!part.trim())
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value;
}

const geometry = new Set(['x', 'y', 'width', 'height', 'points']);
// What an edit changed, in a few words.
export function editSummary(before: CanvasObject, after: CanvasObject | null): string {
  if (!after) return 'Edited';
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter(
    (key) => JSON.stringify((before as never)[key]) !== JSON.stringify((after as never)[key]),
  );
  if (!changed.length) return 'Edited';
  const moved = changed.some((k) => k === 'x' || k === 'y');
  const resized = changed.some((k) => k === 'width' || k === 'height' || k === 'points');
  const words: string[] = [];
  if (changed.some((k) => k === 'text' || k === 'items' || k === 'table' || k === 'html'))
    words.push(before.type === 'frame' ? 'Renamed' : 'Text changed');
  if (moved) words.push('Moved');
  if (resized && !(moved && words.length === 1 && changed.every((k) => geometry.has(k))))
    words.push('Resized');
  if (changed.some((k) => k === 'z')) words.push('Reordered');
  if (changed.some((k) => !geometry.has(k) && !['text', 'items', 'table', 'html', 'z'].includes(k)))
    words.push('Restyled');
  return words.length ? words.join(', ') : 'Edited';
}

export interface HistoryGroup {
  key: string;
  revision: number;
  at: number;
  source: HistoryEntry['source'];
  entries: HistoryEntry[];
}
// One group per save: everything one edit changed together.
export function groupHistory(entries: HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.revision === entry.revision && last.source === entry.source)
      last.entries.push(entry);
    else
      groups.push({
        key: `${entry.revision}-${entry.seq}`,
        revision: entry.revision,
        at: entry.at,
        source: entry.source,
        entries: [entry],
      });
  }
  return groups;
}

// The object a restore puts back: the version before this change.
export const restorable = (entry: HistoryEntry) =>
  entry.action === 'create' ? null : entry.before;

export function historyTime(at: number, now = Date.now()): string {
  const date = new Date(at),
    today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86400000,
  );
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export const sourceLabel: Record<HistoryEntry['source'], string | null> = {
  local: null,
  ai: 'AI',
  guest: 'Guest',
  cloud: 'Synced',
};
