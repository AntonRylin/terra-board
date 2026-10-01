import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import EmojiGallery from './EmojiGallery';

const favorites = ['🌿', '✨', '💡', '🎯'];
export default function BoardEmojiPicker({
  value,
  disabled,
  onSelect,
}: {
  value: string;
  disabled: boolean;
  onSelect: (icon: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [custom, setCustom] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const parent = trigger.current?.closest<HTMLElement>('.modal');
    const wasInert = parent?.inert ?? false;
    if (parent) parent.inert = true;
    closeButton.current?.focus();
    // Capture before the parent dialog's document listener: Escape and Tab
    // belong to this overlay while it is open.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setExpanded(false);
      } else if (event.key === 'Tab') {
        event.stopImmediatePropagation();
        const items = [
          ...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') || []),
        ];
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (parent) parent.inert = wasInert;
      trigger.current?.focus();
    };
  }, [expanded]);
  const emoji = custom.trim();
  const valid =
    emoji.length > 0 &&
    emoji.length <= 79 &&
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(emoji)].length === 1 &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji);
  const selected = value.startsWith('emoji:') ? value.slice(6) : '';
  const row =
    selected && !favorites.includes(selected) ? [...favorites.slice(0, 3), selected] : favorites;
  const pick = (symbol: string) => {
    onSelect('emoji:' + symbol);
    setExpanded(false);
    setCustom('');
  };
  const choice = (symbol: string) => (
    <button
      type="button"
      className="icon-button emoji-choice"
      key={symbol}
      aria-label={'Use emoji ' + symbol}
      aria-pressed={selected === symbol}
      disabled={disabled}
      onClick={() => pick(symbol)}
    >
      {symbol}
    </button>
  );
  return (
    <div className="board-emoji-picker">
      <div className="icon-picker emoji-row" role="group" aria-label="Emoji icons">
        {row.map(choice)}
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label="More emojis"
          aria-haspopup="dialog"
          aria-expanded={expanded}
          disabled={disabled}
          onClick={() => setExpanded(true)}
        >
          <Plus size={20} />
        </button>
      </div>
      {expanded &&
        createPortal(
          <div
            className="emoji-overlay"
            onMouseDown={(event) => {
              event.stopPropagation();
              if (event.target === event.currentTarget) setExpanded(false);
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
            onPaste={(event) => event.stopPropagation()}
            onDrop={(event) => event.stopPropagation()}
          >
            <div
              ref={panel}
              className="emoji-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Choose an emoji"
            >
              <header>
                <h2>Choose an emoji</h2>
                <button
                  ref={closeButton}
                  type="button"
                  className="icon-button"
                  aria-label="Close emoji picker"
                  onClick={() => setExpanded(false)}
                >
                  <X size={20} />
                </button>
              </header>
              <EmojiGallery renderEmoji={choice} />
              <div className="emoji-custom">
                <input
                  aria-label="Custom emoji"
                  placeholder="Paste custom emoji…"
                  value={custom}
                  maxLength={79}
                  onChange={(event) => setCustom(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (valid && !disabled) pick(emoji);
                    }
                  }}
                />
                <button
                  type="button"
                  className="button primary"
                  disabled={disabled || !valid}
                  onClick={() => pick(emoji)}
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
