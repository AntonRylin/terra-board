import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Search, X } from 'lucide-react';
import McpSettings from './McpSettings';
import AppearanceSettings from './AppearanceSettings';
import type { Appearance } from './useAppearance';
import type { Library } from '../model';
import { android, openLink } from '../bridge';
import { MobileAccountSettings } from '../mobile/platform';
import {
  searchSettings,
  sectionById,
  sectionVisible,
  visibleSections as sections,
  type SectionId,
} from './settings/settings-index';
import { GeneralSettings, PanelSettings, type PanelOptions } from './settings/GeneralSettings';
import { CanvasSettings, RadialSettings } from './settings/CanvasSettings';
import { ShortcutSettings } from './settings/ShortcutSettings';
import { AboutSettings, StorageSettings } from './settings/StorageSettings';
import { CloudSettings } from './settings/CloudSettings';
import { AccountSettings } from './settings/AccountSettings';
import { BoardsSettings } from './settings/BoardsSettings';
import { ProfileSettings } from './settings/ProfileSettings';
import { ExtensionsSettings } from './settings/ExtensionsSettings';
import './settings/settings.css';

const discordUrl = 'https://discord.com/invite/kfTbsN7eF7';

// Reopening Settings returns to the section used last in this session.
let lastSection: SectionId = 'general';

export default function SettingsPage({
  onClose,
  transparency,
  onTransparency,
  appearance,
  panel,
  library,
  onManageShare,
  initialSection,
  connectAddress,
}: {
  onClose: () => void;
  transparency: number;
  onTransparency: (value: number) => void;
  appearance: Appearance;
  panel: PanelOptions;
  library?: Library;
  onManageShare?: (kind: 'folder' | 'board', id: string) => void;
  initialSection?: SectionId;
  connectAddress?: string;
}) {
  const page = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SectionId>(() => {
    const wanted = initialSection ?? lastSection;
    return sectionVisible(wanted) ? wanted : sections[0].id;
  });
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
        <button
          type="button"
          className="st-nav-item st-discord"
          onClick={() => void openLink(discordUrl)}
        >
          <svg
            viewBox="0 0 127.14 96.36"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M107.7,8.07A105.15,105.15,0,0,0,77.26,0a77.19,77.19,0,0,0-3.3,6.83A96.67,96.67,0,0,0,52.8,6.83,77.19,77.19,0,0,0,49.5,0,105.15,105.15,0,0,0,19.06,8.07C-3.41,41.92-1.74,75.16,8.32,96A105.73,105.73,0,0,0,39.46,84.14a79.25,79.25,0,0,0,6.6-11A67.46,67.46,0,0,1,34,68.32c1-.7,1.94-1.44,2.83-2.22a74.37,74.37,0,0,0,53.46,0c.89.78,1.86,1.52,2.83,2.22a67.46,67.46,0,0,1-12.06,4.82,79.25,79.25,0,0,0,6.6,11A105.73,105.73,0,0,0,118.4,96C128.46,75.16,129.8,41.92,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53S36.18,40.36,42.45,40.36,53.9,46,53.9,53,48.72,65.69,42.45,65.69Zm42,0C78.18,65.69,73,60,73,53S78.18,40.36,84.45,40.36,95.9,46,95.9,53,90.72,65.69,84.45,65.69Z" />
          </svg>
          Discord
        </button>
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
              {section === 'profile' && <ProfileSettings />}
              {section === 'general' && <GeneralSettings />}
              {section === 'appearance' && (
                <AppearanceSettings
                  transparency={transparency}
                  onTransparency={onTransparency}
                  appearance={appearance}
                />
              )}
              {section === 'panel' && <PanelSettings panel={panel} />}
              {section === 'extensions' && <ExtensionsSettings />}
              {section === 'canvas' && <CanvasSettings />}
              {section === 'radial' && <RadialSettings />}
              {section === 'shortcuts' && <ShortcutSettings />}
              {section === 'account' &&
                (android ? (
                  <MobileAccountSettings />
                ) : (
                  <AccountSettings
                    connectAddress={connectAddress}
                    library={library}
                    onOpenBoards={() => open('boards')}
                  />
                ))}
              {section === 'boards' && (
                <BoardsSettings
                  library={library}
                  onManageShare={onManageShare}
                  onSignIn={() => open('account')}
                />
              )}
              {section === 'cloud' && (
                <CloudSettings
                  library={library}
                  onManageShare={onManageShare}
                  onSignIn={() => open('account')}
                />
              )}
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
