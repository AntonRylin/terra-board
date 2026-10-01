import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import IconPickerOverlay from './IconPickerOverlay';
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
      {expanded && (
        <IconPickerOverlay
          title="Choose an emoji"
          closeLabel="Close emoji picker"
          trigger={trigger}
          onClose={() => setExpanded(false)}
        >
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
        </IconPickerOverlay>
      )}
    </div>
  );
}
