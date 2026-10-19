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

// The newer version on GitHub, whether it is downloading, ready to install or
// only available to download by hand.
export function newerVersion(status: UpdateStatus | null) {
  if (status?.state === 'ready' || status?.state === 'downloading')
    return status.available ?? status.latest ?? null;
  return status?.state === 'available' ? (status.latest ?? null) : null;
}

const RELEASES = 'https://github.com/AntonRylin/terra-board/releases/latest';

// The new version's GitHub release: what changed and its installer.
export function openReleasePage(status: UpdateStatus | null) {
  return openLink(status?.page || RELEASES);
}

// Downloads the new installer in the browser, for builds that cannot install it.
export function downloadUpdate(status: UpdateStatus | null) {
  return openLink(status?.download || status?.page || RELEASES);
}
