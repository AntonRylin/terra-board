import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import {
  applyStyle,
  commonStyle,
  fontFamilies,
  rebaseMarks,
  spoilerRegions,
  styleRuns,
  textSizes,
  type StylePatch,
  type TextFlag,
  type TextMark,
  type TextStyle,
} from '../canvas/rich-text';
import './rich-text.css';

// A contenteditable over plain text + style ranges. The browser edits the DOM;
// every change is read back as plain text, ranges are re-anchored, and the DOM is
// repainted from the model with the caret restored, so the model stays the truth.

export interface FieldRange {
  start: number;
  end: number;
}
interface Caret {
  anchor: number;
  focus: number;
}
export interface RichFieldApi {
  range(): FieldRange | null;
  style(range?: FieldRange): TextStyle;
  apply(patch: StylePatch, range?: FieldRange): void;
  toggle(flag: TextFlag): void;
  resize(step: 1 | -1): void;
}
const fields = new WeakMap<Element, RichFieldApi>();
export const richField = (element: Element | null | undefined) =>
  (element && fields.get(element)) || null;

function readText(root: Node): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) out += (node as Text).data;
    else if (node.nodeName === 'BR') {
      if (!(node as HTMLElement).hasAttribute('data-rt-tail')) out += '\n';
    } else {
      // Browsers occasionally wrap lines in blocks; treat a block as a line.
      if (node !== root && /^(DIV|P)$/.test(node.nodeName) && out && !out.endsWith('\n'))
        out += '\n';
      node.childNodes.forEach(walk);
    }
  };
  walk(root);
  return out;
}
function offsetOf(root: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return readText(range.cloneContents()).length;
}
function pointAt(root: HTMLElement, offset: number): [Node, number] {
  let left = offset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (left < data.length || (left === data.length && !data.endsWith('\n'))) return [node, left];
      if (left === data.length) {
        // After a trailing newline the caret belongs on the next line.
        const parent = node.parentNode!;
        return [parent, [...parent.childNodes].indexOf(node as ChildNode) + 1];
      }
      left -= data.length;
    } else if (node.nodeName === 'BR' && !(node as HTMLElement).hasAttribute('data-rt-tail')) {
      const parent = node.parentNode!,
        index = [...parent.childNodes].indexOf(node as ChildNode);
      if (left === 0) return [parent, index];
      left--;
    }
  }
  return [root, root.childNodes.length];
}
function caretOf(root: HTMLElement): Caret | null {
  const selection = document.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return null;
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  return {
    anchor: offsetOf(root, selection.anchorNode, selection.anchorOffset),
    focus: offsetOf(root, selection.focusNode, selection.focusOffset),
  };
}
export function fieldRange(root: HTMLElement): FieldRange | null {
  const caret = caretOf(root);
  return (
    caret && {
      start: Math.min(caret.anchor, caret.focus),
      end: Math.max(caret.anchor, caret.focus),
    }
  );
}
function setCaret(root: HTMLElement, caret: Caret) {
  const [anchorNode, anchorOffset] = pointAt(root, caret.anchor);
  const [focusNode, focusOffset] = pointAt(root, caret.focus);
  document.getSelection()?.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}
export function focusField(root: HTMLElement, at: 'start' | 'end') {
  root.focus({ preventScroll: true });
  const offset = at === 'start' ? 0 : readText(root).length;
  setCaret(root, { anchor: offset, focus: offset });
}

