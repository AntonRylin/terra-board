import { useCallback, useEffect, useRef, useState } from 'react';
import { Square, X } from 'lucide-react';
import { mediaUrl } from '../bridge';

export type SongPlayback = {
  // Settles once the song has stopped, however that happened.
  done: Promise<void>;
  // A short fade, then silence.
  stop: () => void;
  // End the song this many milliseconds from now, fading over the last moments.
  endIn: (ms: number) => void;
};

// Plays a song for at most `seconds`, fading out at the end.
export function playSong(assetId: string, seconds = 12): SongPlayback {
  let audio: HTMLAudioElement | null = null;
  let url = '';
  let finished = false;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let step: ReturnType<typeof setInterval> | undefined;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fadeTimer);
    clearInterval(step);
    audio?.pause();
    if (url) URL.revokeObjectURL(url);
    resolve();
  };
  const fadeOut = (ms: number) => {
    clearTimeout(fadeTimer);
    clearInterval(step);
    if (!audio || audio.paused) return finish();
    const from = audio.volume;
    const steps = Math.max(1, Math.round(ms / 50));
    let i = 0;
    step = setInterval(() => {
      i += 1;
      audio!.volume = Math.max(0, from * (1 - i / steps));
      if (i >= steps) finish();
    }, 50);
  };
  const endIn = (ms: number) => {
    if (finished) return;
    clearTimeout(fadeTimer);
    const fade = Math.min(900, ms);
    fadeTimer = setTimeout(() => fadeOut(fade), Math.max(0, ms - fade));
  };
  void (async () => {
    try {
      const response = await fetch(mediaUrl(assetId, 'original'));
      const bytes = await response.arrayBuffer();
      if (finished) return;
      url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      audio = new Audio(url);
      audio.volume = 0.6;
      audio.onended = finish;
      await audio.play();
      endIn(seconds * 1000);
    } catch {
      finish();
    }
  })();
  return { done, stop: () => fadeOut(200), endIn };
}

export type JoinToast = {
  id: number;
  person: string;
  name: string;
  color: string;
  initials: string;
  avatarKey: string;
  // A picture already on this computer, such as this person's own.
  avatarAsset?: string | null;
  role: 'view' | 'edit';
  songName: string;
  // `loading`: fetching their song; `queued`: waiting for another song to end.
  state: 'joined' | 'loading' | 'queued' | 'playing' | 'played' | 'stopped';
  start?: number;
  end?: number;
};

type Person = {
  person: string;
  name: string;
  role: 'view' | 'edit';
  avatar: number;
  songName?: string;
  avatarAsset?: string | null;
  color: string;
  initials: string;
};

// A song plays for 7 seconds, or 4 while others wait their turn; songs that
// would wait longer than this many seconds are skipped.
const SONG_SECONDS = 7;
const SHORT_SECONDS = 4;
const MAX_WAIT = 30000;
const MAX_WAITING = 3;
const MAX_CARDS = 5;
const GAP = 400;

