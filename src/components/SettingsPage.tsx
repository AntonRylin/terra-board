import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react';
import McpSettings from './McpSettings';
import AppearanceSettings from './AppearanceSettings';
import type { Appearance } from './useAppearance';
import { searchSettings, sectionById, sections, type SectionId } from './settings/settings-index';
import { GeneralSettings, PanelSettings, type PanelOptions } from './settings/GeneralSettings';
import { CanvasSettings, RadialSettings } from './settings/CanvasSettings';
import { ShortcutSettings } from './settings/ShortcutSettings';
import { AboutSettings, StorageSettings } from './settings/StorageSettings';
import './settings/settings.css';

// Reopening Settings returns to the section used last in this session.
let lastSection: SectionId = 'general';

export default function SettingsPage({
  onClose,
  transparency,
  onTransparency,
  appearance,
  panel,
}: {
  onClose: () => void;
  transparency: number;
  onTransparency: (value: number) => void;
  appearance: Appearance;
  panel: PanelOptions;
}) {
  const page = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SectionId>(lastSection);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Focus for Escape and Tab order without drawing a ring on open.
    back.current?.focus({ focusVisible: false } as FocusOptions);
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
  useLayoutEffect(() => {
    lastSection = section;
    if (!target) scroller.current?.scrollTo({ top: 0 });
  }, [section]);
  useEffect(() => {
    if (!target) return;
    const row = document.getElementById('setting-' + target);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.setAttribute('data-flash', '');
    const timer = setTimeout(() => {
      row.removeAttribute('data-flash');
      setTarget(null);
    }, 1400);
    return () => {
      clearTimeout(timer);
      row.removeAttribute('data-flash');
    };
  }, [target, section]);

  const open = (id: SectionId) => {
    setQuery('');
    setTarget(null);
    setSection(id);
  };
  const results = searchSettings(query);
  const current = sectionById(section);
  const groups = [...new Set(sections.map((s) => s.group))];

  return (
    <main
      ref={page}
      className="settings-page"
      aria-label="Settings"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          if (query && (event.target as HTMLElement).closest('.st-search')) setQuery('');
          else onClose();
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <aside className="st-sidebar">
        <button
          ref={back}
          type="button"
          className="st-back"
          onClick={onClose}
          aria-label="Back to board"
        >
          <ArrowLeft size={16} /> Back to board
        </button>
        <div className="st-sidebar-title">Settings</div>
        <label className="st-search">
          <Search size={15} />
          <input
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <nav className="st-nav" aria-label="Settings sections">
          {groups.map((group) => (
            <div className="st-nav-group" key={group}>
              <div className="st-nav-heading">{group}</div>
              {sections
                .filter((s) => s.group === group)
                .map((s) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className="st-nav-item"
                      aria-current={!query && s.id === section ? 'page' : undefined}
                      onClick={() => open(s.id)}
                    >
                      <Icon size={16} />
                      {s.label}
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>
      </aside>
      <div className="st-scroll" ref={scroller}>
        <div className="st-content">
          {query.trim() ? (
            <>
              <h1>Search</h1>
              <p className="st-subtitle">
                {results.length
                  ? `${results.length} setting${results.length === 1 ? '' : 's'} match “${query.trim()}”.`
                  : `Nothing matches “${query.trim()}”.`}
              </p>
              {results.length > 0 && (
                <div className="st-card st-results">
                  {results.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="st-result"
                      onClick={() => {
                        setQuery('');
                        setSection(r.section);
                        setTarget(r.id);
                      }}
                    >
                      <span>
                        <span className="st-result-path">{sectionById(r.section).label}</span>
                        <span className="st-row-title">{r.title}</span>
                        {r.description && (
                          <span className="st-row-description">{r.description}</span>
                        )}
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <h1>{current.label}</h1>
              <p className="st-subtitle">{current.subtitle}</p>
              {section === 'general' && <GeneralSettings />}
              {section === 'appearance' && (
                <AppearanceSettings
                  transparency={transparency}
                  onTransparency={onTransparency}
                  appearance={appearance}
                />
              )}
              {section === 'panel' && <PanelSettings panel={panel} />}
              {section === 'canvas' && <CanvasSettings />}
              {section === 'radial' && <RadialSettings />}
              {section === 'shortcuts' && <ShortcutSettings />}
              {section === 'storage' && <StorageSettings />}
              {section === 'ai' && <McpSettings />}
              {section === 'about' && <AboutSettings />}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
