import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { fontFamilies, type StylePatch, type TextFont, type TextStyle } from '../canvas/rich-text';
import { clearPatch, richField, type FieldRange, type RichFieldApi } from './RichTextField';

const textColors = [
  '#e5484d',
  '#f76b15',
  '#d6a100',
  '#30a46c',
  '#12a594',
  '#3e7bfa',
  '#8e4ec6',
  '#d6409f',
  '#8b8d98',
];
const highlights = [
  '#ffd43b',
  '#ffa94d',
  '#ff8787',
  '#69db7c',
  '#66d9e8',
  '#74c0fc',
  '#b197fc',
  '#f783ac',
];
const fonts: { id: TextFont | null; label: string; family: string }[] = [
  { id: null, label: 'Sans', family: fontFamilies.sans },
  { id: 'serif', label: 'Serif', family: fontFamilies.serif },
  { id: 'mono', label: 'Mono', family: fontFamilies.mono },
  { id: 'hand', label: 'Handwritten', family: fontFamilies.hand },
  { id: 'condensed', label: 'Condensed', family: fontFamilies.condensed },
];
const shortcut = (keys: string) =>
  keys.replace('Mod', navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl');

export function SpoilerGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="1.5"
        y="3.5"
        width="13"
        height="9"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      {[
        [4.2, 6],
        [6.8, 5.6],
        [9.6, 6.3],
        [12, 5.8],
        [5.3, 8.1],
        [8.2, 8.3],
        [10.9, 8],
        [3.9, 10.2],
        [6.6, 10.4],
        [9.4, 10.1],
        [12.1, 10.3],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.75" fill="currentColor" />
      ))}
    </svg>
  );
}

interface Target {
  field: HTMLElement;
  api: RichFieldApi;
  range: FieldRange;
  style: TextStyle;
  rect: DOMRect;
}
function currentTarget(): Target | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const start = selection.anchorNode;
  const element = start instanceof Element ? start : start?.parentElement;
  const field = element?.closest<HTMLElement>('.rt-field[contenteditable="true"]');
  if (!field || !selection.focusNode || !field.contains(selection.focusNode)) return null;
  const api = richField(field);
  const range = api?.range();
  if (!api || !range || range.start === range.end) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { field, api, range, style: api.style(range), rect };
}

