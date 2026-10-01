import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';

type Item = {
  id: string;
  kind: string;
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type Gesture = { id: string; kind: string; group: string; container: HTMLElement; items: Item[] };
type Preview = { order: string[]; folder: string | null };
export function useLauncherReorder(
  library: unknown,
  commit: (change: {
    id: string;
    kind: string;
    group: string;
    position?: number;
    folder?: string;
  }) => Promise<void>,
) {
  const gesture = useRef<Gesture | null>(null);
  const draft = useRef<Preview | null>(null);
  const committing = useRef(false);
  const beforeCommit = useRef(library);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const reset = () => {
    gesture.current = null;
    draft.current = null;
    setSource(null);
    setPreview(null);
  };
  // The persisted DOM order now occupies the preview slots. Remove transforms
  // before paint so a successful drop never slides back to the old order.
  useLayoutEffect(() => {
    if (committing.current && library !== beforeCommit.current) reset();
  }, [library]);
  const start = (event: DragEvent<HTMLElement>, id: string, kind: string) => {
    const container = event.currentTarget.closest<HTMLElement>('[data-reorder-group]');
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>(':scope > [data-reorder-id]')].map(
      (el) => ({
        id: el.dataset.reorderId!,
        kind: el.dataset.reorderKind!,
        position: Number(el.dataset.order),
        x: el.offsetLeft,
        y: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      }),
    );
    gesture.current = { id, kind, container, group: container.dataset.reorderGroup!, items };
    committing.current = false;
    draft.current = null;
    setPreview(null);
    setSource(id);
  };
  const over = (event: DragEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || event.currentTarget !== g.container) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = g.container.getBoundingClientRect();
    const x = event.clientX - bounds.left + g.container.scrollLeft;
    const y = event.clientY - bounds.top + g.container.scrollTop;
    // A board over the middle of a folder goes inside it; its outer edges
    // remain available for rearranging the mixed board/folder strip.
    const folder = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-reorder-kind="folder"]',
    );
    const r = folder?.getBoundingClientRect();
    const horizontal =
      g.container.scrollWidth > g.container.clientWidth || bounds.width > bounds.height;
    const centered =
      r &&
      (horizontal
        ? event.clientX > r.left + r.width * 0.3 && event.clientX < r.right - r.width * 0.3
        : event.clientY > r.top + r.height * 0.3 && event.clientY < r.bottom - r.height * 0.3);
    const folderId =
      g.kind === 'board' && g.group === 'root' && centered ? folder!.dataset.reorderId! : null;
    const nearest = g.items.reduce(
      (best, item, index) => {
        const distance = Math.hypot(x - item.x - item.width / 2, y - item.y - item.height / 2);
        return distance < best.distance ? { index, distance } : best;
      },
      { index: 0, distance: Infinity },
    ).index;
    const order = g.items.filter((item) => item.id !== g.id).map((item) => item.id);
    order.splice(nearest, 0, g.id);
    const next = { order: folderId ? g.items.map((item) => item.id) : order, folder: folderId };
    if (JSON.stringify(next) !== JSON.stringify(draft.current)) {
      draft.current = next;
      setPreview(next);
    }
  };
  const drop = (event: DragEvent<HTMLElement>): boolean => {
    const g = gesture.current;
    if (!g || g.container !== event.currentTarget) return false;
    event.preventDefault();
    event.stopPropagation();
    const next = draft.current;
    if (!next || (!next.folder && next.order.every((id, index) => id === g.items[index].id))) {
      reset();
      return true;
    }
    const index = next.order.indexOf(g.id);
    const left = g.items.find((item) => item.id === next.order[index - 1])?.position;
    const right = g.items.find((item) => item.id === next.order[index + 1])?.position;
    const position =
      left === undefined
        ? (right ?? 1) - 1
        : right === undefined
          ? left + 1
          : left + (right - left) / 2;
    committing.current = true;
    beforeCommit.current = library;
    void commit({
      id: g.id,
      kind: g.kind,
      group: g.group,
      position,
      ...(next.folder ? { folder: next.folder } : {}),
    }).finally(() => {
      committing.current = false;
      reset();
    });
    return true;
  };
  const style = (id: string): CSSProperties | undefined => {
    const g = gesture.current;
    if (!g || !preview) return undefined;
    const from = g.items.find((item) => item.id === id);
    const to = g.items[preview.order.indexOf(id)];
    if (!from || !to) return undefined;
    return { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px)` };
  };
  return {
    start,
    over,
    drop,
    style,
    source,
    folder: preview?.folder,
    end: () => {
      if (!committing.current) reset();
    },
  };
}
