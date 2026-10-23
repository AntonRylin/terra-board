import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ExternalLink, Plus, Search } from 'lucide-react';
import { openLink, type MiroBoard, type MiroProgress, type MiroResult } from '../bridge';
import './miro-import.css';

const APPS_PAGE = 'https://miro.com/app/settings/user-profile/apps';
const message = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
};
function leftBehind(r: Extract<MiroResult, { board: object }>) {
  const s = r.skipped,
    parts = [
      s.drawings && plural(s.drawings, 'drawing'),
      s.arrows && plural(s.arrows, 'loose arrow'),
      s.images && plural(s.images, 'image'),
      s.other && plural(s.other, 'other item'),
    ].filter(Boolean);
  return parts.length ? parts.join(', ') + ' stayed in Miro' : 'Everything copied';
}

type Step =
  | { kind: 'loading' }
  | { kind: 'token' }
  | { kind: 'pick'; boards: MiroBoard[] }
  | { kind: 'importing' }
  | { kind: 'done'; results: MiroResult[] };

export default function MiroImportDialog({
  onClose,
  onImported,
  onOpen,
}: {
  onClose: () => void;
  onImported: () => void;
  onOpen: (boardId: string) => void;
}) {
  const miro = window.canvas?.miro;
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [canRemember, setCanRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState('');
  const [progress, setProgress] = useState<MiroProgress | null>(null);

  useEffect(() => {
    if (!miro) return;
    let live = true;
    miro
      .status()
      .then(async (s) => {
        setCanRemember(s.canRemember);
        if (!s.saved) return live && setStep({ kind: 'token' });
        try {
          const boards = await miro.boards();
          if (live) setStep({ kind: 'pick', boards });
        } catch (e) {
          if (!live) return;
          setError(message(e));
          setStep({ kind: 'token' });
        }
      })
      .catch(() => live && setStep({ kind: 'token' }));
    const off = miro.onProgress(setProgress);
    return () => {
      live = false;
      off();
    };
  }, [miro]);

  const shown = useMemo(() => {
    if (step.kind !== 'pick') return [];
    const q = filter.trim().toLowerCase();
    return q ? step.boards.filter((b) => b.name.toLowerCase().includes(q)) : step.boards;
  }, [step, filter]);

  if (!miro) return <p className="quiet">Importing from Miro works in the desktop app.</p>;

  const fail = (e: unknown) => setError(message(e));
  const connect = () => {
    setBusy(true);
    setError('');
    miro
      .connect(token, remember && canRemember)
      .then((boards) => {
        setToken('');
        setStep({ kind: 'pick', boards });
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const addLink = () => {
    setBusy(true);
    setError('');
    miro
      .add(link)
      .then(({ id, boards }) => {
        setLink('');
        setAdding(false);
        setChosen((c) => new Set(c).add(id));
        setStep({ kind: 'pick', boards });
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const start = () => {
    setError('');
    setProgress(null);
    setStep({ kind: 'importing' });
    miro
      .import([...chosen])
      .then((results) => {
        setStep({ kind: 'done', results });
        onImported();
      })
      .catch((e) => {
        fail(e);
        setStep({ kind: 'token' });
      });
  };
  const toggle = (id: string) =>
    setChosen((c) => {
      const next = new Set(c);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const errorLine = error && <p className="miro-error">{error}</p>;

  if (step.kind === 'loading')
    return (
      <div className="miro-import miro-center">
        <span className="miro-spinner" />
      </div>
    );

  if (step.kind === 'token')
    return (
      <form
        className="miro-import"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim() && !busy) connect();
        }}
      >
        <p className="miro-lead">Paste your Miro access token.</p>
        <div className="miro-group">
          <input
            className="miro-field"
            type="password"
            value={token}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="Access token"
            aria-label="Access token"
            onChange={(e) => setToken(e.target.value)}
          />
          {canRemember && (
            <label className="miro-switch">
              <span>Remember on this computer</span>
              <input
                type="checkbox"
                role="switch"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
            </label>
          )}
        </div>
        <details className="miro-help">
          <summary>How do I get a token?</summary>
          <ol>
            <li>
              <button type="button" className="miro-text-button" onClick={() => void openLink(APPS_PAGE)}>
                Open Miro’s app settings <ExternalLink size={12} />
              </button>{' '}
              and create an app with <b>boards:read</b>.
            </li>
            <li>
              Choose <b>Install app and get OAuth token</b>.
            </li>
            <li>Copy the token.</li>
          </ol>
        </details>
        {errorLine}
        <button className="miro-primary" disabled={busy || !token.trim()}>
          {busy ? 'Connecting…' : 'Continue'}
        </button>
      </form>
    );

  if (step.kind === 'pick') {
    const teams = new Set(step.boards.map((b) => b.team || '')).size > 1;
    const allShown = shown.length > 0 && shown.every((b) => chosen.has(b.id));
    const linkForm = (
      <form
        className="miro-add-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim() && !busy) addLink();
        }}
      >
        <input
          className="miro-field"
          value={link}
          autoFocus
          spellCheck={false}
          placeholder="Paste a Miro board link"
          aria-label="Miro board link"
          onChange={(e) => setLink(e.target.value)}
        />
        <button className="miro-secondary" disabled={busy || !link.trim()}>
          {busy ? 'Finding…' : 'Add'}
        </button>
      </form>
    );
    const rows: ReactNode[] = [];
    let team: string | undefined;
    for (const b of shown) {
      if (teams && b.team !== team) {
        team = b.team;
        rows.push(
          <div key={'team-' + team} className="miro-section">
            {team}
          </div>,
        );
      }
      const on = chosen.has(b.id);
      rows.push(
        <button
          key={b.id}
          type="button"
          role="checkbox"
          aria-checked={on}
          className="miro-row"
          onClick={() => toggle(b.id)}
        >
          <span className={'miro-check' + (on ? ' on' : '')}>{on && <Check size={12} strokeWidth={3} />}</span>
          <span className="miro-name">{b.name}</span>
          <span className="miro-date">{shortDate(b.modifiedAt)}</span>
        </button>,
      );
    }
    return (
      <div className="miro-import">
        {step.boards.length ? (
          <>
            <div className="miro-search">
              <Search size={14} />
              <input
                value={filter}
                placeholder="Search"
                aria-label="Search boards"
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="miro-list">{rows.length ? rows : <p className="miro-empty">No matches</p>}</div>
            {adding ? (
              linkForm
            ) : (
              <button type="button" className="miro-text-button miro-more" onClick={() => setAdding(true)}>
                <Plus size={13} /> Boards from another team
              </button>
            )}
          </>
        ) : (
          <>
            <p className="miro-lead">Add any board from your Miro team.</p>
            <p className="miro-hint">Terra lists the rest of its team for you.</p>
            {linkForm}
          </>
        )}
        {errorLine}
        <footer className="miro-footer">
          <button
            type="button"
            className="miro-text-button miro-muted"
            onClick={() =>
              void miro.forget().then(() => {
                setChosen(new Set());
                setStep({ kind: 'token' });
              })
            }
          >
            Disconnect
          </button>
          <span className="miro-spacer" />
          {shown.length > 1 && (
            <button
              type="button"
              className="miro-text-button"
              onClick={() =>
                setChosen((c) => {
                  const next = new Set(c);
                  for (const b of shown) allShown ? next.delete(b.id) : next.add(b.id);
                  return next;
                })
              }
            >
              {allShown ? 'Deselect all' : 'Select all'}
            </button>
          )}
          <button className="miro-primary" disabled={!chosen.size} onClick={start}>
            {chosen.size > 1 ? `Import ${chosen.size}` : 'Import'}
          </button>
        </footer>
      </div>
    );
  }

  if (step.kind === 'importing') {
    const p = progress,
      share =
        p?.phase === 'images' && p.total ? (p.done || 0) / p.total : p?.phase === 'saving' ? 1 : 0;
    const overall = ((p?.index || 0) + share) / (p?.count || 1);
    return (
      <div className="miro-import miro-center" aria-live="polite">
        <p className="miro-lead">{p?.board || 'Connecting…'}</p>
        <div className="miro-bar">
          <span style={{ width: `${Math.max(3, Math.round(overall * 100))}%` }} />
        </div>
        <p className="miro-hint">
          {p && p.count > 1 ? `Board ${p.index + 1} of ${p.count} · ` : ''}
          {!p || p.phase === 'reading'
            ? 'Reading'
            : p.phase === 'images'
              ? `Images ${p.done} of ${p.total}`
              : 'Placing'}
        </p>
      </div>
    );
  }

  return (
    <div className="miro-import">
      <div className="miro-list">
        {step.results.map((r) =>
          r.board ? (
            <div key={r.id} className="miro-row miro-result">
              <span className="miro-check on">
                <Check size={12} strokeWidth={3} />
              </span>
              <span className="miro-result-text">
                <span className="miro-name">{r.board.name}</span>
                <span className="miro-hint">{leftBehind(r)}</span>
              </span>
              <button
                type="button"
                className="miro-secondary"
                onClick={() => {
                  onOpen(r.board.id);
                  onClose();
                }}
              >
                Open
              </button>
            </div>
          ) : (
            <div key={r.id} className="miro-row miro-result">
              <span className="miro-check failed">!</span>
              <span className="miro-result-text">
                <span className="miro-name">Couldn’t import</span>
                <span className="miro-hint">{r.error}</span>
              </span>
            </div>
          ),
        )}
      </div>
      <footer className="miro-footer">
        <span className="miro-spacer" />
        <button className="miro-primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </div>
  );
}
