import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Frame, Search } from 'lucide-react';
import type { Document, Library } from '../model';
import { invoke } from '../bridge';
import { findFrameUsages, type FrameReference, type FrameUsage } from '../canvas/frame-usages';
import { Modal } from './Dialogs';

interface Props {
  source: FrameReference;
  name: string;
  prepare: () => Promise<void>;
  onClose: () => void;
  onOpen: (boardId: string, objectId: string) => void;
}

export default function FrameUsages({ source, name, prepare, onClose, onOpen }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const [results, setResults] = useState<FrameUsage[] | null>(null);
  const [title, setTitle] = useState(name);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResults(null);
    setFailure(null);
    void (async () => {
      try {
        await prepareRef.current();
        if (cancelled) return;
        const library = await invoke<Library>('library');
        const boards = library.boards.filter((b) => !b.trashed);
        const documents: Document[] = [];
        for (let offset = 0; offset < boards.length; offset += 4) {
          if (cancelled) return;
          documents.push(
            ...(await Promise.all(
              boards
                .slice(offset, offset + 4)
                .map((b) => invoke<Document>('loadBoard', { id: b.id })),
            )),
          );
        }
        if (cancelled) return;
        const original = documents
          .find((d) => d.board.id === source.boardId)
          ?.objects.find((o) => o.id === source.frameId && o.type === 'frame');
        setTitle(original?.text?.trim() || name || 'Untitled frame');
        setResults(findFrameUsages(source, documents));
      } catch (error) {
        if (!cancelled) setFailure(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source.boardId, source.frameId, name, retry]);

  const filter = query.trim().toLocaleLowerCase();
  const visible =
    results?.filter((r) =>
      `${r.boardName} ${r.processName} ${r.processPath.join(' ')}`
        .toLocaleLowerCase()
        .includes(filter),
    ) || [];
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const isInput = target.matches('.search-input input');
    if (!isInput && !target.matches('.content-search-result')) return;
    const buttons = [
      ...root.current!.querySelectorAll<HTMLButtonElement>('.content-search-result'),
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
    <Modal title={`Usages of ${title}`} onClose={onClose}>
      <div ref={root} className="library-search frame-usages" onKeyDown={navigate}>
        <div className="search-input">
          <Search size={18} />
          <input
            aria-label="Filter frame usages"
            placeholder="Filter by process or board…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
            autoFocus
          />
        </div>
        <div className="search-results" aria-busy={!results && !failure}>
          {results && (
            <h3 className="search-section-title">
              Linked occurrences{' '}
              <span>{filter ? `${visible.length} of ${results.length}` : results.length}</span>
            </h3>
          )}
          {visible.map((match) => (
            <button
              key={`${match.boardId}/${match.objectId}`}
              className="search-result content-search-result"
              data-board={match.boardId}
              data-object={match.objectId}
              onClick={() => {
                onClose();
                onOpen(match.boardId, match.objectId);
              }}
            >
              <span className="search-content-icon">
                <Frame size={19} />
              </span>
              <span className="search-result-copy">
                <span className="search-excerpt">{match.processName}</span>
                <small>
                  {match.boardName}
                  {match.processPath.length > 1
                    ? ` / ${match.processPath.slice(0, -1).join(' / ')}`
                    : ''}
                  {' · '}Occurrence {match.occurrence} of {match.total}
                </small>
              </span>
            </button>
          ))}
          {!results && !failure && (
            <p className="search-status" role="status">
              Finding usages across boards…
            </p>
          )}
          {failure && (
            <div className="search-status" role="alert">
              Couldn’t load all frame usages.{' '}
              <button className="text-button" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </button>
              <small>{failure}</small>
            </div>
          )}
          {results && !visible.length && (
            <p className="search-status">
              {results.length
                ? 'No usages match this filter.'
                : 'This frame has no linked occurrences yet.'}
            </p>
          )}
          {results && (
            <p className="search-status">
              Each row opens one linked instance.{' '}
              <button className="text-button" onClick={() => setRetry((n) => n + 1)}>
                Refresh
              </button>
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
