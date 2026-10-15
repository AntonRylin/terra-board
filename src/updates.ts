import { useEffect, useState } from 'react';
import type { UpdateStatus } from './bridge';

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
