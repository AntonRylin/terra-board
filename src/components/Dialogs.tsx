import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const el = ref.current;
    (
      el?.querySelector<HTMLElement>('input,textarea,select') ||
      el?.querySelector<HTMLElement>('button')
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The first Escape cancels a name draft; another closes the dialog.
        if ((e.target as HTMLElement).closest('.inline-name[contenteditable="plaintext-only"]'))
          return;
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key === 'Tab' && el) {
        const items = [
          ...el.querySelectorAll<HTMLElement>(
            'button,input,textarea,select,a[href],[tabindex="0"]',
          ),
        ].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      before?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={'modal ' + (wide ? 'wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export interface MenuItem {
  label: string;
  action: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  hint?: string;
}
export type MenuPlacement = 'below' | 'above' | 'left' | 'pointer';
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  className = '',
  placement = 'below',
}: {
  x: number;
  y: number;
  items: (MenuItem | null)[];
  onClose: () => void;
  className?: string;
  placement?: MenuPlacement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.maxHeight = '';
    el.style.overflowY = '';
    const left =
      placement === 'left' || (placement === 'pointer' && x + el.offsetWidth > innerWidth - 12)
        ? x - el.offsetWidth
        : x;
    // A menu that doesn't fit below its point opens above it rather than being pushed up
    // over it (and over the button or toolbar that opened it, at the bottom of a phone).
    // Where neither side has room, it takes the larger side and scrolls.
    const room = { below: innerHeight - 12 - y, above: y - 8 };
    const up = placement === 'above' || (el.offsetHeight > room.below && room.above > room.below);
    const space = up ? room.above : room.below;
    if (el.offsetHeight > space) {
      el.style.maxHeight = Math.max(120, space) + 'px';
      el.style.overflowY = 'auto';
    }
    const top = up ? y - el.offsetHeight : y;
    el.style.left = Math.max(8, Math.min(left, innerWidth - el.offsetWidth - 12)) + 'px';
    el.style.top = Math.max(8, Math.min(top, innerHeight - el.offsetHeight - 12)) + 'px';
    el.focus({ preventScroll: true });
  }, [x, y, placement]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={'context-menu ' + className}
      role="menu"
      tabIndex={-1}
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item ? (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            title={item.hint}
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ) : (
          <hr key={i} />
        ),
      )}
    </div>
  );
}
