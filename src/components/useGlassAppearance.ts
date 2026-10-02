import { useLayoutEffect, useState } from 'react';

const storageKey = 'terra-board.panel-transparency';
export const defaultPanelTransparency = 55;

function readTransparency() {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null && stored.trim() !== '') {
      const value = Number(stored);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, value));
    }
  } catch {}
  return defaultPanelTransparency;
}

export function useGlassAppearance() {
  const [transparency, setTransparency] = useState(readTransparency);
  useLayoutEffect(() => {
    const amount = transparency / 100;
    const style = document.documentElement.style;
    style.setProperty('--glass-fill', String(1 - amount));
    style.setProperty('--glass-shine', String(0.32 * amount));
    style.setProperty('--glass-control', String(0.12 + 0.43 * amount));
    try {
      localStorage.setItem(storageKey, String(transparency));
    } catch {}
  }, [transparency]);
  return { transparency, setTransparency };
}
