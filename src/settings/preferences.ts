import { useSyncExternalStore } from 'react';
import { cleanOverrides, type ShortcutOverrides } from '../shortcuts/commands.ts';
import {
  defaultRadialLayout,
  radialStorageKey,
  readRadialLayout,
} from '../components/radial-layout.ts';
import type { ToolbarId } from '../components/toolbar-layout.ts';

export type WheelMode = 'zoom' | 'pan';
export type ZoomSpeed = 'slow' | 'normal' | 'fast';
export type Preferences = {
  openLastBoard: boolean;
  confirmTrash: boolean;
  wheel: WheelMode;
  zoomSpeed: ZoomSpeed;
  snapping: boolean;
  radial: ToolbarId[];
  shortcuts: ShortcutOverrides;
};

export const preferencesKey = 'terra-board.preferences';

export const defaultPreferences = (): Preferences => ({
  openLastBoard: true,
  confirmTrash: false,
  wheel: 'zoom',
  zoomSpeed: 'normal',
  snapping: true,
  radial: defaultRadialLayout(),
  shortcuts: {},
});

function pick<T>(value: unknown, allowed: readonly T[], fallback: T) {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Each field recovers on its own, so one bad value never resets everything.
export function readPreferences(value: unknown, legacyRadial?: unknown): Preferences {
  const d = defaultPreferences();
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    openLastBoard: pick(raw.openLastBoard, [true, false], d.openLastBoard),
    confirmTrash: pick(raw.confirmTrash, [true, false], d.confirmTrash),
    wheel: pick(raw.wheel, ['zoom', 'pan'] as const, d.wheel),
    zoomSpeed: pick(raw.zoomSpeed, ['slow', 'normal', 'fast'] as const, d.zoomSpeed),
    snapping: pick(raw.snapping, [true, false], d.snapping),
    radial: readRadialLayout(raw.radial !== undefined ? raw.radial : legacyRadial),
    shortcuts: cleanOverrides(raw.shortcuts),
  };
}

function load(): Preferences {
  try {
    const legacy = localStorage.getItem(radialStorageKey);
    return readPreferences(
      JSON.parse(localStorage.getItem(preferencesKey) || 'null'),
      legacy ? JSON.parse(legacy) : undefined,
    );
  } catch {
    return defaultPreferences();
  }
}

let current: Preferences | null = null;
const listeners = new Set<() => void>();

export const getPreferences = () => (current ??= load());

export function updatePreferences(
  change: Partial<Preferences> | ((p: Preferences) => Partial<Preferences>),
) {
  const before = getPreferences();
  current = { ...before, ...(typeof change === 'function' ? change(before) : change) };
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(current));
  } catch {}
  listeners.forEach((listener) => listener());
}

export function subscribePreferences(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const usePreferences = () =>
  useSyncExternalStore(subscribePreferences, getPreferences, getPreferences);
