import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { openLink, type MiroBoard, type MiroProgress, type MiroResult } from '../bridge';
import './miro-import.css';

const APPS_PAGE = 'https://miro.com/app/settings/user-profile/apps';
const message = (e: unknown) =>
  String(e).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: )?/, '');
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function leftBehind(r: Extract<MiroResult, { board: object }>) {
  const s = r.skipped,
    parts = [
      s.drawings && plural(s.drawings, 'pen drawing'),
      s.arrows && plural(s.arrows, 'loose arrow'),
      s.images && plural(s.images, 'image') + ' that failed to download',
      s.other && plural(s.other, 'unsupported item'),
    ].filter(Boolean);
  return parts.length ? 'Not imported: ' + parts.join(', ') + '.' : '';
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
  const [links, setLinks] = useState('');
  // Boards named by pasted links: Miro's list leaves out boards outside the token's team.
  const linked = useMemo(
    () => [
      ...new Set(
        [...links.matchAll(/miro\.com\/app\/board\/([^/?#\s]+)/gi)].map((m) => {
          try {
            return decodeURIComponent(m[1]);
          } catch {
            return m[1];
          }
        }),
      ),
    ],
    [links],
  );
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

  const connect = () => {
    setBusy(true);
    setError('');
    miro
      .connect(token, remember && canRemember)
      .then((boards) => {
        setToken('');
        setStep({ kind: 'pick', boards });
      })
      .catch((e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  const start = () => {
    const ids = [...new Set([...chosen, ...linked])];
    setError('');
    setProgress(null);
    setStep({ kind: 'importing' });
    miro
      .import(ids)
      .then((results) => {
        setStep({ kind: 'done', results });
        onImported();
      })
      .catch((e) => {
        setError(message(e));
        setStep({ kind: 'token' });
      });
  };

  if (step.kind === 'loading') return <p className="quiet">Connecting to Miro…</p>;

  if (step.kind === 'token')
    return (
      <form
        className="miro-import"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim() && !busy) connect();
        }}
      >
        <p className="quiet">
          Terra copies your boards straight from your Miro account with a personal access token.
          Miro backup files (.rtb) are encrypted, so they can’t be opened directly.
        </p>
        <ol className="miro-steps">
          <li>
            Open{' '}
            <button type="button" className="miro-link" onClick={() => void openLink(APPS_PAGE)}>
              Miro → Settings → Your apps <ExternalLink size={12} />
            </button>
            .
          </li>
          <li>
            Click <b>Create new app</b>, then under <b>Permissions</b> tick <b>boards:read</b>.
          </li>
          <li>
            Click <b>Install app and get OAuth token</b> and pick the team that has your boards.
          </li>
          <li>Copy the access token and paste it here.</li>
        </ol>
        <label>
          Access token
          <input
            value={token}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="eyJtaXJvLm9yaWdpbiI6…"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {canRemember && (
          <label className="live-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember it on this computer (encrypted)
          </label>
        )}
        {error && <p className="live-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy ? 'Connecting…' : 'Show my boards'}
          </button>
        </div>
      </form>
    );

  if (step.kind === 'pick') {
    const allShown = shown.length > 0 && shown.every((b) => chosen.has(b.id)),
      count = new Set([...chosen, ...linked]).size;
    const linkField = (
      <label>
        Board links, one per line
        <textarea
          className="miro-links"
          rows={3}
          value={links}
          autoFocus={!step.boards.length}
          spellCheck={false}
          placeholder="https://miro.com/app/board/uXjV…/"
          onChange={(e) => setLinks(e.target.value)}
        />
      </label>
    );
    if (!step.boards.length)
      return (
        <div className="miro-import">
          <p className="quiet">
            Paste the links of the boards to copy. In Miro, open a board and copy the address from
            the browser, or use <b>Share → Copy board link</b>.
          </p>
          {linkField}
          <p className="quiet miro-note">
            Each board becomes a new Terra board with its frames, text, notes, shapes, code and
            full-size images. Pen drawings and arrows with loose ends stay in Miro.
          </p>
          {error && <p className="live-error">{error}</p>}
          <div className="dialog-actions">
            <button
              type="button"
              className="button miro-forget"
              onClick={() => void miro.forget().then(() => setStep({ kind: 'token' }))}
            >
              Use another token
            </button>
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={!count} onClick={start}>
              {count > 1 ? `Import ${count} boards` : 'Import board'}
            </button>
          </div>
        </div>
      );
    return (
      <div className="miro-import">
        {step.boards.length > 6 && (
          <input
            className="miro-filter"
            value={filter}
            placeholder="Find a board"
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        <div className="miro-boards" role="group" aria-label="Miro boards">
          {shown.length ? (
            <>
              <label className="live-check miro-all">
                <input
                  type="checkbox"
                  checked={allShown}
                  onChange={() => {
                    const next = new Set(chosen);
                    for (const b of shown) allShown ? next.delete(b.id) : next.add(b.id);
                    setChosen(next);
                  }}
                />
                Select all
              </label>
              {shown.map((b) => (
                <label key={b.id} className="live-check miro-board">
                  <input
                    type="checkbox"
                    checked={chosen.has(b.id)}
                    onChange={() => {
                      const next = new Set(chosen);
                      next.has(b.id) ? next.delete(b.id) : next.add(b.id);
                      setChosen(next);
                    }}
                  />
                  <span className="miro-board-name">{b.name}</span>
                  {b.modifiedAt && (
                    <span className="quiet">{new Date(b.modifiedAt).toLocaleDateString()}</span>
                  )}
                </label>
              ))}
            </>
          ) : (
            <p className="quiet">No board matches.</p>
          )}
        </div>
        <details className="miro-more">
          <summary>A board isn’t listed?</summary>
          {linkField}
        </details>
        <p className="quiet miro-note">
          Each board becomes a new Terra board with its frames, text, notes, shapes, code and
          full-size images. Pen drawings and arrows with loose ends stay in Miro.
        </p>
        {error && <p className="live-error">{error}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="button miro-forget"
            onClick={() =>
              void miro.forget().then(() => {
                setChosen(new Set());
                setStep({ kind: 'token' });
              })
            }
          >
            Use another token
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={!count} onClick={start}>
            {count > 1 ? `Import ${count} boards` : 'Import board'}
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === 'importing') {
    const p = progress,
      share =
        p && p.phase === 'images' && p.total ? (p.done || 0) / p.total : p?.phase === 'saving' ? 1 : 0;
    return (
      <div className="miro-import" aria-live="polite">
        <p>
          {p
            ? `${p.count > 1 ? `${p.index + 1} of ${p.count}: ` : ''}${p.board}`
            : 'Starting…'}
        </p>
        <div className="miro-bar">
          <span style={{ width: `${Math.round(((p?.index || 0) + share) / (p?.count || 1) * 100)}%` }} />
        </div>
        <p className="quiet">
          {!p || p.phase === 'reading'
            ? 'Reading the board…'
            : p.phase === 'images'
              ? `Downloading images ${p.done} of ${p.total}`
              : 'Placing everything on the board…'}
        </p>
      </div>
    );
  }

  return (
    <div className="miro-import">
      <ul className="miro-results">
        {step.results.map((r) => (
          <li key={r.id}>
            {r.board ? (
              <>
                <div className="miro-result-head">
                  <b>{r.board.name}</b>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      onOpen(r.board.id);
                      onClose();
                    }}
                  >
                    Open
                  </button>
                </div>
                <span className="quiet">{leftBehind(r) || 'Everything came across.'}</span>
              </>
            ) : (
              <span className="live-error">{r.error}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