function styledNode(text: string, style: TextStyle): Node {
  const { spoiler: _, ...own } = style;
  if (!Object.keys(own).length) return document.createTextNode(text);
  const span = document.createElement('span');
  span.textContent = text;
  const s = span.style;
  if (style.bold) s.fontWeight = '700';
  if (style.italic) s.fontStyle = 'italic';
  const lines = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean);
  if (lines.length) s.textDecorationLine = lines.join(' ');
  if (style.color) s.color = style.color;
  if (style.highlight) {
    span.classList.add('rt-highlight');
    s.setProperty('--rt-highlight', style.highlight);
  }
  if (style.code) span.classList.add('rt-code');
  if (style.font) s.fontFamily = fontFamilies[style.font];
  if (style.size) s.fontSize = `${style.size}em`;
  return span;
}
function paintDom(
  root: HTMLElement,
  text: string,
  marks: readonly TextMark[] | undefined,
  editable: boolean,
  revealed?: (start: number) => boolean,
) {
  const runs = styleRuns(text.length, marks);
  const regions = spoilerRegions(runs);
  const fragment = document.createDocumentFragment();
  let spoiler: HTMLElement | null = null;
  for (const run of runs) {
    let parent: Node = fragment;
    if (run.style.spoiler) {
      const region = regions.find((r) => r.start <= run.start && run.start < r.end)!;
      if (spoiler?.dataset.start !== String(region.start)) {
        spoiler = document.createElement('span');
        spoiler.className = 'rt-spoiler';
        spoiler.dataset.start = String(region.start);
        if (!editable) {
          spoiler.dataset.hidden = String(!revealed?.(region.start));
          spoiler.setAttribute('role', 'button');
          spoiler.setAttribute('aria-label', 'Spoiler');
        }
        fragment.appendChild(spoiler);
      }
      parent = spoiler;
    } else spoiler = null;
    parent.appendChild(styledNode(text.slice(run.start, run.end), run.style));
  }
  // pre-wrap collapses a final empty line unless something follows the newline.
  if (text.endsWith('\n')) {
    const tail = document.createElement('br');
    tail.setAttribute('data-rt-tail', '');
    fragment.appendChild(tail);
  }
  root.replaceChildren(fragment);
}

interface Snapshot {
  text: string;
  marks?: TextMark[];
  caret: Caret;
}
const shortcutFlags: Record<string, TextFlag> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
  'shift+x': 'strike',
  'shift+m': 'code',
  'shift+p': 'spoiler',
};
const formatInputs: Record<string, TextFlag> = {
  formatBold: 'bold',
  formatItalic: 'italic',
  formatUnderline: 'underline',
  formatStrikeThrough: 'strike',
};

