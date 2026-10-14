import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Crosshair, Eye, LocateFixed, X } from 'lucide-react';
import type { Engine } from '../canvas/engine';
import type { Camera } from '../model';
import type { PresencePerson, ViewRect } from '../bridge';
import { mediaUrl } from '../bridge';
import { getPreferences } from '../settings/preferences';
import { useCloudStatus } from './ShareDialog';
import './collab.css';

type Cursor = { x: number; y: number; view: ViewRect; at: number };
type Person = PresencePerson & { keys: string[] };

// One colour per person, stable across sessions and computers.
const colorOf = (person: string) => {
  let hash = 0;
  for (const c of person) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 52%)`;
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const songCooldown = new Map<string, number>();
export async function playSong(assetId: string) {
  const response = await fetch(mediaUrl(assetId, 'original'));
  const bytes = await response.arrayBuffer();
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  const audio = new Audio(url);
  audio.volume = 0.6;
  // An entrance is short: play at most 12 seconds and fade out over the last one.
  const stop = () => {
    audio.pause();
    URL.revokeObjectURL(url);
  };
  const fade = setTimeout(() => {
    const step = setInterval(() => {
      audio.volume = Math.max(0, audio.volume - 0.06);
      if (audio.volume <= 0.01) {
        clearInterval(step);
        stop();
      }
    }, 100);
  }, 11000);
  audio.onended = () => {
    clearTimeout(fade);
    stop();
  };
  await audio.play().catch(stop);
}

// People on the same cloud board: their pictures, cursors and where they look.
export default function CollabLayer({
  engine,
  host,
  camera,
  boardId,
}: {
  engine: RefObject<Engine | null>;
  host: RefObject<HTMLDivElement | null>;
  camera: Camera;
  boardId: string;
}) {
  const cloud = window.canvas?.cloud;
  const status = useCloudStatus();
  const [people, setPeople] = useState<Person[]>([]);
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const followRef = useRef<string | null>(null);
  followRef.current = following;
  const known = useRef<Set<string> | null>(null);
  const me = status?.workspace;
  const shareSignature = JSON.stringify([
    status?.identity,
    status?.library,
    status?.shared.map((s) => s.shareId),
    status?.sharedWithMe.map((s) => s.shareId),
  ]);

  // Join this board's presence while it is open; rejoin when sharing changes.
  useEffect(() => {
    if (!cloud || !status?.identity) return;
    known.current = null;
    setPeople([]);
    setCursors({});
    void cloud.joinBoard(boardId);
    const stopTimer = setTimeout(() => {
      // Whoever is here when this person arrives does not get an entrance song.
      known.current ??= new Set();
    }, 2500);
    return () => {
      clearTimeout(stopTimer);
      void cloud.leaveBoard();
    };
  }, [cloud, boardId, shareSignature]);

  useEffect(() => {
    if (!cloud) return;
    return cloud.onPresence((event) => {
      if (event.boardId !== boardId) return;
      if (event.type === 'cursor') {
        setCursors((all) => ({
          ...all,
          [event.key]: { x: event.x, y: event.y, view: event.view, at: Date.now() },
        }));
        return;
      }
      const byPerson = new Map<string, Person>();
      for (const p of event.people) {
        if (p.key === event.self || p.person === me) continue;
        const prior = byPerson.get(p.person);
        if (prior) prior.keys.push(p.key);
        else byPerson.set(p.person, { ...p, keys: [p.key] });
      }
      const list = [...byPerson.values()].sort((a, b) => a.joined - b.joined);
      setPeople(list);
      if (!known.current) {
        known.current = new Set(list.map((p) => p.person));
        return;
      }
      for (const p of list) {
        if (known.current.has(p.person)) continue;
        known.current.add(p.person);
        const last = songCooldown.get(p.person) || 0;
        if (!p.song || !getPreferences().playJoinSongs || Date.now() - last < 60000) continue;
        songCooldown.set(p.person, Date.now());
        void cloud
          .profileMedia(p.person, 0, p.song)
          .then((m) => {
            if (m.song) void playSong(m.song);
          })
          .catch(() => {});
      }
      for (const person of [...known.current])
        if (!byPerson.has(person)) known.current.delete(person);
    });
  }, [cloud, boardId, me]);

  // Pictures, downloaded once per version.
  useEffect(() => {
    if (!cloud) return;
    for (const p of people) {
      const key = p.person + ':' + p.avatar;
      if (key in avatars) continue;
      setAvatars((a) => ({ ...a, [key]: null }));
      if (p.avatar)
        void cloud
          .profileMedia(p.person, p.avatar, 0)
          .then((m) => setAvatars((a) => ({ ...a, [key]: m.avatar })))
          .catch(() => {});
    }
  }, [cloud, people]);

  // Share this person's pointer and view, a few times a second.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const lastSent = useRef(0);
  const pendingSend = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = () => {
    const e = engine.current,
      h = host.current;
    if (!cloud || !e || !h || !status?.identity) return;
    const now = Date.now();
    const wait = 70 - (now - lastSent.current);
    if (wait > 0) {
      pendingSend.current ??= setTimeout(() => {
        pendingSend.current = null;
        send();
      }, wait);
      return;
    }
    lastSent.current = now;
    const c = e.camera;
    const view = {
      x: -c.x / c.zoom,
      y: -c.y / c.zoom,
      width: h.clientWidth / c.zoom,
      height: h.clientHeight / c.zoom,
    };
    const at = pointer.current ?? { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    cloud.sendCursor({ x: at.x, y: at.y, view });
  };
  useEffect(() => {
    const h = host.current;
    if (!h || !cloud) return;
    const move = (event: PointerEvent) => {
      const e = engine.current;
      if (!e) return;
      const r = h.getBoundingClientRect();
      pointer.current = e.screenPoint({ x: event.clientX - r.left, y: event.clientY - r.top });
      send();
    };
    // Taking the camera back from someone being followed.
    const takeOver = () => followRef.current && setFollowing(null);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerdown', takeOver);
    h.addEventListener('wheel', takeOver, { passive: true });
    return () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerdown', takeOver);
      h.removeEventListener('wheel', takeOver);
    };
  }, [cloud, status?.identity]);
  useEffect(() => {
    if (people.length) send();
  }, [camera.x, camera.y, camera.zoom, people.length]);

  // Drop cursors that went quiet.
  useEffect(() => {
    const timer = setInterval(
      () =>
        setCursors((all) => {
          const fresh = Object.entries(all).filter(([, c]) => Date.now() - c.at < 30000);
          return fresh.length === Object.keys(all).length ? all : Object.fromEntries(fresh);
        }),
      5000,
    );
    return () => clearInterval(timer);
  }, []);

  const latestView = (p: Person) =>
    p.keys
      .map((k) => cursors[k])
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)[0];
  const showView = (p: Person) => {
    const e = engine.current,
      cursor = latestView(p);
    if (!e || !cursor) return false;
    const size = e.viewSize;
    const zoom = Math.min(size.width / cursor.view.width, size.height / cursor.view.height);
    e.lookAt(
      {
        x: cursor.view.x + cursor.view.width / 2,
        y: cursor.view.y + cursor.view.height / 2,
      },
      zoom,
    );
    return true;
  };
  const followed = people.find((p) => p.person === following);
  const followedView = followed && latestView(followed);
  useEffect(() => {
    if (followed && followedView) showView(followed);
  }, [followedView?.at]);
  useEffect(() => {
    if (following && !followed) setFollowing(null);
  }, [following, followed]);

  const byKey = useMemo(() => {
    const map = new Map<string, Person>();
    for (const p of people) for (const k of p.keys) map.set(k, p);
    return map;
  }, [people]);

  if (!cloud || !people.length) return null;
  return (
    <>
      <div className="collab-cursors" aria-hidden="true">
        {Object.entries(cursors).map(([key, c]) => {
          const p = byKey.get(key);
          if (!p) return null;
          const color = colorOf(p.person);
          return (
            <div
              key={key}
              className="collab-cursor"
              style={{
                transform: `translate(${c.x * camera.zoom + camera.x}px, ${c.y * camera.zoom + camera.y}px)`,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18">
                <path
                  d="M2 1.5 15.5 8.2 9.2 9.6 6.4 15.8Z"
                  fill={color}
                  stroke="#fff"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
              </svg>
              <span style={{ background: color }}>{p.name}</span>
            </div>
          );
        })}
      </div>
      <div className="collab-people" role="list" aria-label="People on this board">
        {people.map((p) => {
          const avatar = avatars[p.person + ':' + p.avatar];
          return (
            <div className="collab-person" role="listitem" key={p.person}>
              <button
                type="button"
                className="collab-avatar"
                style={{ borderColor: colorOf(p.person), background: colorOf(p.person) }}
                aria-label={`${p.name}${p.role === 'view' ? ', viewing' : ', editing'}`}
                title={`${p.name} · ${p.role === 'view' ? 'viewing' : 'editing'}`}
                data-following={following === p.person || undefined}
                onClick={() => setMenu(menu === p.person ? null : p.person)}
              >
                {avatar ? <img src={mediaUrl(avatar, 'thumb')} alt="" /> : initials(p.name)}
                {p.role === 'view' && (
                  <span className="collab-viewing">
                    <Eye size={9} />
                  </span>
                )}
              </button>
              {menu === p.person && (
                <div className="collab-menu glass-surface" role="menu">
                  <div className="collab-menu-name">{p.name}</div>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!latestView(p)}
                    onClick={() => {
                      setFollowing(null);
                      showView(p);
                      setMenu(null);
                    }}
                  >
                    <LocateFixed size={14} /> Go to {p.name}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setFollowing(following === p.person ? null : p.person);
                      setMenu(null);
                    }}
                  >
                    <Crosshair size={14} />
                    {following === p.person ? 'Stop following' : `Follow ${p.name}`}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {followed && (
        <div className="collab-following glass-surface" role="status">
          <span style={{ background: colorOf(followed.person) }} />
          Following {followed.name}
          <button type="button" aria-label="Stop following" onClick={() => setFollowing(null)}>
            <X size={13} />
          </button>
        </div>
      )}
    </>
  );
}
