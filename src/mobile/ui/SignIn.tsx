// The first screen on Android: connect this phone to Terra Cloud.
// Today that is a pairing code from Terra Board on a computer; sign-in with an
// account (email code, Google) joins it here once accounts exist.
import { useState } from 'react';
import { cloud } from '../cloud.ts';
import icon from '../../../assets/icon.png';

const message = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/^(Error: )+/, '');

export function SignIn() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const clean = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !clean) return;
    if (clean.startsWith('S')) {
      setError(
        'This is an invite to a shared board. Connect to your own computer first, then enter the invite in Settings → Account.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await cloud.join(clean);
      // The gate notices the new identity and opens the library.
    } catch (e) {
      const text = message(e);
      setError(
        /fetch|network|offline/i.test(text)
          ? 'Terra Cloud could not be reached. Check the internet connection and try again.'
          : text,
      );
      setBusy(false);
    }
  }

  return (
    <main className="mobile-screen">
      <div className="mobile-hero">
        <img className="mobile-mark" src={icon} width="56" height="56" alt="" />
        <h1>Terra Board</h1>
        <p>Your boards from your computer, on your phone.</p>
      </div>
      <form className="mobile-card" onSubmit={connect}>
        <h2>Connect to your computer</h2>
        <ol className="mobile-steps">
          <li>
            On your computer, open Terra Board and go to <b>Settings → Cloud sync</b>.
          </li>
          <li>
            Turn on <b>Sync my whole library</b> if it is off.
          </li>
          <li>
            Under <b>Your computers</b>, choose <b>Create code</b> and enter it below.
          </li>
        </ol>
        <label className="mobile-field">
          <span>Code</span>
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError('');
            }}
            placeholder="ABCDE-12345"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={40}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? 'mobile-sign-in-error' : undefined}
          />
        </label>
        {error && (
          <p className="mobile-error" id="mobile-sign-in-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="mobile-button primary" disabled={busy || !clean}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <p className="mobile-hint">
          The code works once, for 15 minutes. Your boards are kept on this phone too, so they open
          without internet.
        </p>
      </form>
    </main>
  );
}