export default function RichTextField({
  value,
  marks,
  onChange,
  editable,
  multiline = true,
  maxLength,
  className,
  label,
  style,
  onKeyDown,
  fieldRef,
  revealed,
  onSpoiler,
}: {
  value: string;
  marks?: TextMark[];
  onChange: (text: string, marks: TextMark[] | undefined) => void;
  editable: boolean;
  multiline?: boolean;
  maxLength: number;
  className?: string;
  label: string;
  style?: CSSProperties;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  fieldRef?: (element: HTMLDivElement | null) => void;
  revealed?: (start: number) => boolean;
  onSpoiler?: (start: number) => void;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const painted = useRef<{ text: string; marks?: TextMark[]; editable: boolean } | null>(null);
  const composing = useRef(false);
  const pending = useRef<StylePatch | null>(null);
  const before = useRef<Caret | null>(null);
  const history = useRef({ undo: [] as Snapshot[], redo: [] as Snapshot[], kind: '', at: 0 });
  const props = useRef({ value, marks, onChange, maxLength, multiline, editable, revealed });
  props.current = { value, marks, onChange, maxLength, multiline, editable, revealed };

  useLayoutEffect(() => {
    const root = element.current!;
    const last = painted.current;
    if (composing.current) return;
    if (last && last.text === value && last.marks === marks && last.editable === editable) {
      // Only local reveal state can differ: flip attributes so the transition runs.
      if (!editable)
        for (const spoiler of root.querySelectorAll<HTMLElement>('.rt-spoiler')) {
          const hidden = String(!revealed?.(Number(spoiler.dataset.start)));
          if (spoiler.dataset.hidden !== hidden) spoiler.dataset.hidden = hidden;
        }
      return;
    }
    const caret = editable && document.activeElement === root ? caretOf(root) : null;
    // A selection left inside a field that stops being editable would keep the
    // format bar open over read-only text.
    if (!editable && last?.editable && caretOf(root)) document.getSelection()?.removeAllRanges();
    paintDom(root, value, marks, editable, revealed);
    painted.current = { text: value, marks, editable };
    if (caret) setCaret(root, caret);
  });

  useEffect(() => {
    const root = element.current!;
    const paint = (text: string, next: TextMark[] | undefined, caret: Caret | null) => {
      paintDom(root, text, next, true);
      painted.current = { text, marks: next, editable: true };
      if (caret && document.activeElement === root) setCaret(root, caret);
    };
    const snapshot = (caret: Caret | null): Snapshot => ({
      text: painted.current?.text ?? props.current.value,
      marks: painted.current?.marks,
      caret: caret || { anchor: 0, focus: 0 },
    });
    const commit = (
      text: string,
      next: TextMark[],
      caret: Caret | null,
      kind: string,
      previous = before.current,
    ) => {
      const h = history.current,
        now = performance.now();
      if (kind !== 'type' || h.kind !== 'type' || now - h.at > 1000) {
        h.undo.push(snapshot(previous));
        if (h.undo.length > 200) h.undo.shift();
      }
      h.redo = [];
      h.kind = kind;
      h.at = now;
      const marks = next.length ? next : undefined;
      paint(text, marks, caret);
      props.current.onChange(text, marks);
    };
    const restore = (from: Snapshot[], to: Snapshot[]) => {
      const target = from.pop();
      if (!target) return;
      to.push(snapshot(caretOf(root)));
      history.current.kind = '';
      paint(target.text, target.marks, target.caret);
      props.current.onChange(target.text, target.marks);
    };
    const insert = (raw: string) => {
      const { value, marks, maxLength, multiline } = props.current;
      let text = raw.replace(/\r\n?/g, '\n');
      if (!multiline) text = text.replace(/\n/g, ' ');
      const range = fieldRange(root) || { start: value.length, end: value.length };
      text = text.slice(0, Math.max(0, maxLength - value.length + range.end - range.start));
      const next = value.slice(0, range.start) + text + value.slice(range.end);
      const caret = range.start + text.length;
      const nextMarks = rebaseMarks(value, next, marks, pending.current, caret);
      pending.current = null;
      commit(next, nextMarks, { anchor: caret, focus: caret }, 'insert', caretOf(root));
    };
    const sync = () => {
      const { value, marks, maxLength, multiline } = props.current;
      let text = readText(root);
      if (!multiline) text = text.replace(/\n/g, ' ');
      const caret = caretOf(root);
      if (text === painted.current?.text && text === value) return paint(value, marks, caret);
      if (text.length > maxLength) return paint(value, marks, before.current);
      const nextMarks = rebaseMarks(value, text, marks, pending.current, caret?.focus);
      pending.current = null;
      commit(text, nextMarks, caret, 'type');
    };
    const beforeInput = (event: InputEvent) => {
      if (!props.current.editable) return event.preventDefault();
      before.current = caretOf(root);
      const type = event.inputType;
      if (type === 'historyUndo' || type === 'historyRedo') {
        event.preventDefault();
        const h = history.current;
        if (type === 'historyUndo') restore(h.undo, h.redo);
        else restore(h.redo, h.undo);
      } else if (formatInputs[type]) {
        event.preventDefault();
        api.toggle(formatInputs[type]);
      } else if (type.startsWith('format')) event.preventDefault();
      else if (type === 'insertParagraph' || type === 'insertLineBreak') {
        event.preventDefault();
        if (props.current.multiline) insert('\n');
      } else if (type === 'insertFromPaste' || type === 'insertFromPasteAsQuotation') {
        event.preventDefault();
        insert(event.dataTransfer?.getData('text/plain') || '');
      } else if (type === 'insertFromDrop' || type === 'deleteByDrag') event.preventDefault();
    };
    const input = (event: Event) => {
      if (composing.current || (event as InputEvent).isComposing) return;
      sync();
    };
    const compositionStart = () => {
      composing.current = true;
      before.current = caretOf(root);
    };
    const compositionEnd = () => {
      composing.current = false;
      sync();
    };
    const currentRange = () => fieldRange(root);
    const api: RichFieldApi = {
      range: currentRange,
      style(range = currentRange() || undefined) {
        const { value, marks } = props.current;
        if (!range) return {};
        if (range.start === range.end) {
          const at = Math.max(0, range.start - 1);
          return { ...commonStyle(value.length, marks, at, at + 1), ...(pending.current as any) };
        }
        return commonStyle(value.length, marks, range.start, range.end);
      },
      apply(patch, range = currentRange() || undefined) {
        const { value, marks, editable } = props.current;
        if (!range || !editable) return;
        if (range.start === range.end) {
          pending.current = { ...pending.current, ...patch };
          return;
        }
        const caret = caretOf(root) || { anchor: range.start, focus: range.end };
        commit(
          value,
          applyStyle(value.length, marks, range.start, range.end, patch),
          caret,
          'format',
          caret,
        );
      },
      toggle(flag) {
        const range = currentRange();
        if (!range) return;
        api.apply({ [flag]: api.style(range)[flag] ? null : true }, range);
      },
      resize(step) {
        const range = currentRange();
        if (!range) return;
        const current = api.style(range).size || 1;
        const index = textSizes.findIndex((size) => size >= current - 0.001);
        const next = textSizes[Math.max(0, Math.min(textSizes.length - 1, index + step))];
        api.apply({ size: next === 1 ? null : next }, range);
      },
    };
    fields.set(root, api);
    root.addEventListener('beforeinput', beforeInput);
    root.addEventListener('input', input);
    root.addEventListener('compositionstart', compositionStart);
    root.addEventListener('compositionend', compositionEnd);
    return () => {
      fields.delete(root);
      root.removeEventListener('beforeinput', beforeInput);
      root.removeEventListener('input', input);
      root.removeEventListener('compositionstart', compositionStart);
      root.removeEventListener('compositionend', compositionEnd);
    };
  }, []);

  return (
    <div
      ref={(node) => {
        element.current = node;
        fieldRef?.(node);
      }}
      className={`rt-field ${className || ''}`}
      contentEditable={editable}
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      aria-multiline={multiline}
      aria-readonly={!editable}
      tabIndex={editable ? 0 : -1}
      spellCheck={editable}
      style={style}
      onKeyDown={(event) => {
        if (editable && (event.ctrlKey || event.metaKey) && !event.altKey) {
          const api = richField(event.currentTarget)!;
          const key = (event.shiftKey ? 'shift+' : '') + event.key.toLowerCase();
          const flag = shortcutFlags[key];
          let handled = true;
          if (flag) api.toggle(flag);
          else if (key === 'shift+n') api.apply(clearPatch);
          else if (event.shiftKey && (event.code === 'Period' || event.key === '>')) api.resize(1);
          else if (event.shiftKey && (event.code === 'Comma' || event.key === '<')) api.resize(-1);
          else handled = false;
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        onKeyDown?.(event);
      }}
      onClick={(event) => {
        if (editable) return;
        const spoiler = (event.target as HTMLElement).closest<HTMLElement>('.rt-spoiler');
        if (spoiler) onSpoiler?.(Number(spoiler.dataset.start));
      }}
    />
  );
}

export const clearPatch: StylePatch = {
  bold: null,
  italic: null,
  underline: null,
  strike: null,
  code: null,
  spoiler: null,
  color: null,
  highlight: null,
  font: null,
  size: null,
};
