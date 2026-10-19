import { useState } from 'react';
import { Download, X } from 'lucide-react';
import {
  downloadUpdate,
  installUpdate,
  newerVersion,
  openReleasePage,
  useUpdateStatus,
} from '../updates';

// Shown as soon as GitHub has a newer version. The installed app downloads it in
// the background and then offers Restart, which installs it and reopens Terra
// Board; other builds link to the installer. Closing the prompt lasts until the
// next launch, and a downloaded update still installs when Terra Board closes.
export function UpdatePrompt() {
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const version = newerVersion(status);
  if (!status || !version || dismissed === version) return null;
  const ignore = (promise: Promise<unknown> | undefined) => void promise?.catch(() => {});
  return (
    <div className="update-prompt glass-surface" role="status">
      <Download size={15} />
      <span className="update-prompt-text">
        <strong>Terra Board {version}</strong>
        <span>
          {status.state === 'ready'
            ? 'Ready to install'
            : status.state === 'downloading'
              ? `Downloading… ${status.percent ?? 0}%`
              : 'New version available'}
          {' · '}
          <button
            type="button"
            className="update-prompt-link"
            onClick={() => ignore(openReleasePage(status))}
          >
            What's new
          </button>
        </span>
      </span>
      {status.state === 'ready' ? (
        <button type="button" className="button primary" onClick={() => ignore(installUpdate())}>
          Restart to update
        </button>
      ) : status.state === 'available' ? (
        <button
          type="button"
          className="button primary"
          onClick={() => ignore(downloadUpdate(status))}
        >
          Download
        </button>
      ) : null}
      <button
        type="button"
        className="icon-button update-prompt-close"
        aria-label="Close"
        title="Close"
        onClick={() => setDismissed(version)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
