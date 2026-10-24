// TDLib objects as Telegram frames use them (TDLib's JSON interface; field
// names as TDLib sends them). Only what frames read is typed.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Td = { '@type': string; [field: string]: any };

export interface TdFile extends Td {
  id: number;
  size: number;
  expected_size: number;
  local: {
    path: string;
    can_be_downloaded: boolean;
    is_downloading_active: boolean;
    is_downloading_completed: boolean;
    downloaded_size: number;
  };
  remote: { is_uploading_active: boolean; is_uploading_completed?: boolean; uploaded_size: number };
}
export interface TdText extends Td {
  text: string;
  entities: Td[];
}
export interface TdChat extends Td {
  id: number;
  type: Td;
  title: string;
  photo?: { small: TdFile; minithumbnail?: { data: string } };
  last_message?: TdMessage;
  positions: { list: Td; order: string; is_pinned: boolean }[];
  unread_count: number;
  unread_mention_count: number;
  last_read_inbox_message_id: number;
  last_read_outbox_message_id: number;
  is_marked_as_unread: boolean;
  notification_settings?: { mute_for: number };
  permissions?: { can_send_basic_messages: boolean };
}
export interface TdUser extends Td {
  id: number;
  first_name: string;
  last_name: string;
  profile_photo?: { small: TdFile; minithumbnail?: { data: string } };
  type: Td;
}
export interface TdMessage extends Td {
  id: number;
  chat_id: number;
  sender_id: Td;
  is_outgoing: boolean;
  date: number;
  edit_date: number;
  content: Td;
  sending_state?: Td;
  media_album_id?: string;
  is_channel_post: boolean;
  reply_to?: Td;
  forward_info?: Td;
  author_signature?: string;
}

