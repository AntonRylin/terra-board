// Board pictures and documents dragged onto a Telegram frame's open chat
// become attachments waiting to be sent there (Whiteboard's objectDrag/Drop).

export type TelegramSource = { path: string } | { assetId: string; name?: string };
// Where on screen the drop happened, to find the chat under it.
type Receiver = (sources: TelegramSource[], x: number, y: number) => void;
const receivers = new Map<string, Receiver>();

/** A frame with an open chat registers where its drops go. */
export function receiveTelegramDrops(id: string, receiver: Receiver) {
  receivers.set(id, receiver);
  return () => {
    if (receivers.get(id) === receiver) receivers.delete(id);
  };
}

/** The signed-in Telegram frame under a screen point. */
export function telegramDropAt(clientX: number, clientY: number): string | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const frame = (element as HTMLElement).closest<HTMLElement>('.canvas-telegram');
    const id = frame?.dataset.fileId;
    if (id && receivers.has(id)) return id;
  }
  return null;
}

/** Marks the frame (and the chat in its list) a board drag would drop into. */
export function markTelegramDrop(id: string | null, x = 0, y = 0) {
  for (const element of document.querySelectorAll<HTMLElement>('.tg-chat[data-board-drop]'))
    delete element.dataset.boardDrop;
  if (id)
    for (const element of document.elementsFromPoint(x, y)) {
      const row = (element as HTMLElement).closest<HTMLElement>('.tg-chat[data-chat-id]');
      if (row) {
        row.dataset.boardDrop = 'true';
        break;
      }
    }
  for (const element of document.querySelectorAll<HTMLElement>('.canvas-telegram[data-board-drop]'))
    if (element.dataset.fileId !== id) delete element.dataset.boardDrop;
  if (id)
    document
      .querySelector<HTMLElement>(`.canvas-telegram[data-file-id="${CSS.escape(id)}"]`)
      ?.setAttribute('data-board-drop', 'true');
}

export function dropOnTelegram(id: string, sources: TelegramSource[], x: number, y: number) {
  receivers.get(id)?.(sources, x, y);
}

// A Telegram file dragged out of a frame before it was downloaded: the board
// downloads it where it is dropped.
export const telegramFileType = 'application/x-terra-telegram-file';
export interface TelegramDragFile {
  fileId: number;
  name: string;
}
