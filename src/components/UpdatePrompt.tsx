import { useState } from 'react';
import { Download } from 'lucide-react';
import { installUpdate, newerOnGitHub, openUpdatePage, useUpdateStatus } from '../updates';

// Shown once a new version has downloaded, or on every launch while GitHub has a
// newer version this build cannot install itself. Dismissing it lasts until the
// next launch; a downloaded update still installs the next time Terra Board closes.
export function UpdatePrompt() {
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const ready = status?.state === 'ready' ? status.available! : null;
  const latest = newerOnGitHub(status);
  const version = ready || latest;
  if (!version || dismissed === version) return null;
  return (
    <div className="update-prompt glass-surface" role="status">
      <Download size={15} />
      <span>
        Terra Board {version} is {ready ? 'ready' : 'available'}
      </span>
      <button type="button" className="button" onClick={() => setDismissed(version)}>
        Later
      </button>
      {ready ? (
        <button type="button" className="button primary" onClick={() => void installUpdate()}>
          Restart
        </button>
      ) : (
        <button
          type="button"
          className="button primary"
          onClick={() => void openUpdatePage(status).catch(() => {})}
        >
          Get it
        </button>
      )}
    </div>
  );
}
