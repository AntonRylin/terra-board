export const toolbarIds = [
  'select',
  'hand',
  'text',
  'note',
  'rect',
  'arrow',
  'frame',
  'link',
  'list',
  'media',
  'gallery',
] as const;
export type ToolbarId = (typeof toolbarIds)[number];
export type ToolbarLayout = { bar: ToolbarId[]; inventory: ToolbarId[] };
export type ToolbarZone = keyof ToolbarLayout;
export const toolbarStorageKey = 'terra-board.toolbar-layout';

export const defaultToolbarLayout = (): ToolbarLayout => ({
  bar: ['select', 'hand', 'text', 'note', 'rect', 'arrow', 'frame', 'link', 'media'],
  inventory: ['gallery', 'list'],
});

// Repair old or malformed preferences without losing access to any tool.
export function readToolbarLayout(value: unknown): ToolbarLayout {
  if (!value || typeof value !== 'object') return defaultToolbarLayout();
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.bar) || !Array.isArray(raw.inventory)) return defaultToolbarLayout();
  const seen = new Set<string>();
  const clean = (ids: unknown[]) =>
    ids.filter((id): id is ToolbarId => {
      if (typeof id !== 'string' || !toolbarIds.includes(id as ToolbarId) || seen.has(id))
        return false;
      seen.add(id);
      return true;
    });
  const bar = clean(raw.bar);
  const inventory = clean(raw.inventory);
  inventory.push(...toolbarIds.filter((id) => !seen.has(id)));
  return { bar, inventory };
}

export function moveToolbarTool(
  layout: ToolbarLayout,
  id: ToolbarId,
  zone: ToolbarZone,
  index: number,
): ToolbarLayout {
  const next: ToolbarLayout = {
    bar: layout.bar.filter((tool) => tool !== id),
    inventory: layout.inventory.filter((tool) => tool !== id),
  };
  next[zone].splice(Math.max(0, Math.min(index, next[zone].length)), 0, id);
  return next;
}
