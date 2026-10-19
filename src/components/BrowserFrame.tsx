import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react';
import { browserAddress } from '../canvas/html-card';
import './html-embed.css';

// The session every browser frame shares (electron/browser-frames.cjs).
const partition = 'persist:terra-browser';

// Electron's <webview> element, as the board uses it.
export interface BrowserView extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
}

// A running browser frame: its address bar and the website itself.
export function BrowserFrame({
  url,
  focusAddress,
  viewRef,
  onNavigate,
  onOpenExternal,
}: {
  url: string;
  focusAddress: boolean;
  viewRef: MutableRefObject<BrowserView | null>;
  onNavigate: (url: string, title: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(url);
  const [nav, setNav] = useState({ back: false, forward: false, loading: true });
  const editing = useRef(false);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  useEffect(() => {
    const view = document.createElement('webview') as BrowserView;
    view.setAttribute('partition', partition);
    view.setAttribute('allowpopups', '');
    view.setAttribute('src', url);
    view.className = 'browser-frame-page';
    let ready = false;
    const sync = () => {
      if (!ready) return;
      setNav({ back: view.canGoBack(), forward: view.canGoForward(), loading: view.isLoading() });
    };
    const report = () => {
      if (!ready) return;
      const current = view.getURL();
      if (!editing.current) setAddress(current);
      navigate.current(current, view.getTitle());
      sync();
    };
    const events: [string, (event: Event & { isMainFrame?: boolean }) => void][] = [
      [
        'dom-ready',
        () => {
          ready = true;
          report();
        },
      ],
      ['did-navigate', report],
      ['did-navigate-in-page', (event) => event.isMainFrame !== false && report()],
      ['page-title-updated', report],
      ['did-start-loading', sync],
      ['did-stop-loading', sync],
    ];
    for (const [name, listener] of events) view.addEventListener(name, listener);
    host.current!.appendChild(view);
    viewRef.current = view;
    return () => {
      for (const [name, listener] of events) view.removeEventListener(name, listener);
      if (viewRef.current === view) viewRef.current = null;
      view.remove();
    };
  }, []);
  useEffect(() => {
    if (!focusAddress) return;
    input.current?.focus();
    input.current?.select();
  }, []);
  const go = () => {
    const next = browserAddress(input.current?.value ?? address);
    if (!next) return;
    setAddress(next);
    void viewRef.current?.loadURL(next).catch(() => {});
    input.current?.blur();
  };
  return (
    <div className="browser-frame">
      <div className="browser-frame-bar">
        <button aria-label="Back" disabled={!nav.back} onClick={() => viewRef.current?.goBack()}>
          <ArrowLeft size={15} />
        </button>
        <button
          aria-label="Forward"
          disabled={!nav.forward}
          onClick={() => viewRef.current?.goForward()}
        >
          <ArrowRight size={15} />
        </button>
        <button
          aria-label={nav.loading ? 'Stop loading' : 'Reload'}
          onClick={() => (nav.loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          {nav.loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            go();
          }}
        >
          <input
            ref={input}
            aria-label="Address"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              editing.current = true;
              event.currentTarget.select();
            }}
            onBlur={() => {
              editing.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              setAddress(viewRef.current?.getURL() || url);
              event.currentTarget.blur();
            }}
          />
        </form>
        <button
          aria-label="Open in your browser"
          title="Open in your browser"
          onClick={() => onOpenExternal(viewRef.current?.getURL() || address)}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div ref={host} className="browser-frame-host" />
    </div>
  );
}
