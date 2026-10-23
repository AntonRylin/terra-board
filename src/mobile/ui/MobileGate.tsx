// Android is cloud-first (docs/android.md): until this phone is connected to a
// Terra Cloud workspace it shows only the sign-in screen, and on the first
// connection it waits for the library to arrive before the board opens.
import { useEffect, useState, type ReactNode } from 'react';
import type { CloudStatus } from '../../bridge';
import { finishStartup } from '../../startup';
import { call } from '../host.ts';
import { cloud } from '../cloud.ts';
import { SignIn } from './SignIn';
import icon from '../../../assets/icon.png';
import './mobile.css';

type Phase = 'checking' | 'sign-in' | 'loading' | 'ready';

export function MobileGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  useEffect(() => {
    let current = true;
    void cloud.status().then((s) => current && setStatus(s));
    const off = cloud.onStatus(setStatus);
    return () => {
      current = false;
      off();
    };
  }, []);
  useEffect(() => {
    if (!status || phase === 'ready') return;
    if (!status.identity) return setPhase('sign-in');
    let current = true;
    void (async () => {
      // Boards already on the phone open straight away, online or not.
      const { boards } = await call<{ boards: unknown[] }>('library');
      if (!current) return;
      if (boards.length) return setPhase('ready');
      if (status.state === 'synced' && status.lastSync) {
        // An empty cloud library: start it with one board, which syncs up like any other.
        await call('createBoard', { name: 'Ideas' });
        if (current) setPhase('ready');
        return;
      }
      setPhase('loading');
    })().catch(() => current && setPhase('loading'));
    return () => {
      current = false;
    };
  }, [status, phase]);
  useEffect(() => {
    if (phase === 'sign-in' || phase === 'loading') finishStartup();
  }, [phase]);

  if (phase === 'ready') return <>{children}</>;
  if (phase === 'sign-in') return <SignIn />;
  if (phase === 'loading')
    return (
      <main className="mobile-screen">
        <div className="mobile-hero">
          <img className="mobile-mark" src={icon} width="56" height="56" alt="" />
          <h1>Getting your boards</h1>
          {status?.state === 'offline' ? (
            <p>
              This phone is offline. Your boards download as soon as it is back on the internet.
            </p>
          ) : status?.state === 'error' ? (
            <p role="alert">{status.error || 'Terra Cloud could not be reached.'}</p>
          ) : (
            <p>Downloading your library from Terra Cloud…</p>
          )}
          {status?.state === 'offline' || status?.state === 'error' ? (
            <button
              type="button"
              className="mobile-button primary"
              onClick={() => void cloud.syncNow().catch(() => {})}
            >
              Try again
            </button>
          ) : (
            <div className="mobile-track" aria-hidden="true">
              <span />
            </div>
          )}
        </div>
      </main>
    );
  return null;
}