// Floats above a text selection inside any editable rich field.
export default function RichFormatBar({ revision }: { revision?: unknown }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [menu, setMenu] = useState<'font' | 'color' | 'highlight' | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = currentTarget();
        setTarget((previous) => {
          // A new selection starts with the palettes closed.
          if (
            !next ||
            previous?.field !== next.field ||
            previous.range.start !== next.range.start ||
            previous.range.end !== next.range.end
          )
            setMenu(null);
          return next;
        });
      });
    };
    document.addEventListener('selectionchange', refresh);
    window.addEventListener('resize', refresh);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', refresh);
      window.removeEventListener('resize', refresh);
    };
  }, []);
  // The camera can move under a fixed selection; re-measure whenever the board renders.
  useLayoutEffect(() => {
    if (target) setTarget(currentTarget());
  }, [revision]);
  useLayoutEffect(() => {
    if (!target || !bar.current) return setPosition(null);
    const box = bar.current.getBoundingClientRect();
    const margin = 10;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - box.width - 8,
        target.rect.left + target.rect.width / 2 - box.width / 2,
      ),
    );
    let top = target.rect.top - box.height - margin;
    // Go below the selection rather than cover the object's own toolbar.
    const covers = [...document.querySelectorAll<HTMLElement>('.selection-tools')].some((tools) => {
      const r = tools.getBoundingClientRect();
      return (
        getComputedStyle(tools).visibility !== 'hidden' &&
        r.bottom > top &&
        r.top < top + box.height &&
        r.right > left &&
        r.left < left + box.width
      );
    });
    if (top < 8 || covers) top = target.rect.bottom + margin;
    setPosition({ left, top: Math.min(top, window.innerHeight - box.height - 8) });
  }, [target, menu]);
  if (!target) return null;
  const { api, range, style } = target;
  // "No font" is the field's own: sans on lists and text, handwriting on notes.
  const own = getComputedStyle(target.field).fontFamily;
  const choices = fonts.map((font) =>
    font.id === null && !/^"?Segoe UI"?,/.test(own)
      ? { ...font, label: 'Default', family: own }
      : font,
  );
  const apply = (patch: StylePatch) => {
    api.apply(patch, range);
    setTarget(currentTarget());
  };
  const flag = (
    key: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'spoiler',
    label: string,
    keys: string,
    icon: ReactNode,
  ) => (
    <button
      className="icon-button"
      aria-label={label}
      title={`${label} (${shortcut(keys)})`}
      aria-pressed={!!style[key]}
      data-format={key}
      onClick={() => apply({ [key]: style[key] ? null : true })}
    >
      {icon}
    </button>
  );
  return createPortal(
    <div
      ref={bar}
      className="rich-format-bar glass-surface"
      role="toolbar"
      aria-label="Text formatting"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
      }}
      // Keep the text selection: nothing here takes focus.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="rich-format-row">
        {flag('bold', 'Bold', 'Mod+B', <Bold size={16} strokeWidth={2.4} />)}
        {flag('italic', 'Italic', 'Mod+I', <Italic size={16} />)}
        {flag('underline', 'Underline', 'Mod+U', <Underline size={16} />)}
        {flag('strike', 'Strikethrough', 'Mod+Shift+X', <Strikethrough size={16} />)}
        {flag('code', 'Monospace', 'Mod+Shift+M', <Code size={16} />)}
        {flag('spoiler', 'Spoiler', 'Mod+Shift+P', <SpoilerGlyph />)}
        <span className="rich-format-divider" />
        <button
          className="icon-button rich-format-font"
          aria-label="Font"
          title="Font"
          aria-expanded={menu === 'font'}
          onClick={() => setMenu(menu === 'font' ? null : 'font')}
        >
          <span style={{ fontFamily: style.font ? fontFamilies[style.font] : own }}>
            {choices.find((f) => f.id === (style.font || null))?.label || 'Font'}
          </span>
          <ChevronDown size={12} />
        </button>
        <button
          className="icon-button"
          aria-label="Smaller text"
          title={`Smaller (${shortcut('Mod+Shift+<')})`}
          onClick={() => {
            api.resize(-1);
            setTarget(currentTarget());
          }}
        >
          <AArrowDown size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Larger text"
          title={`Larger (${shortcut('Mod+Shift+>')})`}
          onClick={() => {
            api.resize(1);
            setTarget(currentTarget());
          }}
        >
          <AArrowUp size={17} />
        </button>
        <span className="rich-format-divider" />
        <button
          className="icon-button rich-format-swatch-button"
          aria-label="Text color"
          title="Text color"
          aria-expanded={menu === 'color'}
          onClick={() => setMenu(menu === 'color' ? null : 'color')}
        >
          <Baseline size={17} />
          <i style={{ background: style.color || 'currentColor' }} />
        </button>
        <button
          className="icon-button rich-format-swatch-button"
          aria-label="Highlight"
          title="Highlight"
          aria-expanded={menu === 'highlight'}
          onClick={() => setMenu(menu === 'highlight' ? null : 'highlight')}
        >
          <Highlighter size={16} />
          <i style={{ background: style.highlight || 'transparent' }} />
        </button>
        <span className="rich-format-divider" />
        <button
          className="icon-button"
          aria-label="Clear formatting"
          title={`Clear formatting (${shortcut('Mod+Shift+N')})`}
          onClick={() => apply(clearPatch)}
        >
          <RemoveFormatting size={16} />
        </button>
      </div>
      {menu === 'font' && (
        <div className="rich-format-menu rich-format-fonts" role="menu">
          {choices.map((font) => (
            <button
              key={font.label}
              role="menuitemradio"
              aria-checked={(style.font || null) === font.id}
              style={{ fontFamily: font.family }}
              onClick={() => apply({ font: font.id })}
            >
              {font.label}
            </button>
          ))}
        </div>
      )}
      {(menu === 'color' || menu === 'highlight') && (
        <div className="rich-format-menu rich-format-swatches" role="menu">
          <button
            role="menuitemradio"
            className="rich-format-swatch rich-format-none"
            aria-label={menu === 'color' ? 'Default color' : 'No highlight'}
            title={menu === 'color' ? 'Default' : 'None'}
            aria-checked={!style[menu]}
            onClick={() => apply({ [menu]: null })}
          />
          {(menu === 'color' ? textColors : highlights).map((color) => (
            <button
              key={color}
              role="menuitemradio"
              className="rich-format-swatch"
              data-kind={menu}
              aria-label={color}
              aria-checked={style[menu]?.toLowerCase() === color}
              style={{ ['--swatch' as string]: color }}
              onClick={() => apply({ [menu]: color })}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
