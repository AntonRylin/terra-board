import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Radio } from 'lucide-react';
import Whiteboard, { type WhiteboardHandle } from './components/Whiteboard';
import { useAppearance } from './components/useAppearance';
import { invoke } from './bridge';
import { finishStartup } from './startup';
import type { Document } from './model';
import './components/live-share.css';

// A browser visiting a board that someone shares live from their computer.
type Me = { id: string; name: string; permission: 'view' | 'edit'; boardId: string };
type Stage =
  | { kind: 'checking' }
  | { kind: 'name' }
  | { kind: 'waiting' }
  | { kind: 'in'; me: Me }
  | { kind: 'closed'; title: string; text: string };

const nameKey = 'terra-board.guest-name';
const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
};

export default function GuestApp() {
  const appearance = useAppearance();
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(nameKey) || '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState('');
  const key = new URLSearchParams(location.search).get('k');

  const enter = useCallback(async () => {
    const me = await getJson('/__guest/me');
    if (me.ok) setStage({ kind: 'in', me: me.data });
    else if (key) setStage({ kind: 'name' });
    else
      setStage({
        kind: 'closed',
        title: 'Ask for a link',
        text: 'Open the link the host copied from Terra Board.',
      });
  }, [key]);
  useEffect(() => {
    void enter().catch(() =>
      setStage({
        kind: 'closed',
        title: 'Not sharing',
        text: 'The host is not sharing a board right now.',
      }),
    );
  }, [enter]);
  useEffect(() => {
    if (stage.kind !== 'in' && stage.kind !== 'checking') finishStartup();
  }, [stage.kind]);

  const join = async () => {
    setError('');
    const clean = name.trim();
    if (!clean) return setError('Enter your name');
    try {
      localStorage.setItem(nameKey, clean);
    } catch {}
    const asked = await getJson('/__guest/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, name: clean }),
    });
    if (!asked.ok) return setError(asked.data.error || 'Could not reach the host.');
    setStage({ kind: 'waiting' });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1200));
      const answer = await getJson('/__guest/join/' + asked.data.id).catch(() => null);
      const status = answer?.data.status;
      if (status === 'approved') return enter();
      if (status === 'denied' || status === 'expired' || !answer)
        return setStage({
          kind: 'closed',
          title: 'Not let in',
          text: 'The host did not let you join this time.',
        });
    }
  };

  if (stage.kind === 'in')
    return <GuestBoard me={stage.me} theme={appearance.theme} onClosed={setStage} />;
  return (
    <div className="guest-screen">
      <div className="guest-card">
        {stage.kind === 'checking' && <LoaderCircle size={22} />}
        {stage.kind === 'name' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            <h1>Join a live board</h1>
            <p>The host sees your name and lets you in.</p>
            <input
              aria-label="Your name"
              placeholder="Your name"
              value={name}
              maxLength={40}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
            {error && <p className="live-error">{error}</p>}
            <button className="button primary">Ask to join</button>
          </form>
        )}
        {stage.kind === 'waiting' && (
          <>
            <h1>Waiting for the host</h1>
            <p>They will see that {name.trim()} wants to join.</p>
            <LoaderCircle size={20} />
          </>
        )}
        {stage.kind === 'closed' && (
          <>
            <h1>{stage.title}</h1>
            <p>{stage.text}</p>
          </>
        )}
      </div>
    </div>
  );
}

function GuestBoard({
  me,
  theme,
  onClosed,
}: {
  me: Me;
  theme: ReturnType<typeof useAppearance>['theme'];
  onClosed: (stage: Stage) => void;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [permission, setPermission] = useState(me.permission);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const whiteboard = useRef<WhiteboardHandle>(null);
  const refreshing = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    void invoke<Document>('loadBoard', { id: me.boardId })
      .then(setDoc)
      .catch((e) => setError(String(e)));
  }, [me.boardId]);

  useEffect(() => {
    const events = new EventSource('/__local/events');
    // Refreshes run one at a time; unsaved typing is flushed before reloading.
    const refresh = () => {
      refreshing.current = refreshing.current.then(async () => {
        const board = whiteboard.current;
        if (!board) return;
        await board.prepareExternal();
        try {
          const updated = await invoke<Document>('loadBoard', { id: me.boardId });
          board.finishExternal(updated);
          setDoc((d) => (d ? { ...updated, board: updated.board } : updated));
        } catch {
          board.finishExternal();
        }
      });
    };
    events.addEventListener('open', () => setOffline(false));
    events.addEventListener('error', () => setOffline(true));
    events.addEventListener('changed', refresh);
    events.addEventListener('permission', (e) =>
      setPermission(JSON.parse((e as MessageEvent).data).permission),
    );
    events.addEventListener('removed', () => {
      events.close();
      onClosed({ kind: 'closed', title: 'Removed', text: 'The host removed you from this board.' });
    });
    events.addEventListener('ended', () => {
      events.close();
      onClosed({ kind: 'closed', title: 'Sharing ended', text: 'The host stopped sharing.' });
    });
    return () => events.close();
  }, [me.boardId, onClosed]);

  if (!doc)
    return (
      <div className="guest-screen">
        <div className="guest-card">
          {error ? <p className="live-error">{error}</p> : <LoaderCircle size={22} />}
        </div>
      </div>
    );
  return (
    <div className="app-shell" data-panel-hidden>
      <main className="workspace" style={{ inset: 0 }}>
        <Whiteboard
          ref={whiteboard}
          key={doc.board.id}
          document={doc}
          theme={theme}
          readOnly={permission !== 'edit'}
          searchTarget={null}
          onOpenFrame={() => {}}
          onReady={finishStartup}
          onError={(message) => setError(message)}
          onSave={(_state, message) => message && setError(message)}
        />
      </main>
      <div className="guest-bar glass-surface">
        <Radio size={14} />
        <strong>{doc.board.name}</strong>
        <span className="guest-tag">{permission === 'edit' ? 'Can edit' : 'View only'}</span>
        {offline && <span className="guest-offline">Reconnecting…</span>}
      </div>
      {error && (
        <div className="error-banner" role="alert" onClick={() => setError('')}>
          {error.replace(/^Error: /, '')}
        </div>
      )}
    </div>
  );
}
