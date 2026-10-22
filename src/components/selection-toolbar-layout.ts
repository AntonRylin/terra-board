export const selectionToolbarStorageKey = 'terra-board.selection-toolbar-hidden';
export const selectionToolbarLayoutKey = 'terra-board.selection-toolbar-layout';
export const selectionToolLabels = {
  lock: 'Lock selection',
  spoiler: 'Spoiler',
  pin: 'Pin to screen',
  colors: 'Colors',
  'arrow-style': 'Arrow style',
  open: 'Open',
  'html-interact': 'Interact',
  'html-code': 'Edit code',
  'html-hover': 'Run on hover',
  'copy-frame-link': 'Copy frame link',
  'open-frame': 'Open original frame',
  youtube: 'Open on YouTube',
  group: 'Group selection',
  bold: 'Bold',
  strikethrough: 'Strikethrough',
  'center-x': 'Center horizontally',
  'center-y': 'Center vertically',
  title: 'Title',
  'edit-image': 'Edit image',
  'album-settings': 'Album settings',
  export: 'Export',
  'preview-document': 'Preview document',
  'preview-pdf': 'Full PDF preview',
  'edit-pdf': 'Edit PDF',
  'pages-to-images': 'Pages to images',
  'merge-pdf': 'Merge as PDF',
  download: 'Download document',
  front: 'Bring to front',
  duplicate: 'Duplicate selection',
  delete: 'Delete selection',
  right: 'Right',
  below: 'Below',
} as const;
export type SelectionToolId = keyof typeof selectionToolLabels;
export type SelectionToolbarLayout = { bar: SelectionToolId[]; inventory: SelectionToolId[] };

export function readSelectionToolbarLayout(
  value: unknown,
  legacyHidden?: unknown,
): SelectionToolbarLayout {
  const ids = Object.keys(selectionToolLabels) as SelectionToolId[];
  const hidden = readHiddenSelectionTools(legacyHidden);
  const defaults = { bar: ids.filter((id) => !hidden.includes(id)), inventory: hidden };
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.bar) || !Array.isArray(raw.inventory)) return defaults;
  const bar = readHiddenSelectionTools(raw.bar);
  const inventory = readHiddenSelectionTools(raw.inventory).filter((id) => !bar.includes(id));
  bar.push(...ids.filter((id) => !bar.includes(id) && !inventory.includes(id)));
  return { bar, inventory };
}

export function readHiddenSelectionTools(value: unknown): SelectionToolId[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is SelectionToolId =>
              typeof id === 'string' && Object.hasOwn(selectionToolLabels, id),
          ),
        ),
      ]
    : [];
}

export function toggleSelectionTool(hidden: SelectionToolId[], id: SelectionToolId) {
  return hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id];
}
