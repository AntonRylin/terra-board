import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Search,
  FileText,
  StickyNote,
  Frame,
  Image,
  Link2,
  Video,
  Shapes,
  ListTodo,
} from 'lucide-react';
import type { ContentSearchResponse, Library, ObjectType } from '../model';
import { invoke } from '../bridge';
import { AppIcon } from './Launcher';
import InlineName from './InlineName';

interface Props {
  library: Library;
  query: string;
  onQuery: (value: string) => void;
  prepare: () => Promise<void>;
  onOpen: (boardId: string, objectId?: string) => void;
  onRenameBoard: (id: string, name: string) => Promise<void>;
  onRenameFolder: (id: string, name: string) => Promise<void>;
}
const kinds: Record<ObjectType, { label: string; icon: typeof Search }> = {
  list: { label: 'List', icon: ListTodo },
  text: { label: 'Text', icon: FileText },
  note: { label: 'Note', icon: StickyNote },
  frame: { label: 'Frame', icon: Frame },
  image: { label: 'Image', icon: Image },
  video: { label: 'Video', icon: Video },
  link: { label: 'Link', icon: Link2 },
  rect: { label: 'Shape', icon: Shapes },
  ellipse: { label: 'Shape', icon: Shapes },
  arrow: { label: 'Arrow', icon: Shapes },
};
function Excerpt({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  return index < 0 ? (
    text
  ) : (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}
export default function LibrarySearch(p: Props) {
  const root = useRef<HTMLDivElement>(null);
  const query = p.query.replace(/\s+/g, ' ').trim();
  const [content, setContent] = useState<(ContentSearchResponse & { query: string }) | null>(null);
  const [failure, setFailure] = useState<{ query: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // Finish the current text draft and queued saves before querying local storage.
        await p.prepare();
        if (cancelled) return;
        const result = await invoke<ContentSearchResponse>('searchContent', { query });
        if (!cancelled) {
          setContent({ ...result, query });
          setFailure(null);
        }
      } catch (error) {
        if (!cancelled) setFailure({ query, message: String(error) });
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, p.prepare, retry]);
  const boards = p.library.boards.filter(
    (b) => !b.trashed && b.name.toLowerCase().includes(query.toLowerCase()),
  );
  const matches = content?.query === query ? content.results : [];
  const error = failure?.query === query ? failure.message : null;
  const loading = !!query && content?.query !== query && !error;
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isInput = target.matches('.search-input input');
    if (!isInput && !target.matches('.search-result-open,.content-search-result')) return;
    const buttons = [
      ...root.current!.querySelectorAll<HTMLButtonElement>(
        '.search-result-open,.content-search-result',
      ),
    ];
    if (isInput && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      buttons[0]?.click();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = isInput ? -1 : buttons.indexOf(target as HTMLButtonElement);
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) root.current?.querySelector<HTMLInputElement>('input')?.focus();
      else buttons[Math.min(next, buttons.length - 1)]?.focus();
    }
  };
  return (
    <div ref={root} className="library-search" onKeyDown={navigate}>
      <div className="search-input">
        <Search size={18} />
        <input
          aria-label="Search boards and content"
          placeholder="Find boards, text, notes, links…"
          value={p.query}
          maxLength={200}
          onChange={(event) => p.onQuery(event.target.value)}
          autoFocus
        />
      </div>
      <div className="search-results">
        {!!boards.length && (
          <h3 className="search-section-title">
            Boards <span>{boards.length}</span>
          </h3>
        )}
        {boards.map((b) => {
          const folder = p.library.folders.find((f) => f.id === b.folderId);
          return (
            <div
              key={b.id}
              className="search-result"
              data-item={b.id}
              onClick={() => p.onOpen(b.id)}
            >
              <button className="search-result-open" aria-label={'Open board ' + b.name}>
                <AppIcon board={b} />
              </button>
              <span className="search-result-copy">
                <InlineName
                  value={b.name}
                  label={'Board name in search: ' + b.name}
                  onCommit={(name) => p.onRenameBoard(b.id, name)}
                />
                <small>
                  {folder ? (
                    <InlineName
                      value={folder.name}
                      label="Folder name in search"
                      onCommit={(name) => p.onRenameFolder(folder.id, name)}
                    />
                  ) : (
                    'Icon strip'
                  )}
                </small>
              </span>
            </div>
          );
        })}
        {!!query && (
          <h3 className="search-section-title">
            Inside boards
            {!loading && !error && (
              <span>
                {matches.length}
                {content?.hasMore ? '+' : ''}
              </span>
            )}
          </h3>
        )}
        {matches.map((match) => {
          const board = p.library.boards.find((b) => b.id === match.boardId && !b.trashed);
          if (!board) return null;
          const folder = p.library.folders.find((f) => f.id === board.folderId);
          const kind = kinds[match.type];
          const Icon = kind.icon;
          return (
            <button
              key={`${match.boardId}/${match.objectId}`}
              className="search-result content-search-result"
              data-board={match.boardId}
              data-object={match.objectId}
              onClick={() => p.onOpen(match.boardId, match.objectId)}
            >
              <span className="search-content-icon">
                <Icon size={19} />
              </span>
              <span className="search-result-copy">
                <span className="search-excerpt">
                  <Excerpt text={match.excerpt} query={query} />
                </span>
                <small>
                  {board.name}
                  {folder ? ` / ${folder.name}` : ''} · {kind.label}
                </small>
              </span>
            </button>
          );
        })}
        {loading && (
          <p className="search-status" role="status">
            Searching inside boards…
          </p>
        )}
        {error && (
          <div className="search-status" role="alert">
            Couldn’t search board content.{' '}
            <button
              className="text-button"
              onClick={() => {
                setFailure(null);
                setRetry((n) => n + 1);
              }}
            >
              Retry
            </button>
            <small>{error}</small>
          </div>
        )}
        {!!query && !loading && !error && !matches.length && (
          <p className="search-status">
            {boards.length
              ? 'No matching content inside boards.'
              : 'No matching boards or content.'}
          </p>
        )}
        {!!query && content?.query === query && content.hasMore && (
          <p className="search-status">
            Showing the first 60 content matches. Add more detail to narrow your search.
          </p>
        )}
        {!query && (
          <p className="search-status">Search board names and content across your library.</p>
        )}
      </div>
    </div>
  );
}
