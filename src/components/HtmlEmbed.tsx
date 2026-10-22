import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { htmlSourceLimit } from '../canvas/html-card';
import './html-embed.css';

// Sandboxed: an opaque origin with no access to the app, its storage or the
// board. Pages may run scripts, submit forms and load from the web.
const sandbox = 'allow-scripts allow-forms allow-modals allow-pointer-lock';

// What a page on the board passes back: wheel turns it did not scroll or
// handle itself (a page's own wheel handler that cancels or stops the turn
// keeps it, say for a map's zoom), and presses away from anything clickable.
// With scrolling left to the board, a scrollable page passes its turns back
// too. Coordinates are page CSS pixels.
export type HtmlRelay =
  | {
      kind: 'wheel';
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      deltaMode: number;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    }
  | { kind: 'press'; x: number; y: number };
const relayScript = (scroll: boolean) => `<script>(()=>{
const scroll=${scroll};
const send=(m)=>parent.postMessage({terraRelay:m},'*');
const scrolls=(el,e)=>{const s=getComputedStyle(el),root=el===document.scrollingElement;
const can=(o)=>root?o!=='hidden':/auto|scroll|overlay/.test(o);
if(e.deltaY&&can(s.overflowY)&&(e.deltaY<0?el.scrollTop>0:el.scrollTop+el.clientHeight<el.scrollHeight-1))return true;
return !!e.deltaX&&can(s.overflowX)&&(e.deltaX<0?el.scrollLeft>0:el.scrollLeft+el.clientWidth<el.scrollWidth-1);};
addEventListener('wheel',(e)=>{
if(e.defaultPrevented)return;
if(scroll&&!e.ctrlKey&&!e.metaKey)for(let el=e.target instanceof Element?e.target:null;el;el=el.parentElement)if(scrolls(el,e))return;
e.preventDefault();
send({kind:'wheel',x:e.clientX,y:e.clientY,deltaX:e.deltaX,deltaY:e.deltaY,deltaMode:e.deltaMode,ctrlKey:e.ctrlKey,metaKey:e.metaKey,shiftKey:e.shiftKey,altKey:e.altKey});
},{passive:false});
const clickable='a[href],button,input,select,textarea,label,summary,details,video,audio,[contenteditable],[onclick],[tabindex],[role=button],[role=link],[role=checkbox],[role=tab]';
addEventListener('pointerdown',(e)=>{
if(e.button!==0)return;
for(let el=e.target instanceof Element?e.target:null;el;el=el.parentElement)
if(el.matches(clickable)||getComputedStyle(el).cursor==='pointer')return;
send({kind:'press',x:e.clientX,y:e.clientY});
},true);
})()</script>`;

// A running HTML embed. The desktop app serves the page from its own origin so
// the board's Content-Security-Policy does not apply to it. With onRelay, the
// page also reports what the board should handle (HtmlRelay); with
// wheelToBoard, the page scrolls none of its own and every wheel turn goes back.
export function HtmlEmbedFrame({
  html,
  title,
  onRelay,
  onLoad,
  wheelToBoard = false,
}: {
  html: string;
  title: string;
  onRelay?: (message: HtmlRelay) => void;
  onLoad?: () => void;
  wheelToBoard?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const relay = useRef(onRelay);
  relay.current = onRelay;
  const relayed = !!onRelay;
  // After the page's own markup, so a doctype stays first.
  const page = relayed ? html + relayScript(!wheelToBoard) : html;
  useEffect(() => {
    if (!window.canvas) return;
    let current = true;
    void window.canvas
      .htmlPage(page)
      .then((url) => {
        if (current) setSrc(url);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [page]);
  useEffect(() => {
    if (!relayed) return;
    const listen = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = (e.data as { terraRelay?: HtmlRelay } | null)?.terraRelay;
      if (m && (m.kind === 'wheel' || m.kind === 'press') && Number.isFinite(m.x + m.y))
        relay.current?.(m);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [relayed]);
  if (!window.canvas)
    return (
      <iframe
        ref={frame}
        title={title}
        srcDoc={page}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
      />
    );
  return src ? (
    <iframe
      ref={frame}
      key={src}
      title={title}
      src={src}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      onLoad={onLoad}
    />
  ) : null;
}

const indent = '  ';

// The page at the embed's size, scaled down to fit the pane like on the board.
function SizedPreview({ html, width, height }: { html: string; width: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () =>
      setScale(Math.min(1, (el.clientWidth - 24) / width, (el.clientHeight - 24) / height));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);
  return (
    <div ref={box} className="html-editor-preview" aria-label="Preview">
      <div
        className="html-editor-page"
        style={{
          width,
          height,
          transform: `translate(-50%, -50%) scale(${Math.max(0.05, scale)})`,
        }}
      >
        <HtmlEmbedFrame html={html} title="Preview" />
      </div>
    </div>
  );
}

export function HtmlEmbedEditor({
  html,
  width,
  height,
  onSave,
  onClose,
}: {
  html: string;
  width: number;
  height: number;
  onSave: (html: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(html);
  const [preview, setPreview] = useState(html);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ draft, html, onSave, onClose });
  latest.current = { draft, html, onSave, onClose };
  useEffect(() => {
    const timer = setTimeout(() => setPreview(draft), 450);
    return () => clearTimeout(timer);
  }, [draft]);
  const save = () => {
    const { draft, html, onSave, onClose } = latest.current;
    if (draft.length > htmlSourceLimit) return;
    if (draft !== html) onSave(draft);
    onClose();
  };
  const cancel = () => {
    const { draft, html, onClose } = latest.current;
    if (draft !== html && !window.confirm('Discard your changes to this HTML embed?')) return;
    onClose();
  };
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(0, 0);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      before?.focus();
    };
  }, []);
  // Tab indents instead of leaving the editor; Shift+Tab outdents.
  const keyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const el = e.currentTarget,
      { selectionStart: start, selectionEnd: end, value } = el;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    if (!e.shiftKey && start === end) {
      el.setRangeText(indent, start, end, 'end');
    } else {
      const lineEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
      const lines = value.slice(lineStart, lineEnd).split('\n');
      const changed = lines.map((line) =>
        e.shiftKey ? line.replace(new RegExp(`^ {1,${indent.length}}|^\\t`), '') : indent + line,
      );
      const removedFirst = lines[0].length - changed[0].length;
      el.setRangeText(changed.join('\n'), lineStart, lineEnd, 'preserve');
      const delta = changed.join('\n').length - lines.join('\n').length;
      el.setSelectionRange(
        Math.max(lineStart, start - removedFirst),
        Math.max(lineStart, end + delta),
      );
    }
    setDraft(el.value);
  };
  const tooLong = draft.length > htmlSourceLimit;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="modal html-editor" role="dialog" aria-modal="true" aria-label="Edit HTML">
        <header>
          <h2>Edit HTML</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={cancel}>
            <X size={18} />
          </button>
        </header>
        <div className="html-editor-panes">
          <textarea
            ref={textarea}
            className="html-editor-code"
            aria-label="HTML, CSS and JavaScript"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            wrap="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keyDown}
          />
          <SizedPreview html={preview} width={width} height={height} />
        </div>
        <div className="dialog-actions html-editor-actions">
          <span className="quiet small">
            {tooLong
              ? `Too long: ${draft.length.toLocaleString()} of ${htmlSourceLimit.toLocaleString()} characters`
              : 'Runs sandboxed, without access to your boards. Ctrl+S saves.'}
          </span>
          <button className="button" onClick={cancel}>
            Cancel
          </button>
          <button className="button primary" disabled={tooLong} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
