import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import McpSettings from './McpSettings';

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const page = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    back.current?.focus();
    // Clicking empty page space can move focus to body. Keep global board
    // shortcuts isolated even when events no longer originate inside this page.
    const guard = (event: Event) => {
      if (event.target instanceof Node && !page.current?.contains(event.target)) {
        event.stopImmediatePropagation();
        if (event instanceof KeyboardEvent && event.type === 'keydown' && event.key === 'Escape')
          back.current?.click();
      }
    };
    const events = ['keydown', 'keyup', 'paste', 'copy', 'cut', 'drop'];
    events.forEach((name) => window.addEventListener(name, guard, true));
    return () => {
      events.forEach((name) => window.removeEventListener(name, guard, true));
      previous?.focus();
    };
  }, []);
  return (
    <main
      ref={page}
      className="settings-page"
      aria-label="Settings"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') onClose();
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <header className="settings-page-header">
        <button
          ref={back}
          className="button settings-back"
          onClick={onClose}
          aria-label="Back to board"
        >
          <ArrowLeft size={18} /> Back to board
        </button>
        <span>Terra Board</span>
      </header>
      <div className="settings-page-scroll">
        <div className="settings-page-content">
          <h1>Settings</h1>
          <p className="settings-intro">Make this space work for you.</p>
          <section className="settings-section" aria-label="AI connections">
            <McpSettings />
          </section>
        </div>
      </div>
    </main>
  );
}
