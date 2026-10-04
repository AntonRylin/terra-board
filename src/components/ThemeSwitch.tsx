import { Moon, Sun, Monitor } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ThemePreference } from '../appearance';

const modes = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export default function ThemeSwitch({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const index = modes.findIndex((mode) => mode.value === value);
  return (
    <div
      className="theme-switch"
      role="radiogroup"
      aria-label="Color theme"
      style={{ '--theme-index': index } as CSSProperties}
    >
      <span className="theme-switch-thumb" aria-hidden="true" />
      {modes.map(({ value: mode, label, Icon }, i) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={value === mode}
          tabIndex={value === mode ? 0 : -1}
          onClick={() => onChange(mode)}
          onKeyDown={(event) => {
            const delta =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (!delta && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + delta + 3) % 3;
            event.currentTarget.parentElement!.querySelectorAll('button')[next].focus();
            onChange(modes[next].value);
          }}
        >
          <Icon size={17} strokeWidth={1.7} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
