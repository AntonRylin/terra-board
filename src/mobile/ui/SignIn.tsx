// The first screen on Android: sign in to Terra Cloud. Google and Microsoft open in a
// Custom Tab and come back through terraboard://auth/callback. "Continue with email" asks
// for a password; "Email me a code" signs in without one (no browser either way). The steps
// are electron/cloud-auth.cjs, the same as the desktop's.
import { useEffect, useState } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import type { CloudStatus, SignInProvider } from '../../bridge';
import { cloud, signInWithPassword } from '../cloud.ts';
import icon from '../../../assets/icon.png';

// Supabase sends a new code to an address at most once a minute.
const RESEND_AFTER = 60;

const message = (e: unknown) =>
  String(e instanceof Error ? e.message : e).replace(/^(Error: )+/, '');

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"
    />
  </svg>
);
const MicrosoftMark = () => (
  <svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </svg>
);
const providerName = (p: SignInProvider) => (p === 'microsoft' ? 'Microsoft' : 'Google');

export function SignIn({ status }: { status: CloudStatus }) {
  // Until the server says which methods it offers, Google and the email code are shown
  // (Terra Cloud offers both); an unavailable method then says so when chosen.
  const methods = status.methods ?? { email: true, google: true, microsoft: false };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'choose' | 'email' | 'code' | 'password'>('choose');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    void cloud.signInMethods().catch(() => {});
  }, []);
  useEffect(() => {
    if (!wait) return;
    const timer = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  // Signing in ends here; the gate then connects the phone to the account's library.
  const act = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const send = (address: string) =>
    act(async () => {
      const sent = await cloud.sendCode(address);
      setSentTo(sent.email);
      setCode('');
      setWait(RESEND_AFTER);
      setStep('code');
    });

  let body;
  if (status.waiting)
    body = (
      <>
        <h2>Finish in your browser</h2>
        <p className="mobile-lead">
          Sign in with {providerName(status.waiting)} in the browser page that opened. You come back
          here when you are done.
        </p>
        <button
          type="button"
          className="mobile-button"
          onClick={() => void cloud.cancelSignIn().catch(() => {})}
        >
          Cancel
        </button>
      </>
    );
  else if (step === 'email')
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim() && !busy) void send(email);
        }}
      >
        <h2>Sign in with a code</h2>
        <p className="mobile-lead">We email you a code. No password needed.</p>
        <label className="mobile-field">
          <span>Email</span>
          <input
            type="email"
            className="mobile-text"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError('');
            }}
            placeholder="you@example.com"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            disabled={busy}
          />
        </label>
        {error && (
          <p className="mobile-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="mobile-button primary" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send code'}
        </button>
        <div className="mobile-row">
          <button
            type="button"
            className="mobile-link"
            disabled={busy}
            onClick={() => {
              setStep('choose');
              setError('');
            }}
          >
            Other ways to sign in
          </button>
          <button
            type="button"
            className="mobile-link"
            disabled={busy}
            onClick={() => {
              setStep('password');
              setError('');
            }}
          >
            Use a password instead
          </button>
        </div>
      </form>
    );
  // Email and password. An account without a password (most sign up with a code or
  // Google) is pointed to the code instead.
  else if (step === 'password')
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim() && password && !busy)
            void act(() => signInWithPassword(email, password));
        }}
      >
        <h2>Sign in with email</h2>
        <p className="mobile-lead">No password yet? Get a sign-in code by email instead.</p>
        <label className="mobile-field">
          <span>Email</span>
          <input
            type="email"
            className="mobile-text"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError('');
            }}
            placeholder="you@example.com"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            disabled={busy}
          />
        </label>
        <label className="mobile-field">
          <span>Password</span>
          <input
            type="password"
            className="mobile-text"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            autoComplete="current-password"
            disabled={busy}
          />
        </label>
        {error && (
          <p className="mobile-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="mobile-button primary"
          disabled={busy || !email.trim() || !password}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="mobile-row">
          <button
            type="button"
            className="mobile-link"
            disabled={busy}
            onClick={() => {
              setStep('choose');
              setPassword('');
              setError('');
            }}
          >
            Other ways to sign in
          </button>
          <button
            type="button"
            className="mobile-link"
            disabled={busy}
            onClick={() => {
              setStep('email');
              setPassword('');
              setError('');
            }}
          >
            Email me a code instead
          </button>
        </div>
      </form>
    );
  else if (step === 'code')
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length >= 6 && !busy) void act(() => cloud.verifyCode(sentTo, code));
        }}
      >
        <h2>Enter the code</h2>
        <p className="mobile-lead">
          We sent a code to <b>{sentTo}</b>. It works for an hour.
        </p>
        <label className="mobile-field">
          <span>Code</span>
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ''));
              setError('');
            }}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            autoFocus
            disabled={busy}
            aria-invalid={!!error}
          />
        </label>
        {error && (
          <p className="mobile-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="mobile-button primary" disabled={busy || code.length < 6}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="mobile-row">
          <button
            type="button"
            className="mobile-link"
            disabled={busy || wait > 0}
            onClick={() => void send(sentTo)}
          >
            {wait > 0 ? `Send a new code (${wait})` : 'Send a new code'}
          </button>
          <button
            type="button"
            className="mobile-link"
            disabled={busy}
            onClick={() => {
              setStep('email');
              setCode('');
              setError('');
            }}
          >
            Use another email
          </button>
        </div>
      </form>
    );
  else
    body = (
      <>
        <h2>Sign in to see your boards</h2>
        <p className="mobile-lead">
          Use the account you signed in with in Terra Board on your computer.
        </p>
        <div className="mobile-buttons">
          {methods.google && (
            <button
              type="button"
              className="mobile-button provider"
              disabled={busy}
              onClick={() => void act(() => cloud.signInWith('google'))}
            >
              <GoogleMark />
              Continue with Google
            </button>
          )}
          {methods.microsoft && (
            <button
              type="button"
              className="mobile-button provider"
              disabled={busy}
              onClick={() => void act(() => cloud.signInWith('microsoft'))}
            >
              <MicrosoftMark />
              Continue with Microsoft
            </button>
          )}
          {methods.email && (
            <button
              type="button"
              className="mobile-button provider"
              disabled={busy}
              onClick={() => {
                setStep('password');
                setError('');
              }}
            >
              <Mail size={19} />
              Continue with email
            </button>
          )}
          {methods.email && (
            <button
              type="button"
              className="mobile-button provider"
              disabled={busy}
              onClick={() => {
                setStep('email');
                setError('');
              }}
            >
              <KeyRound size={19} />
              Email me a sign-in code
            </button>
          )}
        </div>
        {(error || status.error) && (
          <p className="mobile-error" role="alert">
            {error || status.error}
          </p>
        )}
      </>
    );

  return (
    <main className="mobile-screen">
      <div className="mobile-hero">
        <img className="mobile-mark" src={icon} width="56" height="56" alt="" />
        <h1>Terra Board</h1>
        <p>Your boards from your computer, on your phone.</p>
      </div>
      <section className="mobile-card">{body}</section>
      <p className="mobile-footnote">
        Boards are kept on this phone too, so they open without internet.
      </p>
    </main>
  );
}
