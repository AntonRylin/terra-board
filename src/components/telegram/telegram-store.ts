// What every Telegram frame on the board shares: the account's state, chats,
// people, files and the messages of open chats, kept current from
// electron/telegram.cjs. Nothing here is saved; TDLib keeps it on this PC.
import { useSyncExternalStore } from 'react';
import type {
  Td,
  TdFolder,
  TdChat,
  TdFile,
  TdMessage,
  TdUser,
  TelegramBatch,
  TelegramBridge,
  TelegramStatus,
} from './td';

export const telegramBridge = (): TelegramBridge | undefined =>
  (window.canvas as unknown as { telegram?: TelegramBridge } | undefined)?.telegram;

export interface History {
  /** Message IDs, oldest first. */
  ids: number[];
  messages: Map<number, TdMessage>;
  loading: boolean;
  /** The chat's first message is loaded. */
  complete: boolean;
}

const histories = new Map<number, History>();
const chats = new Map<number, TdChat>();
const users = new Map<number, TdUser>();
const files = new Map<number, TdFile>();
const requested = new Set<number>();
let status: TelegramStatus | null = null;
let auth: Td | null = null;
let connection: string | null = null;
let myId = 0;
let folders: TdFolder[] = [];
// Counts changes to each chat's pinned messages, for its pinned bar.
const pinChanges = new Map<number, number>();
let version = 0;
let started: Promise<void> | null = null;
const listeners = new Set<() => void>();
let scheduled = false;

function changed() {
  version++;
  if (scheduled) return;
  scheduled = true;
  // One render for a burst of updates.
  requestAnimationFrame(() => {
    scheduled = false;
    for (const listener of listeners) listener();
  });
}

function remember(file: TdFile | undefined) {
  if (file?.id) files.set(file.id, file);
}

function addMessage(message: TdMessage, history = histories.get(message.chat_id)) {
  if (!history) return;
  if (!history.messages.has(message.id)) {
    const ids = history.ids;
    // Usually the newest; otherwise in order.
    if (!ids.length || message.id > ids[ids.length - 1]) ids.push(message.id);
    else {
      let i = ids.length;
      while (i > 0 && ids[i - 1] > message.id) i--;
      ids.splice(i, 0, message.id);
    }
  }
  history.messages.set(message.id, message);
}
function patchMessage(chatId: number, id: number, change: (m: TdMessage) => TdMessage) {
  const history = histories.get(chatId),
    message = history?.messages.get(id);
  if (history && message) history.messages.set(id, change(message));
}

function apply(batch: TelegramBatch) {
  if (batch.status) status = batch.status;
  if (batch.auth !== undefined) {
    auth = batch.auth;
    if (auth?.['@type'] === 'authorizationStateClosed') {
      chats.clear();
      users.clear();
      histories.clear();
      files.clear();
      requested.clear();
    }
  }
  if (batch.connection !== undefined) connection = batch.connection;
  if (batch.myId !== undefined) myId = batch.myId;
  if (batch.folders !== undefined) folders = batch.folders;
  for (const chat of batch.chats) chats.set(chat.id, chat);
  for (const user of batch.users) users.set(user.id, user);
  for (const event of batch.events) {
    switch (event['@type']) {
      case 'updateFile':
        remember(event.file);
        break;
      case 'updateNewMessage':
        addMessage(event.message);
        break;
      case 'updateMessageSendSucceeded': {
        const history = histories.get(event.message.chat_id);
        if (history?.messages.has(event.old_message_id)) {
          history.messages.delete(event.old_message_id);
          history.ids = history.ids.filter((id) => id !== event.old_message_id);
        }
        addMessage(event.message, history);
        break;
      }
      case 'updateMessageSendFailed':
        patchMessage(event.message.chat_id, event.old_message_id, () => event.message);
        break;
      case 'updateMessageContent':
        patchMessage(event.chat_id, event.message_id, (m) => ({
          ...m,
          content: event.new_content,
        }));
        break;
      case 'updateMessageEdited':
        patchMessage(event.chat_id, event.message_id, (m) => ({
          ...m,
          edit_date: event.edit_date,
          reply_markup: event.reply_markup,
        }));
        break;
      case 'updateMessageIsPinned':
        pinChanges.set(event.chat_id, (pinChanges.get(event.chat_id) || 0) + 1);
        patchMessage(event.chat_id, event.message_id, (m) => ({
          ...m,
          is_pinned: event.is_pinned,
        }));
        break;
      case 'updateMessageInteractionInfo':
        patchMessage(event.chat_id, event.message_id, (m) => ({
          ...m,
          interaction_info: event.interaction_info,
        }));
        break;
      case 'updateMessageContentOpened':
        patchMessage(event.chat_id, event.message_id, (m) => ({
          ...m,
          content: { ...m.content, is_listened: true, is_viewed: true },
        }));
        break;
      case 'updateDeleteMessages': {
        if (event.from_cache) break;
        const history = histories.get(event.chat_id);
        if (!history) break;
        const gone = new Set<number>(event.message_ids);
        for (const id of gone) history.messages.delete(id);
        history.ids = history.ids.filter((id) => !gone.has(id));
        break;
      }
    }
  }
  changed();
}

