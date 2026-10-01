import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { BoardGlyph, iconNames } from './Icon';
import IconPickerOverlay from './IconPickerOverlay';

const favorites = ['house', 'lightbulb', 'notebook', 'palette'];
export default function BoardSymbolPicker({
  value,
  disabled,
  onSelect,
}: {
  value: string;
  disabled: boolean;
  onSelect: (icon: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const row =
    iconNames.includes(value) && !favorites.includes(value)
      ? [...favorites.slice(0, 3), value]
      : favorites;
  const choice = (icon: string) => (
    <button
      type="button"
      className="icon-button"
      key={icon}
      aria-label={icon}
      title={icon.replaceAll('-', ' ')}
      aria-pressed={value === icon}
      disabled={disabled}
      onClick={() => {
        onSelect(icon);
        setExpanded(false);
      }}
    >
      <BoardGlyph name={icon} size={23} />
    </button>
  );
  return (
    <>
      <div className="icon-picker symbol-row" role="group" aria-label="Symbol icons">
        {row.map(choice)}
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label="More icons"
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
          title="Choose an icon"
          closeLabel="Close icon picker"
          trigger={trigger}
          onClose={() => setExpanded(false)}
          className="symbol-panel"
        >
          <div className="symbol-gallery">{iconNames.map(choice)}</div>
        </IconPickerOverlay>
      )}
    </>
  );
}
