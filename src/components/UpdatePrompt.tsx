import { useState } from 'react';
import { Download } from 'lucide-react';
import { installUpdate, useUpdateStatus } from '../updates';

// Shown once a new version has downloaded. Dismissing it is fine: the update
// still installs the next time Terra Board closes.
export function UpdatePrompt() {
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (status?.state !== 'ready' || dismissed === status.available) return null;
  return (
    <div className="update-prompt glass-surface" role="status">
      <Download size={15} />
      <span>Terra Board {status.available} is ready</span>
      <button type="button" className="button" onClick={() => setDismissed(status.available!)}>
        Later
      </button>
      <button type="button" className="button primary" onClick={() => void installUpdate()}>
        Restart
      </button>
    </div>
  );
}
