import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

type Item = {
  id: string;
  kind: string;
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type Group = { container: HTMLElement; id: string; items: Item[] };
type Preview = { group: Group; order: string[]; folder: string | null };
type Gesture = {
  id: string;
  kind: string;
  origin: Group;
  groups: Group[];
  element: HTMLElement;
  avatar: HTMLElement;
  avatarStyle: string | null;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  active: boolean;
  released: boolean;
};
const snapshot = (container: HTMLElement): Group => ({
  container,
  id: container.dataset.reorderGroup!,
  items: [...container.querySelectorAll<HTMLElement>(':scope > [data-reorder-id]')].map((el) => ({
    id: el.dataset.reorderId!,
    kind: el.dataset.reorderKind!,
    position: Number(el.dataset.order),
    x: el.offsetLeft,
    y: el.offsetTop,
    width: el.offsetWidth,
    height: el.offsetHeight,
  })),
});
const inside = (x: number, y: number, r: DOMRect, slack = 0) =>
  x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack;

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
  const frame = useRef(0);
  const settling = useRef<Animation | null>(null);
  const committing = useRef(false);
  const beforeCommit = useRef(library);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const clear = () => {
    cancelAnimationFrame(frame.current);
    settling.current?.cancel();
    settling.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (g) {
      if (g.avatar.matches(':popover-open')) g.avatar.hidePopover();
      g.avatar.removeAttribute('popover');
      delete g.avatar.dataset.reorderAvatar;
      if (g.avatarStyle === null) g.avatar.removeAttribute('style');
      else g.avatar.setAttribute('style', g.avatarStyle);
      if (g.element.hasPointerCapture(g.pointer)) g.element.releasePointerCapture(g.pointer);
    }
    document.body.classList.remove('reordering');
    draft.current = null;
    setSource(null);
    setPreview(null);
  };
  useLayoutEffect(() => {
    if (committing.current && library !== beforeCommit.current) clear();
  }, [library]);

  const update = () => {
    const g = gesture.current;
    if (!g || !g.active || g.released) return;
    g.avatar.style.left = `${g.x - g.offsetX}px`;
    g.avatar.style.top = `${g.y - g.offsetY}px`;
    // Drifting slightly off the narrow strip keeps sorting instead of cancelling.
    const group =
      g.groups.find(({ container }) => inside(g.x, g.y, container.getBoundingClientRect())) ||
      (inside(g.x, g.y, g.origin.container.getBoundingClientRect(), 40) ? g.origin : undefined);
    let next: Preview | null = null;
    if (group && (group === g.origin || g.kind === 'board')) {
      const bounds = group.container.getBoundingClientRect();
      const horizontal = group.id === 'root' && bounds.width > bounds.height;
      const coordinate = horizontal ? g.x : g.y;
      const low = horizontal ? bounds.left : bounds.top,
        high = horizontal ? bounds.right : bounds.bottom;
      const speed =
        coordinate < low + 24
          ? -Math.min(9, (low + 24 - coordinate) / 3)
          : coordinate > high - 24
            ? Math.min(9, (coordinate - high + 24) / 3)
            : 0;
      if (horizontal) group.container.scrollLeft += speed;
      else group.container.scrollTop += speed;
      const x = g.x - bounds.left + group.container.scrollLeft,
        y = g.y - bounds.top + group.container.scrollTop;
      // Stable layout slots avoid repeatedly swapping targets as siblings animate.
      const folder =
        g.kind === 'board' && group.id === 'root'
          ? group.items.find(
              (item) =>
                item.kind === 'folder' &&
                x >= item.x &&
                x <= item.x + item.width &&
                y >= item.y &&
                y <= item.y + item.height &&
                (horizontal
                  ? x > item.x + item.width * 0.3 && x < item.x + item.width * 0.7
                  : y > item.y + item.height * 0.3 && y < item.y + item.height * 0.7),
            )
          : null;
      const nearest = group.items.reduce(
        (best, item, index) => {
          const distance = Math.hypot(x - item.x - item.width / 2, y - item.y - item.height / 2);
          return distance < best.distance ? { index, distance } : best;
        },
        { index: 0, distance: Infinity },
      ).index;
      const order = group.items.filter((item) => item.id !== g.id).map((item) => item.id);
      order.splice(nearest, 0, g.id);
      next = {
        group,
        order: folder ? group.items.map((item) => item.id) : order,
        folder: folder?.id || null,
      };
    }
    const previous = draft.current;
    if (
      previous?.group !== next?.group ||
      previous?.folder !== next?.folder ||
      previous?.order.join() !== next?.order.join()
    ) {
      draft.current = next;
      setPreview(next);
    }
    frame.current = requestAnimationFrame(update);
  };
  const finish = (cancel = false) => {
    const g = gesture.current;
    if (!g || g.released) return;
    if (!g.active) {
      clear();
      return;
    }
    g.released = true;
    cancelAnimationFrame(frame.current);
    suppressClick.current = true;
    const next = cancel ? null : draft.current;
    const changed =
      next &&
      (next.folder ||
        next.group !== g.origin ||
        next.order.some((id, index) => id !== g.origin.items[index]?.id));
    const destination = changed
      ? next!
      : { group: g.origin, order: g.origin.items.map((i) => i.id), folder: null };
    if (!changed) {
      draft.current = null;
      setPreview(null);
    }
    const slot = destination.folder
      ? destination.group.items.find((i) => i.id === destination.folder)
      : destination.group.items[
          Math.min(destination.order.indexOf(g.id), destination.group.items.length - 1)
        ];
    const bounds = destination.group.container.getBoundingClientRect();
    const left = slot
      ? bounds.left + slot.x - destination.group.container.scrollLeft + (slot.width - g.width) / 2
      : g.x - g.offsetX;
    const top = slot
      ? bounds.top +
        slot.y -
        destination.group.container.scrollTop +
        (destination.group.id === 'root' ? (slot.height - g.height) / 2 : 7)
      : g.y - g.offsetY;
    const save = () => {
      if (gesture.current !== g) return;
      if (!changed || !next) {
        clear();
        return;
      }
      const index = next.order.indexOf(g.id);
      const before = next.group.items.find((item) => item.id === next.order[index - 1])?.position;
      const after = next.group.items.find((item) => item.id === next.order[index + 1])?.position;
      const position =
        before === undefined
          ? (after ?? 1) - 1
          : after === undefined
            ? before + 1
            : before + (after - before) / 2;
      committing.current = true;
      beforeCommit.current = library;
      void commit({
        id: g.id,
        kind: g.kind,
        group: next.group.id,
        position,
        ...(next.folder ? { folder: next.folder } : {}),
      }).finally(() => {
        committing.current = false;
        clear();
      });
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) save();
    else {
      settling.current = g.avatar.animate(
        [
          { left: g.avatar.style.left, top: g.avatar.style.top },
          { left: `${left}px`, top: `${top}px` },
        ],
        { duration: 180, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
      );
      void settling.current.finished.then(save, () => {});
    }
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.released || e.pointerId !== g.pointer) return;
      // The release was missed, e.g. outside the window before capture.
      if (!(e.buttons & 1)) {
        finish(true);
        return;
      }
      g.x = e.clientX;
      g.y = e.clientY;
      if (!g.active && Math.hypot(g.x - g.startX, g.y - g.startY) < 5) return;
      e.preventDefault();
      e.stopPropagation();
      if (!g.active) {
        g.active = true;
        g.element.setPointerCapture(g.pointer);
        // Lift the existing avatar into Chromium's top layer: no clone or drag
        // image, and no clipping at the scroll-panel edge. Retain its DOM parent.
        g.avatar.dataset.reorderAvatar = '';
        g.avatar.setAttribute('popover', 'manual');
        Object.assign(g.avatar.style, {
          width: `${g.width}px`,
          height: `${g.height}px`,
          left: `${g.x - g.offsetX}px`,
          top: `${g.y - g.offsetY}px`,
        });
        g.avatar.showPopover();
        document.body.classList.add('reordering');
        setSource(g.id);
      }
      cancelAnimationFrame(frame.current);
      update();
    };
    const up = (e: PointerEvent) => {
      if (gesture.current?.pointer === e.pointerId) finish();
    };
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancel();
      }
    };
    const click = (e: MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    // A drag that ended without a click must not swallow the next real one.
    const press = () => {
      suppressClick.current = false;
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('click', click, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    };
  });
  useEffect(() => () => clear(), []);
  const start = (event: ReactPointerEvent<HTMLElement>, id: string, kind: string) => {
    if (event.button !== 0 || !event.isPrimary || committing.current) return;
    if (gesture.current) {
      if (gesture.current.active) return;
      clear();
    }
    const container = event.currentTarget.closest<HTMLElement>('[data-reorder-group]');
    const avatar = event.currentTarget.querySelector<HTMLElement>('.app-icon');
    if (!container || !avatar) return;
    const groups = [...document.querySelectorAll<HTMLElement>('[data-reorder-group]')].map(
      snapshot,
    );
    const origin = groups.find((group) => group.container === container)!;
    const r = avatar.getBoundingClientRect();
    gesture.current = {
      id,
      kind,
      origin,
      groups,
      element: event.currentTarget,
      avatar,
      avatarStyle: avatar.getAttribute('style'),
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - r.left,
      offsetY: event.clientY - r.top,
      width: avatar.offsetWidth,
      height: avatar.offsetHeight,
      active: false,
      released: false,
    };
  };
  const style = (id: string): CSSProperties | undefined => {
    const g = gesture.current;
    if (!g) return undefined;
    // A folder-grid cell must retain its height while its avatar is lifted.
    if (id === source) return { minHeight: g.origin.items.find((item) => item.id === id)?.height };
    if (!preview || preview.group !== g.origin) return undefined;
    const from = g.origin.items.find((item) => item.id === id),
      to = g.origin.items[preview.order.indexOf(id)];
    if (!from || !to) return undefined;
    return { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px)` };
  };
  return { start, style, source, folder: preview?.folder };
}
