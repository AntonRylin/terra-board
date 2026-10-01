import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function IconPickerOverlay({
  title,
  closeLabel,
  trigger,
  onClose,
  children,
  className = '',
}: {
  title: string;
  closeLabel: string;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const parent = trigger.current?.closest<HTMLElement>('.modal');
    const wasInert = parent?.inert ?? false;
    if (parent) parent.inert = true;
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
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
  }, [trigger]);
  return createPortal(
    <div
      className="emoji-overlay"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <div
        ref={panel}
        className={'emoji-panel ' + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
