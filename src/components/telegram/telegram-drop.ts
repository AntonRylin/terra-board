// Board pictures and documents dragged onto a Telegram frame's open chat
// become attachments waiting to be sent there (Whiteboard's objectDrag/Drop).

export type TelegramSource = { path: string } | { assetId: string; name?: string };
type Receiver = (sources: TelegramSource[]) => void;
const receivers = new Map<string, Receiver>();

/** A frame with an open chat registers where its drops go. */
export function receiveTelegramDrops(id: string, receiver: Receiver) {
  receivers.set(id, receiver);
  return () => {
    if (receivers.get(id) === receiver) receivers.delete(id);
  };
}

/** The Telegram frame with an open chat under a screen point. */
export function telegramDropAt(clientX: number, clientY: number): string | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const frame = (element as HTMLElement).closest<HTMLElement>('.canvas-telegram');
    const id = frame?.dataset.fileId;
    if (id && receivers.has(id)) return id;
  }
  return null;
}

/** Marks the frame a board drag would drop into. */
export function markTelegramDrop(id: string | null) {
  for (const element of document.querySelectorAll<HTMLElement>('.canvas-telegram[data-board-drop]'))
    if (element.dataset.fileId !== id) delete element.dataset.boardDrop;
  if (id)
    document
      .querySelector<HTMLElement>(`.canvas-telegram[data-file-id="${CSS.escape(id)}"]`)
      ?.setAttribute('data-board-drop', 'true');
}

export function dropOnTelegram(id: string, sources: TelegramSource[]) {
  receivers.get(id)?.(sources);
}

// A Telegram file dragged out of a frame before it was downloaded: the board
// downloads it where it is dropped.
export const telegramFileType = 'application/x-terra-telegram-file';
export interface TelegramDragFile {
  fileId: number;
  name: string;
}
