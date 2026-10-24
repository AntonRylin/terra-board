export const toolbarIds = [
  'select',
  'hand',
  'text',
  'note',
  'rect',
  'arrow',
  'pen',
  'highlight',
  'frame',
  'link',
  'list',
  'table',
  'paper',
  'html',
  'browser',
  'folder',
  'desktops',
  'telegram',
  'media',
  'gallery',
] as const;
export type ToolbarId = (typeof toolbarIds)[number];
export type ToolLayout<Id extends string> = { bar: Id[]; inventory: Id[] };
export type ToolbarLayout = ToolLayout<ToolbarId>;
export type ToolbarZone = keyof ToolbarLayout;
export const toolbarStorageKey = 'terra-board.toolbar-layout';

export const defaultToolbarLayout = (): ToolbarLayout => ({
  bar: [
    'select',
    'hand',
    'text',
    'note',
    'rect',
    'arrow',
    'pen',
    'highlight',
    'frame',
    'link',
    'media',
  ],
  inventory: [
    'gallery',
    'list',
    'table',
    'paper',
    'html',
    'browser',
    'folder',
    'desktops',
    'telegram',
  ],
});

// The Android app's first layout: five tools, which leave room for + and … in one row on
// a phone; the rest wait under +. A finger on empty board already pans, so the hand tool
// is among the rest.
export const phoneToolbarLayout = (): ToolbarLayout => {
  const bar: ToolbarId[] = ['select', 'pen', 'note', 'text', 'media'];
  return { bar, inventory: toolbarIds.filter((id) => !bar.includes(id)) };
};

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
  // Layouts saved before the pen existed get it beside the highlighter.
  const marker = bar.indexOf('highlight');
  if (!seen.has('pen') && marker >= 0) {
    bar.splice(marker, 0, 'pen');
    seen.add('pen');
  }
  inventory.push(...toolbarIds.filter((id) => !seen.has(id)));
  return { bar, inventory };
}

export function moveToolbarTool<Id extends string>(
  layout: ToolLayout<Id>,
  id: Id,
  zone: ToolbarZone,
  index: number,
): ToolLayout<Id> {
  const next: ToolLayout<Id> = {
    bar: layout.bar.filter((tool) => tool !== id),
    inventory: layout.inventory.filter((tool) => tool !== id),
  };
  next[zone].splice(Math.max(0, Math.min(index, next[zone].length)), 0, id);
  return next;
}

// Contextual ribbons show only a subset of the saved layout. Inserting beside a
// visible neighbor must not discard the preferences for other object types.
export function moveVisibleToolbarTool<Id extends string>(
  layout: ToolLayout<Id>,
  id: Id,
  zone: ToolbarZone,
  index: number,
  available: readonly Id[],
): ToolLayout<Id> {
  const remaining = layout[zone].filter((tool) => tool !== id);
  const visible = remaining.filter((tool) => available.includes(tool));
  const target = visible[Math.max(0, index)];
  const globalIndex =
    target !== undefined
      ? remaining.indexOf(target)
      : visible.length
        ? remaining.indexOf(visible[visible.length - 1]) + 1
        : remaining.length;
  return moveToolbarTool(layout, id, zone, globalIndex);
}
