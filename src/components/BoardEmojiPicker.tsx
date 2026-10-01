import { useState } from 'react';
import { Plus } from 'lucide-react';

const favorites = ['🌿', '✨', '💡', '🎯'];
const more = [
  '😀',
  '🥰',
  '😎',
  '🤩',
  '🤔',
  '🥳',
  '❤️',
  '💛',
  '💚',
  '💙',
  '💜',
  '🔥',
  '⭐',
  '🌈',
  '☀️',
  '🌙',
  '🌸',
  '🌻',
  '🌵',
  '🍀',
  '🐶',
  '🐱',
  '🦊',
  '🐻',
  '🦋',
  '🐝',
  '🍎',
  '🍋',
  '☕',
  '🍕',
  '🏠',
  '🏔️',
  '🏖️',
  '🌍',
  '✈️',
  '🚀',
  '📚',
  '🎨',
  '🎵',
  '📷',
  '💻',
  '🛠️',
  '💼',
  '💰',
  '📌',
  '✅',
  '🏆',
  '🎁',
  '🧠',
  '💪',
];
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
  const emoji = custom.trim();
  const valid =
    emoji.length > 0 &&
    emoji.length <= 79 &&
    [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(emoji)].length === 1 &&
    /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(emoji);
  const selected = value.startsWith('emoji:') ? value.slice(6) : '';
  const row =
    selected && !favorites.includes(selected) ? [...favorites.slice(0, 3), selected] : favorites;
  const choice = (symbol: string) => (
    <button
      type="button"
      className="icon-button emoji-choice"
      key={symbol}
      aria-label={'Use emoji ' + symbol}
      aria-pressed={selected === symbol}
      disabled={disabled}
      onClick={() => onSelect('emoji:' + symbol)}
    >
      {symbol}
    </button>
  );
  return (
    <div className="board-emoji-picker">
      <div className="icon-picker emoji-row" role="group" aria-label="Emoji icons">
        {row.map(choice)}
        <button
          type="button"
          className="icon-button"
          aria-label="More emojis"
          aria-expanded={expanded}
          disabled={disabled}
          onClick={() => setExpanded(!expanded)}
        >
          <Plus size={20} />
        </button>
      </div>
      {expanded && (
        <div className="emoji-more">
          <div className="emoji-more-grid" role="group" aria-label="More emoji choices">
            {more.map(choice)}
          </div>
          <div className="emoji-custom">
            <input
              aria-label="Custom emoji"
              placeholder="Paste an emoji…"
              value={custom}
              maxLength={79}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (valid && !disabled) {
                    onSelect('emoji:' + emoji);
                    setCustom('');
                  }
                }
              }}
            />
            <button
              type="button"
              className="button"
              disabled={disabled || !valid}
              onClick={() => {
                onSelect('emoji:' + emoji);
                setCustom('');
              }}
            >
              Use
            </button>
          </div>
          <p>Choose one emoji, or use the Windows emoji picker (Win + .).</p>
        </div>
      )}
    </div>
  );
}
