import { useEffect, useState } from 'react';
import { openLink, type UpdateStatus } from './bridge';

// Live update state from the desktop app; null in the web preview.
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const updates = window.canvas?.updates;
    if (!updates) return;
    let live = true;
    const off = updates.onStatus(setStatus);
    updates
      .status()
      .then((s) => live && setStatus(s))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}

export function installUpdate() {
  return window.canvas?.updates.install();
}

// A newer version on GitHub that this build will not install by itself: either it
// was built from source, or no installer for it is downloading.
export function newerOnGitHub(status: UpdateStatus | null) {
  if (!status?.latest || status.state === 'ready' || status.state === 'downloading') return null;
  return status.latest;
}

export function openUpdatePage(status: UpdateStatus | null) {
  return openLink(status?.page || 'https://github.com/AntonRylin/terra-board');
}
