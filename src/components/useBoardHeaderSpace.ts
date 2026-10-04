import { useLayoutEffect, useRef } from 'react';

// Keep the title in its usual corner whenever the compact dock leaves room.
export function useBoardHeaderSpace(enabled: boolean, centered: boolean, boardId?: string) {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    const panel = shell?.querySelector<HTMLElement>('.launcher');
    if (!element || !shell || !panel) return;
    if (!enabled) {
      delete element.dataset.fitsBesidePanel;
      return;
    }
    const measure = () => {
      if (panel.classList.contains('is-dragging')) return;
      // Child offsets measure the title at its preferred origin, ignoring the
      // header's animated left/top offset, so shifting it cannot change the test.
      const contents = [...element.children] as HTMLElement[];
      const left = Math.min(...contents.map((child) => child.offsetLeft));
      const right = Math.max(...contents.map((child) => child.offsetLeft + child.offsetWidth));
      const top = Math.min(...contents.map((child) => child.offsetTop));
      const bottom = Math.max(...contents.map((child) => child.offsetTop + child.offsetHeight));
      const panelLeft = panel.offsetLeft;
      const panelRight = panelLeft + panel.offsetWidth;
      const panelTop = panel.offsetTop;
      const panelBottom = panelTop + panel.offsetHeight;
      const gap = 12;
      const fits =
        contents.length === 0 ||
        right + gap <= panelLeft ||
        left >= panelRight + gap ||
        bottom + gap <= panelTop ||
        top >= panelBottom + gap;
      element.dataset.fitsBesidePanel = String(fits);
    };
    const resize = new ResizeObserver(measure);
    [shell, panel, element, ...element.children].forEach((node) => resize.observe(node));
    // Alignment and drag completion can change position without changing size.
    const changes = new MutationObserver(measure);
    changes.observe(panel, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-centered'],
    });
    measure();
    return () => {
      resize.disconnect();
      changes.disconnect();
      delete element.dataset.fitsBesidePanel;
    };
  }, [enabled, centered, boardId]);
  return header;
}