export interface TelegramStatus {
  /** TDLib is built for this system. */
  supported: boolean;
  /** The Telegram extension is installed. */
  installed: boolean;
  /** An API ID and hash are known (entered here or built in). */
  credentials: boolean;
  /** Entered here, so they can be removed. */
  ownCredentials: boolean;
  /** The system can keep them encrypted. */
  canRemember: boolean;
  running: boolean;
  error: string;
}
/** A chat folder the person made in Telegram. */
export interface TdFolder {
  id: number;
  name: string;
}
export interface TelegramSnapshot {
  auth: Td | null;
  connection: string | null;
  myId: number;
  folders?: TdFolder[];
  stories?: Td[];
  chats: TdChat[];
  users: TdUser[];
  status: TelegramStatus;
}
export interface TelegramBatch {
  auth?: Td | null;
  connection?: string | null;
  myId?: number;
  folders?: TdFolder[];
  status?: TelegramStatus;
  chats: TdChat[];
  users: TdUser[];
  events: Td[];
}
export interface StagedFile {
  path: string;
  name: string;
  size: number;
}
/** electron/telegram.cjs, as the preload script exposes it. */
export interface TelegramBridge {
  status(): Promise<TelegramStatus>;
  snapshot(): Promise<TelegramSnapshot>;
  start(): Promise<TelegramStatus>;
  invoke<T = Td>(query: Td): Promise<T>;
  stage(sources: ({ path: string } | { assetId: string; name?: string })[]): Promise<StagedFile[]>;
  pick(): Promise<StagedFile[]>;
  /** A recorded voice message (WebM Opus) saved for sending as Ogg Opus. */
  voice(bytes: Uint8Array): Promise<{ path: string; seconds: number }>;
  /** A pasted picture or file that isn't on disk (a screenshot), saved for sending. */
  pasted(file: { bytes: Uint8Array; name: string; type: string }): Promise<StagedFile>;
  /** Cut, copy, paste or select all in the focused field. */
  edit(action: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<void>;
  download(id: number): Promise<string>;
  setCredentials(input: { apiId: string; apiHash: string }): Promise<TelegramStatus>;
  logOut(): Promise<TelegramStatus>;
  forget(): Promise<TelegramStatus>;
  drag(path: string, icon?: string): void;
  onUpdate(callback: (batch: TelegramBatch) => void): () => void;
}

export const fileUrl = (file: TdFile) => `terra-telegram://file/${file.id}`;

/** A chat list by name: 'main', 'archive' or 'folder:<id>'. */
export type ListName = string;
export const chatListOf = (name: ListName): Td =>
  name === 'archive'
    ? { '@type': 'chatListArchive' }
    : name.startsWith('folder:')
      ? { '@type': 'chatListFolder', chat_folder_id: Number(name.slice(7)) }
      : { '@type': 'chatListMain' };
const listName = (list: Td | undefined): ListName =>
  list?.['@type'] === 'chatListArchive'
    ? 'archive'
    : list?.['@type'] === 'chatListFolder'
      ? `folder:${list.chat_folder_id}`
      : 'main';
/** A chat's place in a chat list (the main one by default), or null. */
export function mainPosition(chat: TdChat, name: ListName = 'main') {
  return chat.positions?.find((p) => listName(p.list) === name) ?? null;
}
/** A list's chats, pinned first, then newest first (TDLib's order). */
export function sortedChats(chats: Iterable<TdChat>, name: ListName = 'main') {
  const listed: [bigint, boolean, TdChat][] = [];
  for (const chat of chats) {
    const p = mainPosition(chat, name);
    if (p) listed.push([BigInt(p.order), p.is_pinned, chat]);
  }
  listed.sort((a, b) => (a[0] === b[0] ? 0 : a[0] > b[0] ? -1 : 1));
  return listed.map(([, pinned, chat]) => ({ chat, pinned }));
}

export const userName = (user: TdUser | undefined) =>
  user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Deleted account' : '';

/** The chat's other person, for private chats. */
export const privateUserId = (chat: TdChat) =>
  chat.type?.['@type'] === 'chatTypePrivate' || chat.type?.['@type'] === 'chatTypeSecret'
    ? (chat.type.user_id as number)
    : 0;
export const isChannel = (chat: TdChat) =>
  chat.type?.['@type'] === 'chatTypeSupergroup' && !!chat.type.is_channel;
export const isGroup = (chat: TdChat) =>
  chat.type?.['@type'] === 'chatTypeBasicGroup' ||
  (chat.type?.['@type'] === 'chatTypeSupergroup' && !chat.type.is_channel);

/** One line about a message, for the chat list and replies. */
export function messageSummary(message: TdMessage | undefined): string {
  if (!message) return '';
  const c = message.content || {};
  const caption = (c.caption?.text as string) || '';
  switch (c['@type']) {
    case 'messageText':
      return c.text?.text || '';
    case 'messagePhoto':
      return caption ? `🖼 ${caption}` : 'Photo';
    case 'messageVideo':
      return caption ? `📹 ${caption}` : 'Video';
    case 'messageAnimation':
      return caption ? `GIF, ${caption}` : 'GIF';
    case 'messageDocument':
      return caption || `📎 ${c.document?.file_name || 'File'}`;
    case 'messageAudio':
      return caption || `🎵 ${c.audio?.title || c.audio?.file_name || 'Audio'}`;
    case 'messageVoiceNote':
      return 'Voice message';
    case 'messageVideoNote':
      return 'Video message';
    case 'messageSticker':
      return `${c.sticker?.emoji || ''} Sticker`.trim();
    case 'messageLocation':
    case 'messageVenue':
      return 'Location';
    case 'messageContact':
      return 'Contact';
    case 'messagePoll':
      return `📊 ${c.poll?.question?.text || 'Poll'}`;
    case 'messageCall':
      return 'Call';
    case 'messagePinMessage':
      return 'Pinned a message';
    case 'messageChatAddMembers':
      return 'Joined the group';
    case 'messageChatJoinByLink':
      return 'Joined by link';
    case 'messageChatDeleteMember':
      return 'Left the group';
    case 'messageChatChangeTitle':
      return `Changed the name to “${c.title}”`;
    case 'messageChatChangePhoto':
      return 'Changed the photo';
    case 'messageBasicGroupChatCreate':
    case 'messageSupergroupChatCreate':
      return 'Created the group';
    case 'messageContactRegistered':
      return 'Joined Telegram';
    default:
      return caption || 'Message';
  }
}
/** Service messages show centered, without a bubble. */
export const isService = (message: TdMessage) =>
  /^message(Pin|Chat|BasicGroup|Supergroup|ContactRegistered|ScreenshotTaken|Custom|Unsupported|ExpiredPhoto|ExpiredVideo|GameScore|PaymentSuccessful|ForumTopic|Gift|Boost|Giveaway)/.test(
    message.content?.['@type'] || '',
  );

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayYear = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
/** A message's time as the chat list shows it: today's time, this week's day, or a date. */
export function listDate(seconds: number) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000),
    now = new Date();
  if (date.toDateString() === now.toDateString()) return time.format(date);
  const days = (now.getTime() - date.getTime()) / 86400000;
  if (days < 6) return weekday.format(date);
  return date.getFullYear() === now.getFullYear() ? day.format(date) : dayYear.format(date);
}
export const messageTime = (seconds: number) => time.format(new Date(seconds * 1000));
export function dayLabel(seconds: number) {
  const date = new Date(seconds * 1000),
    now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.getFullYear() === now.getFullYear() ? day.format(date) : dayYear.format(date);
}

