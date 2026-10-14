import { toolbarIds, type ToolbarId } from './toolbar-layout.ts';

export const radialStorageKey = 'terra-board.radial-layout';
// The downward sector stays clear so the customization button is always reachable.
export const radialSectors = [0, 1, 2, 3, 5, 6, 7];
export const defaultRadialLayout = (): ToolbarId[] => [
  'text',
  'note',
  'rect',
  'frame',
  'highlight',
  'arrow',
  'select',
];

export function readRadialLayout(value: unknown): ToolbarId[] {
  const defaults = defaultRadialLayout();
  if (!Array.isArray(value) || value.length !== defaults.length) return defaults;
  return defaults.map((fallback, index) =>
    toolbarIds.includes(value[index]) ? value[index] : fallback,
  );
}

export function radialSlot(dx: number, dy: number): number | null {
  if (Math.hypot(dx, dy) < 72) return null;
  const sector = (Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI / 4)) + 8) % 8;
  const slot = radialSectors.indexOf(sector);
  return slot < 0 ? null : slot;
}
