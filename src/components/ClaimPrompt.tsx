import { useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import type { CloudStatus } from '../bridge';

const SEEN = 'terra-board.claim-prompt-seen';

const seen = () => {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return false;
  }
};

// Shown once on a computer that syncs anonymously (set up before accounts): without a
// sign-in, losing every such computer loses the cloud copy. Settings → Account keeps the
// same card for later. Nothing is forced; sync keeps working.
export function ClaimPrompt({
  status,
  onSignIn,
}: {
  status: CloudStatus | null;
  onSignIn: () => void;
}) {
  const [closed, setClosed] = useState(seen);
  if (closed || status?.account.state !== 'anonymous' || !status.identity) return null;
  const close = () => {
    try {
      localStorage.setItem(SEEN, '1');
    } catch {}
    setClosed(true);
  };
  return (
    <div className="update-prompt claim-prompt glass-surface" role="status">
      <KeyRound size={15} />
      <span className="update-prompt-text">
        <strong>Add a sign-in so you can't lose your cloud boards</strong>
        <span>Your boards, shares and profile move to your account.</span>
      </span>
      <button
        type="button"
        className="button primary"
        onClick={() => {
          close();
          onSignIn();
        }}
      >
        Sign in…
      </button>
      <button
        type="button"
        className="icon-button update-prompt-close"
        aria-label="Not now"
        title="Not now"
        onClick={close}
      >
        <X size={14} />
      </button>
    </div>
  );
}