// "Name joined" cards for people who open the same board, with their entrance
// songs played one after another.
export function useJoinToasts() {
  const [toasts, setToasts] = useState<JoinToast[]>([]);
  const nextId = useRef(1);
  const queue = useRef<{ id: number; asset: string; at: number }[]>([]);
  const current = useRef<{ id: number; playback: SongPlayback; end: number } | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Cards on screen, kept in step with every change rather than with renders.
  const shown = useRef(new Map<number, string>());

  const patch = (id: number, change: Partial<JoinToast>) =>
    setToasts((all) => all.map((t) => (t.id === id ? { ...t, ...change } : t)));
  const remove = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    shown.current.delete(id);
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const removeLater = (id: number, ms: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(
      id,
      setTimeout(() => remove(id), ms),
    );
  };

  const pump = useCallback(() => {
    if (current.current) return;
    let next = queue.current.shift();
    // Someone who joined a while ago gets their card, not a late song.
    while (next && Date.now() - next.at > MAX_WAIT) {
      patch(next.id, { state: 'joined' });
      removeLater(next.id, 4000);
      next = queue.current.shift();
    }
    if (!next) return;
    const { id } = next;
    const seconds = queue.current.length ? SHORT_SECONDS : SONG_SECONDS;
    const start = Date.now();
    const end = start + seconds * 1000;
    const playback = playSong(next.asset, seconds);
    current.current = { id, playback, end };
    patch(id, { state: 'playing', start, end });
    void playback.done.then(() => {
      current.current = null;
      setToasts((all) =>
        all.map((t) => (t.id === id && t.state === 'playing' ? { ...t, state: 'played' } : t)),
      );
      removeLater(id, 2500);
      setTimeout(pump, GAP);
    });
  }, []);

  // Someone else is waiting: the song playing now wraps up soon.
  const hurry = () => {
    const playing = current.current;
    if (!playing) return;
    const left = playing.end - Date.now();
    if (left <= 2500) return;
    playing.end = Date.now() + 2500;
    playing.playback.endIn(2500);
    patch(playing.id, { end: playing.end });
  };

  const announce = useCallback(
    (p: Person, song: Promise<string | null> | null) => {
      const id = nextId.current++;
      const toast: JoinToast = {
        id,
        person: p.person,
        name: p.name,
        color: p.color,
        initials: p.initials,
        avatarKey: p.person + ':' + p.avatar,
        avatarAsset: p.avatarAsset,
        role: p.role,
        songName: p.songName || '',
        state: song ? 'loading' : 'joined',
      };
      shown.current.set(id, p.person);
      setToasts((all) => {
        const list = [...all, toast];
        // Too many cards: the oldest finished ones make room.
        while (list.length > MAX_CARDS) {
          const old = list.findIndex((t) => !['loading', 'queued', 'playing'].includes(t.state));
          if (old < 0) break;
          clearTimeout(timers.current.get(list[old].id));
          shown.current.delete(list[old].id);
          list.splice(old, 1);
        }
        return list;
      });
      if (!song) return removeLater(id, 5000);
      void song
        .catch(() => null)
        .then((asset) => {
          if (!shown.current.has(id)) return;
          if (!asset || queue.current.length >= MAX_WAITING) {
            patch(id, { state: 'joined' });
            return removeLater(id, 5000);
          }
          queue.current.push({ id, asset, at: Date.now() });
          patch(id, { state: 'queued' });
          hurry();
          pump();
        });
    },
    [pump],
  );

  const stopSong = useCallback((id: number) => {
    if (current.current?.id === id) {
      patch(id, { state: 'stopped' });
      current.current.playback.stop();
    } else {
      queue.current = queue.current.filter((q) => q.id !== id);
      patch(id, { state: 'stopped' });
      removeLater(id, 2000);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      queue.current = queue.current.filter((q) => q.id !== id);
      if (current.current?.id === id) current.current.playback.stop();
      remove(id);
    },
    [remove],
  );

  // People who leave before their song plays take it with them.
  const latest = useRef(toasts);
  latest.current = toasts;
  const left = useCallback((present: Set<string>) => {
    for (const [id, person] of shown.current) {
      if (present.has(person)) continue;
      const waiting = queue.current.some((q) => q.id === id);
      const loading = latest.current.find((t) => t.id === id)?.state === 'loading';
      if (!waiting && !loading) continue;
      queue.current = queue.current.filter((q) => q.id !== id);
      remove(id);
    }
  }, []);

  useEffect(
    () => () => {
      queue.current = [];
      current.current?.playback.stop();
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  return { toasts, announce, stopSong, dismiss, left };
}

export function JoinToasts({
  toasts,
  avatars,
  onStop,
  onDismiss,
}: {
  toasts: JoinToast[];
  avatars: Record<string, string | null>;
  onStop: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const playing = toasts.some((t) => t.state === 'playing');
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, [playing]);
  if (!toasts.length) return null;
  return (
    <div className="join-toasts" role="log" aria-label="People joining" aria-live="polite">
      {toasts.map((t) => {
        const avatar = t.avatarAsset ?? avatars[t.avatarKey];
        const song = t.songName ? `“${t.songName}”` : 'their entrance song';
        const progress =
          t.state === 'playing' && t.start && t.end
            ? Math.min(1, (Date.now() - t.start) / (t.end - t.start))
            : t.state === 'played'
              ? 1
              : 0;
        return (
          <div className="join-toast glass-surface" key={t.id} data-state={t.state}>
            <div className="join-toast-row">
              <span
                className="join-toast-avatar"
                style={{
                  background: t.color,
                  boxShadow: `0 0 0 2px var(--paper), 0 0 0 3.5px ${t.color}`,
                }}
              >
                {avatar ? <img src={mediaUrl(avatar, 'thumb')} alt="" /> : t.initials}
              </span>
              <span className="join-toast-text">
                <span className="join-toast-name">{t.name} joined</span>
                <span className="join-toast-line">
                  {t.state === 'playing' && (
                    <span className="join-toast-bars" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {t.state === 'playing'
                    ? `Playing ${song}`
                    : t.state === 'queued'
                      ? `Up next: ${song}`
                      : t.state === 'played'
                        ? `Played ${song}`
                        : t.state === 'stopped'
                          ? 'Song stopped'
                          : t.role === 'view'
                            ? 'Can view'
                            : 'Can edit'}
                </span>
              </span>
              {(t.state === 'playing' || t.state === 'queued') && (
                <button
                  type="button"
                  className="join-toast-button"
                  aria-label={t.state === 'playing' ? 'Stop song' : 'Skip song'}
                  title={t.state === 'playing' ? 'Stop song' : 'Skip song'}
                  onClick={() => onStop(t.id)}
                >
                  <Square size={11} fill="currentColor" strokeWidth={0} />
                </button>
              )}
              <button
                type="button"
                className="join-toast-button"
                aria-label="Close"
                title="Close"
                onClick={() => onDismiss(t.id)}
              >
                <X size={15} />
              </button>
            </div>
            {(t.state === 'playing' || t.state === 'played') && (
              <div className="join-toast-progress">
                <span style={{ transform: `scaleX(${progress})` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