/** Connects to electron/telegram.cjs once; frames call it when they appear. */
export function startTelegram(): Promise<void> {
  const bridge = telegramBridge();
  if (!bridge) return Promise.resolve();
  started ||= (async () => {
    bridge.onUpdate(apply);
    const snapshot = await bridge.snapshot();
    apply({ ...snapshot, events: [] });
    if (snapshot.status.credentials && snapshot.status.installed && !snapshot.status.running)
      await bridge.start().then((s) => apply({ status: s, chats: [], users: [], events: [] }));
  })().catch((error) => {
    started = null;
    throw error;
  });
  return started;
}
/** Asks again whether the extension is installed (after installing it). */
export async function refreshTelegram() {
  const bridge = telegramBridge();
  if (!bridge) return;
  let next = await bridge.status();
  if (next.installed && next.credentials && !next.running) next = await bridge.start();
  apply({ status: next, chats: [], users: [], events: [] });
}
export const setTelegramStatus = (next: TelegramStatus) =>
  apply({ status: next, chats: [], users: [], events: [] });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
/** Re-renders a frame whenever anything Telegram changes. */
export function useTelegram() {
  useSyncExternalStore(subscribe, () => version);
  return { status, auth, connection, myId, chats, users, folders };
}

export const chatOf = (id: number) => chats.get(id);
export const userOf = (id: number) => users.get(id);
export const myUserId = () => myId;
export const pinnedVersion = (chatId: number) => pinChanges.get(chatId) || 0;
/** The newest known state of a file. */
export const fileOf = (file: TdFile): TdFile => files.get(file.id) ?? file;

/** Starts downloading a file to show it (photos, avatars), once per file. */
export function want(file: TdFile | undefined, priority = 1) {
  if (!file) return;
  const current = fileOf(file);
  if (
    current.local.is_downloading_completed ||
    !current.local.can_be_downloaded ||
    requested.has(current.id)
  )
    return;
  requested.add(current.id);
  void telegramBridge()
    ?.invoke({ '@type': 'downloadFile', file_id: current.id, priority, synchronous: false })
    .then((file) => {
      remember(file as TdFile);
      changed();
    })
    .catch(() => requested.delete(current.id));
}
/** Downloads a file and waits for it (opening, dragging out, adding to the board). */
export async function downloadNow(file: TdFile) {
  const bridge = telegramBridge();
  if (!bridge) throw Error('Telegram works in the desktop app.');
  return bridge.download(file.id);
}

export function historyOf(chatId: number): History {
  let history = histories.get(chatId);
  if (!history) {
    history = { ids: [], messages: new Map(), loading: false, complete: false };
    histories.set(chatId, history);
  }
  return history;
}

/** Loads older messages of a chat (or the newest, the first time). */
export async function loadOlder(chatId: number, count = 40) {
  const bridge = telegramBridge(),
    history = historyOf(chatId);
  if (!bridge || history.loading || history.complete) return;
  history.loading = true;
  changed();
  try {
    let added = 0;
    // TDLib may answer with what it has locally first; ask until enough came.
    for (let attempt = 0; attempt < 4 && added < count; attempt++) {
      const from = history.ids[0] || 0;
      const result = await bridge.invoke<{ messages: TdMessage[] }>({
        '@type': 'getChatHistory',
        chat_id: chatId,
        from_message_id: from,
        offset: 0,
        limit: Math.min(100, count - added),
        only_local: false,
      });
      const messages = (result.messages || []).filter(Boolean);
      if (!messages.length) {
        history.complete = true;
        break;
      }
      for (const message of messages) addMessage(message, history);
      added += messages.length;
    }
  } finally {
    history.loading = false;
    changed();
  }
}

/** Marks messages as seen while a chat is open on screen (as Telegram apps do). */
export function viewMessages(chatId: number, ids: number[]) {
  if (!ids.length) return;
  void telegramBridge()
    ?.invoke({
      '@type': 'viewMessages',
      chat_id: chatId,
      message_ids: ids,
      source: { '@type': 'messageSourceChatHistory' },
      force_read: true,
    })
    .catch(() => {});
}
