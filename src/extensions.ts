import { useEffect, useState } from 'react';
import type { ExtensionStatus } from './bridge';

// Settings → Extensions as the desktop app reports it, live; null in the web
// preview and for live-share guests, which have no extensions.
export function useExtensions() {
  const [list, setList] = useState<ExtensionStatus[] | null>(null);
  useEffect(() => {
    const extensions = window.canvas?.extensions;
    if (!extensions) return;
    let live = true;
    const off = extensions.onChange((next) => live && setList(next));
    extensions
      .list()
      .then((next) => live && setList(next))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  return list;
}

// Whether an extension's features can be offered (its menu items, buttons).
// Only the answer is state, so install progress doesn't re-render the caller.
export function useExtensionInstalled(id: string) {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const extensions = window.canvas?.extensions;
    if (!extensions) return;
    let live = true;
    const update = (list: ExtensionStatus[]) =>
      live && setInstalled(list.some((e) => e.id === id && e.state === 'installed'));
    const off = extensions.onChange(update);
    extensions
      .list()
      .then(update)
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, [id]);
  return installed;
}
