import type { CanvasObject } from './model';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export const themeKey = 'terra-board.theme';
export const nightGlowKey = 'terra-board.night-glow';
export const appearanceEvent = 'terra:appearance';

export function readThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
export function storedAppearance() {
  try {
    return {
      preference: readThemePreference(localStorage.getItem(themeKey)),
      nightGlow: localStorage.getItem(nightGlowKey) !== 'false',
    };
  } catch {
    return { preference: 'system' as const, nightGlow: true };
  }
}
export function applyAppearance(theme: ResolvedTheme, nightGlow: boolean) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.nightGlow = String(nightGlow);
  root.style.colorScheme = theme;
  window.dispatchEvent(new Event(appearanceEvent));
}
export function initializeAppearance() {
  const saved = storedAppearance();
  applyAppearance(
    resolveTheme(saved.preference, matchMedia('(prefers-color-scheme: dark)').matches),
    saved.nightGlow,
  );
}

// Display adaptation only. Original object colors remain intact for editing/export.
export function nightInk(o: Pick<CanvasObject, 'type' | 'color'>, original: string): string {
  if (o.type !== 'text' && o.type !== 'arrow') return '#e4eaf2';
  const hex = original.replace('#', '');
  if (!/^[\da-f]{6}$/i.test(hex)) return '#e4eaf2';
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  if (luminance >= 145) return original;
  if (Math.max(...rgb) - Math.min(...rgb) < 35) return '#e4eaf2';
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(c + (255 - c) * 0.55)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
