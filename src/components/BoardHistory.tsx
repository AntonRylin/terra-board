import { useEffect, useRef, useState } from 'react';
import { History, Pencil, Plus, RotateCcw, Trash2, Crosshair, Check } from 'lucide-react';
import type { CanvasObject, HistoryEntry, HistoryPage } from '../model';
import { invoke } from '../bridge';
import {
  editSummary,
  groupHistory,
  historyTime,
  objectExcerpt,
  restorable,
  sourceLabel,
  typeName,
} from '../canvas/board-history';
import { Modal } from './Dialogs';
import './board-history.css';

interface Props {
  boardId: string;
  boardName: string;
  readOnly: boolean;
  // Finishes text drafts and queued saves so the list includes them.
  prepare: () => Promise<void>;
  // Puts objects back on the open board; returns an error message or null.
  restore: (objects: CanvasObject[]) => string | null;
  show: (objectId: string) => boolean;
  onClose: () => void;
}
type Filter = 'all' | 'deleted';

const actionIcon = { create: Plus, edit: Pencil, delete: Trash2 };

export default function BoardHistory(p: Props) {
  const prepare = useRef(p.prepare);
  prepare.current = p.prepare;
  const [filter, setFilter] = useState<Filter>('all');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [keptDays, setKeptDays] = useState(30);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restored, setRestored] = useState<Set<number>>(new Set());
  const [reload, setReload] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const page = (before?: number) =>
    invoke<HistoryPage>('boardHistory', {
      id: p.boardId,
      deletedOnly: filter === 'deleted',
      limit: 100,
      ...(before ? { before } : {}),
    });
  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setFailure(null);
    void (async () => {
      try {
        await prepare.current();
        const result = await page();
        if (cancelled) return;
        setEntries(result.entries);
        setNext(result.next);
        setKeptDays(result.keptDays);
      } catch (error) {
        if (!cancelled) setFailure(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [p.boardId, filter, reload]);

  const more = async () => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await page(next);
      setEntries((current) => [...(current || []), ...result.entries]);
      setNext(result.next);
    } catch (error) {
      setFailure(String(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const restore = (items: HistoryEntry[]) => {
    const objects = items.map(restorable).filter((o): o is CanvasObject => !!o);
    if (!objects.length) return;
    const problem = p.restore(objects);
    if (problem) {
      setNotice(problem);
      return;
    }
    setRestored((current) => new Set([...current, ...items.map((item) => item.seq)]));
    setNotice(
      objects.length === 1
        ? `${typeName(objects[0])} restored. Ctrl+Z undoes it.`
        : `${objects.length} objects restored. Ctrl+Z undoes it.`,
    );
  };

  const groups = groupHistory(entries || []);
  return (
    <Modal title={`History of ${p.boardName || 'this board'}`} onClose={p.onClose} wide>
      <div className="board-history">
        <div className="board-history-filter" role="tablist" aria-label="Show">
          {(
            [
              ['all', 'All changes'],
              ['deleted', 'Deleted'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? 'active' : ''}
              onClick={() => {
                setFilter(value);
                setNotice(null);
              }}
            >
              {label}
            </button>
          ))}
          <button className="board-history-refresh" onClick={() => setReload((n) => n + 1)}>
            Refresh
          </button>
        </div>
        {notice && (
          <p className="board-history-notice" role="status">
            {notice}
          </p>
        )}
        <div className="board-history-list" aria-busy={!entries && !failure}>
          {groups.map((group) => {
            const deletions = group.entries.filter(
              (e) => e.action === 'delete' && !e.current && !restored.has(e.seq),
            );
            const source = sourceLabel[group.source];
            return (
              <section key={group.key} className="board-history-group">
                <h3>
                  <span>{historyTime(group.at)}</span>
                  {source && <span className="board-history-source">{source}</span>}
                  {!p.readOnly && deletions.length > 1 && (
                    <button className="board-history-action" onClick={() => restore(deletions)}>
                      <RotateCcw size={14} /> Restore all {deletions.length}
                    </button>
                  )}
                </h3>
                {group.entries.map((entry) => (
                  <Row
                    key={entry.seq}
                    entry={entry}
                    readOnly={p.readOnly}
                    restored={restored.has(entry.seq)}
                    onRestore={() => restore([entry])}
                    onShow={() => {
                      if (p.show(entry.objectId)) p.onClose();
                      else setNotice('That object is no longer on the board.');
                    }}
                  />
                ))}
              </section>
            );
          })}
          {!entries && !failure && (
            <p className="search-status" role="status">
              Loading history…
            </p>
          )}
          {failure && (
            <div className="search-status" role="alert">
              Couldn’t load the history.{' '}
              <button className="board-history-link" onClick={() => setReload((n) => n + 1)}>
                Retry
              </button>
              <small>{failure}</small>
            </div>
          )}
          {entries && !entries.length && (
            <p className="search-status">
              {filter === 'deleted'
                ? 'Nothing deleted from this board is waiting to be restored.'
                : 'No changes recorded yet. Changes are recorded from now on.'}
            </p>
          )}
          {next !== null && (
            <button className="button board-history-more" onClick={more} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Show older changes'}
            </button>
          )}
        </div>
        <p className="board-history-footnote">
          <History size={13} /> Every change to this board is kept for {keptDays} days. Restoring
          brings back the version from just before the change.
        </p>
      </div>
    </Modal>
  );
}

function Row({
  entry,
  readOnly,
  restored,
  onRestore,
  onShow,
}: {
  entry: HistoryEntry;
  readOnly: boolean;
  restored: boolean;
  onRestore: () => void;
  onShow: () => void;
}) {
  const object = entry.before || entry.after || entry.current;
  const Icon = actionIcon[entry.action];
  const verb =
    entry.action === 'create'
      ? 'Added'
      : entry.action === 'delete'
        ? 'Deleted'
        : editSummary(entry.before!, entry.after);
  const excerpt = object ? objectExcerpt(object) : '';
  const changedText =
    entry.action === 'edit' && entry.after && entry.before?.text !== entry.after.text
      ? objectExcerpt(entry.after)
      : null;
  const onBoard = !!entry.current || restored;
  const canRestore = !readOnly && !!restorable(entry) && !restored;
  return (
    <div className={'board-history-row action-' + entry.action}>
      <span className="board-history-icon">
        <Icon size={15} />
      </span>
      <div className="board-history-copy">
        <strong>
          {verb} · {object ? typeName(object) : 'Object'}
        </strong>
        {excerpt && (
          <span className="board-history-excerpt" title={object?.text}>
            {changedText !== null ? <s>{excerpt}</s> : excerpt}
          </span>
        )}
        {changedText !== null && changedText && (
          <span className="board-history-excerpt">{changedText}</span>
        )}
      </div>
      <div className="board-history-buttons">
        {onBoard && (
          <button className="board-history-action" onClick={onShow} aria-label="Show on board">
            <Crosshair size={14} />
          </button>
        )}
        {restored ? (
          <span className="board-history-done">
            <Check size={14} /> Restored
          </span>
        ) : (
          canRestore &&
          (entry.action === 'delete' ? !entry.current : true) && (
            <button className="board-history-action" onClick={onRestore}>
              <RotateCcw size={14} /> {entry.action === 'delete' ? 'Restore' : 'Revert'}
            </button>
          )
        )}
      </div>
    </div>
  );
}
