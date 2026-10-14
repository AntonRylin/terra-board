// A shortcut is a physical key position plus modifiers. Using KeyboardEvent.code
// keeps shortcuts working on every keyboard layout (the V key on a Russian layout
// types "м" but still reports KeyV).
export type Binding = { code: string; ctrl?: boolean; shift?: boolean; alt?: boolean };
export type ShortcutScope = 'board' | 'app';

type KeyInput = {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

const modifierCodes = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'CapsLock',
  'NumLock',
  'Fn',
]);

export function bindingFromEvent(e: KeyInput): Binding | null {
  if (!e.code || modifierCodes.has(e.code)) return null;
  return normalize({
    code: e.code,
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  });
}

function normalize(b: Binding): Binding {
  const out: Binding = { code: b.code };
  if (b.ctrl) out.ctrl = true;
  if (b.shift) out.shift = true;
  if (b.alt) out.alt = true;
  return out;
}

export const sameBinding = (a: Binding, b: Binding) =>
  a.code === b.code && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt;

export const matchesEvent = (b: Binding, e: KeyInput) =>
  b.code === e.code &&
  !!b.ctrl === (e.ctrlKey || e.metaKey) &&
  !!b.shift === e.shiftKey &&
  !!b.alt === e.altKey;

const labels: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  NumpadEnter: 'Num Enter',
  ContextMenu: 'Menu',
  IntlBackslash: '\\',
};

export function keyLabel(code: string) {
  if (labels[code]) return labels[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return 'Num ' + numpad[1];
  const arrow = /^Arrow(\w+)$/.exec(code);
  if (arrow) return arrow[1];
  return code;
}

export const bindingKeys = (b: Binding) => [
  ...(b.ctrl ? ['Ctrl'] : []),
  ...(b.alt ? ['Alt'] : []),
  ...(b.shift ? ['Shift'] : []),
  keyLabel(b.code),
];

export const formatBinding = (b: Binding) => bindingKeys(b).join('+');

const navigation = new Set([
  'Escape',
  'Enter',
  'NumpadEnter',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const functionKey = (code: string) => /^F([1-9]|1\d|2[0-4])$/.test(code);

// Returns why a combination cannot be used, or null when it is allowed.
export function reservedReason(b: Binding, scope: ShortcutScope): string | null {
  if (navigation.has(b.code)) return 'Escape, Enter and arrow keys are kept for moving around.';
  if (b.code === 'Space' && !b.ctrl && !b.alt) return 'Space is kept for panning with drag.';
  if (b.code === 'Tab' && (b.ctrl || b.alt || b.shift)) return 'Tab with modifiers moves focus.';
  if (b.ctrl && !b.alt && !b.shift && ['KeyC', 'KeyX', 'KeyV'].includes(b.code))
    return 'Copy, cut and paste always use Ctrl+C, Ctrl+X and Ctrl+V.';
  if (b.alt && b.code === 'F4') return 'Alt+F4 closes the window.';
  if (scope === 'app' && !b.ctrl && !b.alt && !functionKey(b.code))
    return 'This shortcut works everywhere, even while typing, so it needs Ctrl, Alt or an F key.';
  return null;
}

export function cleanBinding(value: unknown): Binding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== 'string' || !raw.code || raw.code.length > 40) return null;
  if (modifierCodes.has(raw.code)) return null;
  return normalize({
    code: raw.code,
    ctrl: raw.ctrl === true,
    shift: raw.shift === true,
    alt: raw.alt === true,
  });
}
