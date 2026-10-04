import { useEffect, useLayoutEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  applyAppearance,
  nightGlowKey,
  resolveTheme,
  storedAppearance,
  themeKey,
  type ThemePreference,
} from '../appearance';

let transition: ViewTransition | undefined;
function animate(change: () => void) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return;
  }
  transition?.skipTransition();
  transition = document.startViewTransition(() => flushSync(change));
  void transition.finished.catch(() => {});
}

export function useAppearance() {
  const [saved, setSaved] = useState(storedAppearance);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const theme = resolveTheme(saved.preference, systemDark);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => animate(() => setSystemDark(media.matches));
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    applyAppearance(theme, saved.nightGlow);
    try {
      localStorage.setItem(themeKey, saved.preference);
      localStorage.setItem(nightGlowKey, String(saved.nightGlow));
    } catch {}
  }, [theme, saved]);
  return {
    ...saved,
    theme,
    setPreference: (preference: ThemePreference) =>
      animate(() => setSaved((s) => ({ ...s, preference }))),
    setNightGlow: (nightGlow: boolean) => setSaved((s) => ({ ...s, nightGlow })),
  };
}
export type Appearance = ReturnType<typeof useAppearance>;
