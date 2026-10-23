// What the renderer uses on Android, in place of ./platform.ts (vite.config.ts
// swaps them for `--mode android`), so none of this reaches desktop builds.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { onWorker, startMobile as startStorage } from './host.ts';
export { call, onExternal, externalReady } from './host.ts';
export { cloud } from './cloud.ts';
import { cloud, finishOAuth } from './cloud.ts';
export { MobileGate } from './ui/MobileGate';
export { AccountSettings as MobileAccountSettings } from './ui/AccountSettings';

export const isAndroid = true;

function base64(bytes: Uint8Array) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

// The WebView has no downloads: files go to the share sheet (Save to Files,
// Drive, another app), from the app's cache.
export async function saveFile(blob: Blob, name: string) {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'Terra Board file';
  const { uri } = await Filesystem.writeFile({
    path: 'exports/' + safe,
    data: base64(new Uint8Array(await blob.arrayBuffer())),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ title: safe, files: [uri] });
  } catch (e) {
    // Closing the share sheet is not an error.
    if (!/cancel/i.test(String(e))) throw e;
  }
}

export const openExternal = (url: string) => Browser.open({ url });

// Android has no window close: save when the app leaves the screen, and let
// the system back button close the open dialog or menu before leaving.
export function onAndroidLifecycle(flush: () => Promise<void>) {
  const save = () => void flush().catch((e) => console.error(e));
  const hidden = () => document.hidden && save();
  document.addEventListener('visibilitychange', hidden);
  const pause = App.addListener('pause', save);
  // Back on screen or back online: fetch what changed on the computer meanwhile.
  const fresh = () => void cloud.syncNow().catch(() => {});
  const resume = App.addListener('resume', fresh);
  window.addEventListener('online', fresh);
  const back = App.addListener('backButton', () => {
    // Text being edited on the board is kept, as when tapping elsewhere
    // (Escape would discard the draft).
    const editing = document.activeElement as HTMLElement | null;
    if (
      editing?.matches('textarea, [contenteditable="true"]') &&
      !editing.closest('[role=dialog], [role=menu], .settings-page')
    ) {
      editing.blur();
      return;
    }
    // The innermost thing first: an editor, a menu, a dialog, then a full page.
    const open = [
      'textarea:focus, input:focus, [contenteditable="true"]:focus',
      '[role=menu], .context-menu',
      '[role=dialog]',
      '.settings-page, .image-viewer, .pdf-workspace, .frame-usages',
    ]
      .map((selector) => [...document.querySelectorAll(selector)].at(-1))
      .find(Boolean);
    // Escape goes to where the page listens: the focused element inside what
    // is open, or what is open itself (it bubbles to the window from there).
    const active = document.activeElement;
    const target = open && active && open.contains(active) ? active : open;
    if (target)
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
      );
    // An open board goes back to the list of boards (App.tsx); the list leaves the app.
    else if (!window.dispatchEvent(new Event('terra-board:back', { cancelable: true }))) return;
    else
      void flush()
        .catch(() => {})
        .finally(() => App.minimizeApp());
  });
  return () => {
    document.removeEventListener('visibilitychange', hidden);
    void pause.then((l) => l.remove());
    void resume.then((l) => l.remove());
    window.removeEventListener('online', fresh);
    void back.then((l) => l.remove());
  };
}

// Long-press opens the context menu everywhere a right-click would (boards,
// folders, the board panel). The WebView's own long-press menu is replaced, so
// it fires once; the board canvas handles its own (canvas/engine.ts).
function installTouchMenus() {
  let timer = 0,
    start: { x: number; y: number } | null = null,
    opened = 0,
    touch = false,
    // Any finger held still (the canvas opens its own menu after 550 ms too).
    held: { at: number; x: number; y: number; moved: boolean } | null = null;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
    start = null;
  };
  window.addEventListener(
    'pointerdown',
    (e) => {
      touch = e.pointerType === 'touch';
      clear();
      held = touch ? { at: performance.now(), x: e.clientX, y: e.clientY, moved: false } : null;
      const target = e.target as Element;
      // The canvas has its own long-press; toolbar tools are picked up to rearrange them.
      if (!touch || target.closest?.('.canvas-surface, [data-tool-id]')) return;
      start = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => {
        timer = 0;
        opened = performance.now();
        target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: start!.x,
            clientY: start!.y,
            button: 2,
          }),
        );
      }, 550);
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clear();
      if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 10) held.moved = true;
    },
    true,
  );
  window.addEventListener(
    'pointerup',
    () => {
      if (held && !held.moved && performance.now() - held.at >= 550) opened = performance.now();
      held = null;
      clear();
    },
    true,
  );
  window.addEventListener('pointercancel', clear, true);
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!e.isTrusted || !touch) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  // The finger lifting after a long-press is not also a click.
  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || performance.now() - opened > 800) return;
      opened = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

// Google and Microsoft sign-in: the page opens in a Custom Tab (Google refuses sign-in
// inside an app's WebView) and comes back as terraboard://auth/callback, which Android
// hands to this app (the intent filter in AndroidManifest.xml).
function installSignInLinks() {
  onWorker('open-url', (url: string) => void Browser.open({ url }).catch(() => {}));
  const callback = (url?: string) => {
    if (!url?.startsWith('terraboard://auth/')) return;
    void finishOAuth(url).catch(() => {});
  };
  void App.addListener('appUrlOpen', ({ url }) => callback(url));
  void App.getLaunchUrl()
    .then((launch) => callback(launch?.url))
    .catch(() => {});
}

// Typing on the board (a note, text, a list…) opens the keyboard, which shrinks the page:
// the toolbars and the board panel would land on the text. They step aside meanwhile
// (styles.css, html.android.typing-on-board).
function installTypingMode() {
  const chrome =
    '.selection-tools, .rich-format-bar, .canvas-toolbar, .canvas-zoom, .launcher, .board-header, [role=dialog], [role=menu], .context-menu, .settings-page';
  const update = () => {
    const field = document.activeElement as HTMLElement | null;
    const typing =
      !!field &&
      field.matches(
        'textarea, input, [contenteditable="true"], [contenteditable="plaintext-only"]',
      ) &&
      !!field.closest('.whiteboard') &&
      !field.closest(chrome);
    document.documentElement.classList.toggle('typing-on-board', typing);
  };
  // focusout comes before the next focusin; look once both have happened.
  const later = () => setTimeout(update, 0);
  document.addEventListener('focusin', later);
  document.addEventListener('focusout', later);
}

let installed = false;
export function startMobile() {
  if (!installed) {
    installed = true;
    installTouchMenus();
    installSignInLinks();
    installTypingMode();
  }
  return startStorage();
}
