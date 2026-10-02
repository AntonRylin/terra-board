import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DockEdge } from './useLauncherDock';

/** One top-layer label, shared by the dock and boards inside folders. */
export default function LauncherTooltip({ edge }: { edge: DockEdge }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => clearTimeout(timer);
    const dismiss = () => {
      clear();
      setAnchor(null);
    };
    const target = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>('[data-launcher-label]') : null;
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons) return;
      if (tip.current?.contains(event.target as Node)) {
        clear();
        return;
      }
      const next = target(event.target);
      if (!next || next === target(event.relatedTarget)) return;
      clear();
      setAnchor(next);
    };
    const out = (event: PointerEvent) => {
      const previous = target(event.target);
      if (previous && previous === target(event.relatedTarget)) return;
      if (!previous && !tip.current?.contains(event.target as Node)) return;
      clear();
      // Allow the pointer to cross the small gap and rest on a long label.
      timer = setTimeout(() => setAnchor(null), 120);
    };
    const focus = (event: FocusEvent) => {
      const next = target(event.target);
      if (next?.matches(':focus-visible')) {
        clear();
        setAnchor(next);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', dismiss);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      clear();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', dismiss);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const label = tip.current;
    if (!label) return;
    if (!anchor?.isConnected) {
      if (label.matches(':popover-open')) label.hidePopover();
      return;
    }
    if (!label.matches(':popover-open')) label.showPopover();
    const r = anchor.getBoundingClientRect();
    const { width, height } = label.getBoundingClientRect();
    const side = anchor.closest('.folder-sheet') ? 'bottom' : edge;
    let x = r.left + (r.width - width) / 2;
    let y = r.top + (r.height - height) / 2;
    if (side === 'left') x = r.right + 10;
    if (side === 'right') x = r.left - width - 10;
    if (side === 'top') y = r.bottom + 10;
    if (side === 'bottom') y = r.top - height - 10;
    label.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    label.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
  }, [anchor, edge]);

  // Retain the element between hovers; names are already available on the tiles.
  return (
    <div ref={tip} className="launcher-tooltip" role="tooltip" popover="manual">
      {anchor?.dataset.launcherLabel}
    </div>
  );
}