export function formatBytes(bytes: number) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Initials for a chat without a photo. */
export function initials(title: string) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return [...letters].slice(0, 2).join('').toUpperCase();
}
const avatarColors = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];
export const avatarColor = (id: number) => avatarColors[Math.abs(id) % avatarColors.length];

/** The file a message carries, and its name, for downloads, drags and the board. */
export function messageFile(message: TdMessage): { file: TdFile; name: string } | null {
  const c = message.content || {};
  switch (c['@type']) {
    case 'messagePhoto': {
      const sizes = (c.photo?.sizes || []) as { photo: TdFile; width: number }[];
      const best = sizes[sizes.length - 1];
      return best ? { file: best.photo, name: `Photo ${message.id}.jpg` } : null;
    }
    case 'messageVideo':
      return { file: c.video.video, name: c.video.file_name || `Video ${message.id}.mp4` };
    case 'messageAnimation':
      return {
        file: c.animation.animation,
        name: c.animation.file_name || `GIF ${message.id}.mp4`,
      };
    case 'messageDocument':
      return { file: c.document.document, name: c.document.file_name || 'File' };
    case 'messageAudio':
      return { file: c.audio.audio, name: c.audio.file_name || `${c.audio.title || 'Audio'}.mp3` };
    case 'messageVoiceNote':
      return { file: c.voice_note.voice, name: `Voice message ${message.id}.ogg` };
    case 'messageVideoNote':
      return { file: c.video_note.video, name: `Video message ${message.id}.mp4` };
    case 'messageSticker':
      return { file: c.sticker.sticker, name: `Sticker ${message.id}.webp` };
    default:
      return null;
  }
}

/** Text with its formatting (bold, links…) as spans for a message bubble. */
export interface TextPart {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  pre?: boolean;
  spoiler?: boolean;
  url?: string;
}
// Entities count UTF-16 code units, as JavaScript strings do.
export function textParts(text: TdText | undefined): TextPart[] {
  const value = text?.text || '';
  if (!value) return [];
  const cuts = new Set([0, value.length]);
  const entities = (text?.entities || []).filter(
    (e) => e.length > 0 && e.offset >= 0 && e.offset + e.length <= value.length,
  );
  for (const e of entities) {
    cuts.add(e.offset);
    cuts.add(e.offset + e.length);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const parts: TextPart[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1];
    const part: TextPart = { text: value.slice(start, end) };
    for (const e of entities) {
      if (e.offset > start || e.offset + e.length < end) continue;
      switch (e.type?.['@type']) {
        case 'textEntityTypeBold':
          part.bold = true;
          break;
        case 'textEntityTypeItalic':
          part.italic = true;
          break;
        case 'textEntityTypeUnderline':
          part.underline = true;
          break;
        case 'textEntityTypeStrikethrough':
          part.strike = true;
          break;
        case 'textEntityTypeCode':
          part.code = true;
          break;
        case 'textEntityTypePre':
        case 'textEntityTypePreCode':
          part.pre = true;
          break;
        case 'textEntityTypeSpoiler':
          part.spoiler = true;
          break;
        case 'textEntityTypeUrl':
          part.url = /^https?:\/\//i.test(part.text) ? part.text : `https://${part.text}`;
          break;
        case 'textEntityTypeTextUrl':
          part.url = e.type.url;
          break;
        case 'textEntityTypeEmailAddress':
          part.url = `mailto:${part.text}`;
          break;
      }
    }
    parts.push(part);
  }
  return parts;
}

// Telegram's voice waveform: 5-bit loudness values packed little-endian.
export function packWaveform(values: number[]) {
  const bytes = new Uint8Array(Math.ceil((values.length * 5) / 8));
  values.forEach((value, i) => {
    const v = Math.max(0, Math.min(31, Math.round(value)));
    const bit = i * 5,
      at = bit >> 3,
      shift = bit & 7;
    bytes[at] |= (v << shift) & 0xff;
    if (shift > 3) bytes[at + 1] |= v >> (8 - shift);
  });
  return btoa(String.fromCharCode(...bytes));
}
export function unpackWaveform(base64: string | undefined): number[] {
  if (!base64) return [];
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return [];
  }
  const count = Math.floor((bytes.length * 8) / 5);
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const bit = i * 5,
      at = bit >> 3,
      shift = bit & 7;
    const word = bytes[at] | ((bytes[at + 1] ?? 0) << 8);
    values.push((word >> shift) & 31);
  }
  return values;
}
