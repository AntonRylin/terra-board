import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import './object-lock.css';

export function ObjectLockGlyph({ locked = false }: { locked?: boolean }) {
  return (
    <svg
      className="object-lock-glyph"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={locked ? 'M7 11V7a5 5 0 0 1 10 0v4' : 'M7 11V7a5 5 0 0 1 9.6-2'} />
      <rect x="4" y="10" width="16" height="11" rx="3" />
      <path d="M12 14.5v2" />
    </svg>
  );
}

export default function ObjectLockButton({
  locked,
  selectionKey,
  onChange,
  children,
  onPointerDown,
  onKeyDown,
  onContextMenu,
  ...buttonProps
}: {
  locked: boolean;
  selectionKey: string;
  onChange: (locked: boolean) => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>) {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const started = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const keyboardPress = useRef(false);
  const change = useRef(onChange);
  change.current = onChange;
  const cancel = () => {
    cancelAnimationFrame(frame.current);
    started.current = null;
    keyboardPress.current = false;
    setProgress(0);
  };
  useEffect(() => {
    cancel();
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frame.current);
      started.current = null;
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [locked, selectionKey]);
  const begin = () => {
    suppressClick.current = locked;
    if (!locked || started.current !== null) return;
    started.current = performance.now();
    const tick = () => {
      if (started.current === null) return;
      const next = Math.min(1, (performance.now() - started.current) / 3000);
      setProgress(next);
      if (next >= 1) {
        started.current = null;
        change.current(false);
      } else frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  const label = locked ? 'Hold 3 seconds to unlock' : 'Lock selection';
  return (
    <button
      {...buttonProps}
      className="icon-button object-lock"
      aria-label={label}
      aria-pressed={locked}
      data-locked={locked}
      data-holding={progress > 0}
      data-lock-label={progress > 0 ? `Keep holding · ${Math.ceil(5 * (1 - progress))}s` : label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        onPointerDown?.(event);
        begin();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
          cancel();
          return;
        }
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          keyboardPress.current = true;
          begin();
        }
      }}
      onKeyUp={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        if (keyboardPress.current && !locked && !suppressClick.current) change.current(true);
        cancel();
      }}
      onClick={() => {
        if (!locked && !suppressClick.current) change.current(true);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu?.(event);
      }}
    >
      <ObjectLockGlyph locked={locked} />
      {children}
      <svg className="object-lock-progress" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="16" pathLength="1" strokeDasharray={`${progress} 1`} />
      </svg>
      <span className="sr-only" role="status">
        {progress > 0
          ? 'Keep holding to unlock'
          : locked
            ? 'Selection locked'
            : 'Selection unlocked'}
      </span>
    </button>
  );
}
