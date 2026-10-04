import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import InlineName, { flushInlineNames } from '../src/components/InlineName';
import { invoke } from '../src/bridge';
import '../src/styles.css';
const folder = await invoke<any>('createFolder', { name: 'Title test folder' });
const board = await invoke<any>('createBoard', { name: 'Title test board', folderId: folder.id });
const trashed = await invoke<any>('createBoard', { name: 'Title test trash' });
await invoke('updateBoard', { id: trashed.id, patch: { trashed: true } });
await invoke('setLastBoard', { id: board.id });
createRoot(document.getElementById('root')!).render(<App />);
const tick = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const check = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
const waitFor = async (fn: () => unknown) => {
  const deadline = performance.now() + 3000;
  while (!fn() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  check(fn(), 'Timed out waiting for rename');
};
const edit = async (el: HTMLElement) => {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await tick();
  check(el.isContentEditable, 'name did not become editable in place');
  return el;
};
const type = (el: HTMLElement, value: string) => {
  el.textContent = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
(window as any).runNameLifecycleChecks = async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let release!: () => void;
  const saved = new Promise<void>((resolve) => {
    release = resolve;
  });
  root.render(<InlineName value="Before" label="Slow rename test" onCommit={() => saved} />);
  await tick();
  const el = host.querySelector<HTMLElement>('.inline-name')!;
  await edit(el);
  type(el, 'After');
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check(!el.isContentEditable, 'pending save still allows typing');
  root.unmount();
  let flushed = false;
  const flush = flushInlineNames().then(() => {
    flushed = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  check(!flushed, 'close flush abandoned the unmounted pending rename');
  release();
  await flush;
  host.remove();
  return { pending: 'input frozen', unmounted: 'close waits for save' };
};
(window as any).runTitleChecks = async () => {
  await waitFor(() => document.querySelector('.board-title'));
  const title = document.querySelector<HTMLElement>('.board-title')!,
    before = title.getBoundingClientRect();
  await edit(title);
  type(title, 'Renamed right here');
  check(!document.querySelector('.modal-backdrop'), 'renaming opened a modal');
  const after = title.getBoundingClientRect();
  check(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1, 'title editor moved');
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  check(!title.isContentEditable, 'title still accepts input during its pending save');
  await flushInlineNames();
  await tick();
  await waitFor(() => !title.isContentEditable && title.getAttribute('aria-busy') === 'false');
  check(
    (await invoke<any>('loadBoard', { id: board.id })).board.name === 'Renamed right here',
    'board rename was not persisted',
  );
  await edit(title);
  type(title, 'Cancelled name');
  title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check(title.textContent === 'Renamed right here', 'Escape did not restore board name');
  document.querySelector<HTMLButtonElement>(`[data-item="${folder.id}"]`)!.click();
  await tick();
  const heading = document.querySelector<HTMLElement>('.folder-sheet h2 .inline-name')!;
  check(heading, 'folder name has no inline editor');
  await edit(heading);
  type(heading, 'Renamed folder');
  heading.blur();
  await flushInlineNames();
  await tick();
  await waitFor(() => !heading.isContentEditable && heading.getAttribute('aria-busy') === 'false');
  check(
    (await invoke<any>('library')).folders.find((f: any) => f.id === folder.id).name ===
      'Renamed folder',
    'folder rename was not persisted',
  );
  const cardName = document.querySelector<HTMLElement>('.folder-board .inline-name')!;
  await edit(cardName);
  type(cardName, 'Renamed in folder');
  cardName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flushInlineNames();
  await tick();
  await waitFor(
    () => !cardName.isContentEditable && cardName.getAttribute('aria-busy') === 'false',
  );
  check(
    document.querySelector('.board-title')!.textContent === 'Renamed in folder',
    'header did not follow the folder-card rename',
  );
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
  );
  await tick();
  await waitFor(() => document.querySelector('.library-search'));
  const searchName = document.querySelector<HTMLElement>(
    `.search-results [data-item="${board.id}"] .inline-name`,
  )!;
  await edit(searchName);
  type(searchName, 'Cancelled search name');
  searchName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check(
    document.querySelector('[role="dialog"][aria-label="Search"]'),
    'Escape closed Search instead of cancelling its name draft',
  );
  check(searchName.textContent === 'Renamed in folder', 'Escape lost the original search name');
  await edit(searchName);
  type(searchName, 'Renamed in search');
  await flushInlineNames();
  await tick();
  check(
    document.querySelector('.board-title')!.textContent === 'Renamed in search',
    'search rename did not update the board',
  );
  document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click();
  await tick();
  const currentTitle = document.querySelector<HTMLElement>('.board-title')!;
  await edit(currentTitle);
  type(currentTitle, 'Saved before window close');
  await flushInlineNames();
  await tick();
  check(
    (await invoke<any>('loadBoard', { id: board.id })).board.name === 'Saved before window close',
    'close flush lost an active title draft',
  );
  // Open Trash through the same application menu used by the user.
  document
    .querySelector('.launcher')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((el) => el.textContent?.includes('Trash'))!
    .click();
  await tick();
  const trashName = document.querySelector<HTMLElement>(
    `.trash-list [data-item="${trashed.id}"] .inline-name`,
  )!;
  await edit(trashName);
  type(trashName, 'Cancelled trash name');
  trashName.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  check(
    document.querySelector('[role="dialog"][aria-label="Trash"]'),
    'Escape closed Trash instead of cancelling its draft',
  );
  check(trashName.textContent === 'Title test trash', 'Escape lost the original trash name');
  await edit(trashName);
  type(trashName, 'Renamed in Trash');
  await flushInlineNames();
  check(
    (await invoke<any>('loadBoard', { id: trashed.id })).board.name === 'Renamed in Trash',
    'trash name was not saved',
  );
  return {
    board: 'inline saved/cancelled',
    folder: 'inline saved',
    card: 'inline saved and header updated',
    search: 'saved/cancelled in place',
    trash: 'saved/cancelled in place',
    close: 'active draft saved',
  };
};
