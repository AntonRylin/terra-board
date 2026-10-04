import { useLayoutEffect, useRef } from 'react';
import type { DockEdge } from './useLauncherDock';

export function useFullscreenSpace(enabled: boolean, centered: boolean, edge: DockEdge) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = button.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    const panel = shell?.querySelector<HTMLElement>('.launcher');
    if (!element || !shell || !panel) return;
    if (!enabled) {
      delete element.dataset.fitsBesidePanel;
      return;
    }
    const measure = () => {
      if (panel.classList.contains('is-dragging')) return;
      // Test the preferred corner, never the button's displaced position.
      const right = shell.clientWidth - 16;
      const left = right - element.offsetWidth;
      const top = 13;
      const bottom = top + element.offsetHeight;
      const gap = 12;
      const fits =
        right + gap <= panel.offsetLeft ||
        left >= panel.offsetLeft + panel.offsetWidth + gap ||
        bottom + gap <= panel.offsetTop ||
        top >= panel.offsetTop + panel.offsetHeight + gap;
      element.dataset.fitsBesidePanel = String(fits);
    };
    const resize = new ResizeObserver(measure);
    [shell, panel, element].forEach((node) => resize.observe(node));
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
  }, [enabled, centered, edge]);
  return button;
}
