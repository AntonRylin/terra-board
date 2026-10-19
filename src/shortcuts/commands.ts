import {
  cleanBinding,
  matchesEvent,
  sameBinding,
  type Binding,
  type ShortcutScope,
} from './keys.ts';

export type CommandGroup = 'Tools' | 'Edit' | 'View' | 'App';
export type Command = {
  id: string;
  name: string;
  group: CommandGroup;
  // Board commands never fire while typing; app commands work everywhere.
  scope: ShortcutScope;
  defaults: Binding[];
};

const key = (code: string, mods: Omit<Binding, 'code'> = {}): Binding => ({ code, ...mods });
const ctrl = (code: string, mods: Omit<Binding, 'code' | 'ctrl'> = {}) =>
  key(code, { ctrl: true, ...mods });

export const commands = [
  { id: 'tool.select', name: 'Select', group: 'Tools', scope: 'board', defaults: [key('KeyV')] },
  { id: 'tool.hand', name: 'Pan', group: 'Tools', scope: 'board', defaults: [key('KeyH')] },
  { id: 'tool.text', name: 'Text', group: 'Tools', scope: 'board', defaults: [key('KeyT')] },
  { id: 'tool.note', name: 'Note', group: 'Tools', scope: 'board', defaults: [key('KeyN')] },
  { id: 'tool.rect', name: 'Shape', group: 'Tools', scope: 'board', defaults: [key('KeyR')] },
  { id: 'tool.arrow', name: 'Arrow', group: 'Tools', scope: 'board', defaults: [key('KeyA')] },
  {
    id: 'tool.highlight',
    name: 'Highlighter',
    group: 'Tools',
    scope: 'board',
    defaults: [key('KeyM')],
  },
  { id: 'tool.frame', name: 'Frame', group: 'Tools', scope: 'board', defaults: [key('KeyF')] },
  { id: 'tool.link', name: 'Link', group: 'Tools', scope: 'board', defaults: [key('KeyL')] },
  {
    id: 'view.radial',
    name: 'Quick tools wheel',
    group: 'Tools',
    scope: 'board',
    defaults: [key('Tab')],
  },
  { id: 'edit.undo', name: 'Undo', group: 'Edit', scope: 'board', defaults: [ctrl('KeyZ')] },
  {
    id: 'edit.redo',
    name: 'Redo',
    group: 'Edit',
    scope: 'board',
    defaults: [ctrl('KeyZ', { shift: true }), ctrl('KeyY')],
  },
  {
    id: 'edit.selectAll',
    name: 'Select everything',
    group: 'Edit',
    scope: 'board',
    defaults: [ctrl('KeyA')],
  },
  {
    id: 'edit.duplicate',
    name: 'Duplicate',
    group: 'Edit',
    scope: 'board',
    defaults: [ctrl('KeyD')],
  },
  { id: 'edit.group', name: 'Group', group: 'Edit', scope: 'board', defaults: [ctrl('KeyG')] },
  {
    id: 'edit.ungroup',
    name: 'Ungroup',
    group: 'Edit',
    scope: 'board',
    defaults: [ctrl('KeyG', { shift: true })],
  },
  {
    id: 'edit.delete',
    name: 'Delete selection',
    group: 'Edit',
    scope: 'board',
    defaults: [key('Delete'), key('Backspace')],
  },
  { id: 'edit.bold', name: 'Bold text', group: 'Edit', scope: 'board', defaults: [ctrl('KeyB')] },
  { id: 'edit.save', name: 'Save now', group: 'Edit', scope: 'board', defaults: [ctrl('KeyS')] },
  {
    id: 'view.fit',
    name: 'Fit board to view',
    group: 'View',
    scope: 'board',
    defaults: [key('Digit0'), key('Numpad0')],
  },
  {
    id: 'app.fullscreen',
    name: 'Full screen',
    group: 'View',
    scope: 'app',
    defaults: [key('F11')],
  },
  {
    id: 'app.search',
    name: 'Search boards and content',
    group: 'App',
    scope: 'app',
    defaults: [ctrl('KeyF'), ctrl('KeyK')],
  },
  {
    id: 'app.settings',
    name: 'Open settings',
    group: 'App',
    scope: 'app',
    defaults: [ctrl('Comma')],
  },
] as const satisfies readonly Command[];

export type CommandId = (typeof commands)[number]['id'];
export type ShortcutOverrides = Partial<Record<CommandId, Binding[]>>;
export const maxBindings = 2;

const byId = new Map<string, Command>(commands.map((c) => [c.id, c]));
export const commandById = (id: string) => byId.get(id);

// Keys that cannot be changed yet, listed so the shortcut page is complete.
export const fixedShortcuts: { name: string; keys: string; group: string }[] = [
  { name: 'Copy, cut and paste', keys: 'Ctrl C · Ctrl X · Ctrl V', group: 'Edit' },
  { name: 'Clear selection', keys: 'Esc', group: 'Edit' },
  { name: 'Finish text editing', keys: 'Ctrl Enter', group: 'Edit' },
  { name: 'Pan around', keys: 'Space + drag · Right-drag', group: 'View' },
  { name: 'Move without snapping', keys: 'Alt + drag', group: 'View' },
  { name: 'Arrow: horizontal / vertical', keys: 'Shift / Ctrl while drawing', group: 'View' },
  { name: 'Exit full screen', keys: 'Esc', group: 'View' },
  { name: 'Image viewer: zoom, fit, actual size', keys: '+ · - · 0 · 1', group: 'Viewers' },
  { name: 'Image viewer: download', keys: 'Ctrl S', group: 'Viewers' },
  { name: 'PDF: previous / next page', keys: 'Arrows · Page Up / Down', group: 'Viewers' },
  { name: 'PDF: save and close', keys: 'Ctrl S', group: 'Viewers' },
];

export const bindingsFor = (id: CommandId, overrides: ShortcutOverrides): Binding[] =>
  overrides[id] ?? [...(byId.get(id)?.defaults ?? [])];

export function commandForEvent(
  e: Parameters<typeof matchesEvent>[1],
  scope: ShortcutScope,
  overrides: ShortcutOverrides,
): CommandId | null {
  for (const c of commands)
    if (c.scope === scope && bindingsFor(c.id, overrides).some((b) => matchesEvent(b, e)))
      return c.id;
  return null;
}

export function conflictFor(
  binding: Binding,
  overrides: ShortcutOverrides,
  exceptId: CommandId,
): Command | null {
  for (const c of commands)
    if (c.id !== exceptId && bindingsFor(c.id, overrides).some((b) => sameBinding(b, binding)))
      return c;
  return null;
}

export function cleanOverrides(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ShortcutOverrides = {};
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!byId.has(id) || !Array.isArray(list)) continue;
    const clean = list
      .map(cleanBinding)
      .filter((b): b is Binding => !!b)
      .slice(0, maxBindings);
    out[id as CommandId] = clean;
  }
  return out;
}
