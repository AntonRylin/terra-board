import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { emojiGroups } from './emoji-catalog';

const rowHeight = 48;
const headingHeight = 40;
export default function EmojiGallery({
  renderEmoji,
}: {
  renderEmoji: (emoji: string) => ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [viewport, setViewport] = useState({ width: 600, height: 500, top: 0 });
  useLayoutEffect(() => {
    const element = host.current!;
    const measure = () =>
      setViewport({
        width: element.clientWidth,
        height: element.clientHeight,
        top: element.scrollTop,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.floor((viewport.width - 40 + 4) / rowHeight));
  const layout = useMemo(() => {
    const rows: { top: number; name?: string; emojis?: string[] }[] = [];
    const entries: { emoji: string; top: number }[] = [];
    let top = 0;
    for (const group of emojiGroups) {
      rows.push({ top, name: group.name });
      top += headingHeight;
      for (let i = 0; i < group.emojis.length; i += columns) {
        const emojis = group.emojis.slice(i, i + columns);
        rows.push({ top, emojis });
        entries.push(...emojis.map((emoji) => ({ emoji, top })));
        top += rowHeight;
      }
    }
    return { rows, entries, height: top + 16 };
  }, [columns]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const button = [...host.current!.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === pendingFocus.current,
    );
    if (button) {
      button.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });
  return (
    <div
      ref={host}
      className="emoji-gallery"
      data-emoji-count={layout.entries.length}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setViewport((current) => ({ ...current, top }));
      }}
      onKeyDown={(event) => {
        const button = (event.target as HTMLElement).closest('button');
        if (!button) return;
        const index = layout.entries.findIndex((entry) => entry.emoji === button.textContent);
        const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[
          event.key
        ];
        if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? layout.entries.length - 1
              : Math.max(0, Math.min(layout.entries.length - 1, index + delta!));
        const entry = layout.entries[next];
        pendingFocus.current = entry.emoji;
        const element = host.current!;
        if (entry.top < element.scrollTop) element.scrollTop = entry.top;
        else if (entry.top + rowHeight > element.scrollTop + element.clientHeight)
          element.scrollTop = entry.top + rowHeight - element.clientHeight;
        setViewport((current) => ({ ...current, top: element.scrollTop }));
      }}
    >
      <div className="emoji-gallery-content" style={{ height: layout.height }}>
        {layout.rows
          .filter(
            (row) =>
              row.top + rowHeight >= viewport.top - rowHeight &&
              row.top <= viewport.top + viewport.height + rowHeight,
          )
          .map((row) => (
            <div key={row.top} className="emoji-virtual-row" style={{ top: row.top }}>
              {row.name ? (
                <h3>{row.name}</h3>
              ) : (
                <div
                  className="emoji-more-grid"
                  style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
                >
                  {row.emojis!.map(renderEmoji)}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
