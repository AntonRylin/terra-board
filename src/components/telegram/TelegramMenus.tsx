// What right-clicking a chat or a message offers in a Telegram frame, as in
// Telegram's own apps (what TDLib allows for each), plus the dialogs they open:
// confirming, forwarding to a chat, and the chat folder tabs.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  Ban,
  BellOff,
  BellRing,
  Copy,
  Eraser,
  Forward,
  ImagePlus,
  Link,
  LogOut,
  MailOpen,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Search,
  FolderOpen,
  Trash2,
  Type,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { MenuItem } from '../Dialogs';
import type { TelegramFrameActions } from './TelegramCard';
import { chatOf, downloadNow, myUserId, telegramBridge, useTelegram } from './telegram-store';
import {
  chatListOf,
  isChannel,
  mainPosition,
  messageFile,
  privateUserId,
  sortedChats,
  type ListName,
  type Td,
  type TdChat,
  type TdMessage,
  type TdText,
} from './td';
import { Avatar, chatTitle } from './TelegramChats';

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

/** A question before something that can't be undone. */
export interface Confirm {
  title: string;
  text: string;
  /** An option such as "Also delete for Maria". */
  check?: string;
  checked?: boolean;
  action: string;
  run: (checked: boolean) => Promise<unknown>;
}
/** What the menus need from the frame they are in. */
export interface ChatTools {
  actions: TelegramFrameActions;
  confirm: (confirm: Confirm) => void;
  forward: (message: TdMessage) => void;
  /** A short message over the frame (a bot's answer, "Copied"). */
  notice: (text: string) => void;
}

const run = (tools: ChatTools, query: Td) =>
  void telegramBridge()
    ?.invoke(query)
    .catch((e) => tools.actions.onError(message(e)));
const copyText = (text: string) =>
  void (window.canvas ? window.canvas.copyText(text) : navigator.clipboard.writeText(text)).catch(
    () => {},
  );

const muteFor = (chat: TdChat, seconds: number): Td => ({
  '@type': 'setChatNotificationSettings',
  chat_id: chat.id,
  notification_settings: {
    ...(chat.notification_settings || {}),
    '@type': 'chatNotificationSettings',
    use_default_mute_for: false,
    mute_for: seconds,
  },
});

// Menus as groups of items, absent ones left out, with dividers between
// groups only.
export function menuGroups(groups: (MenuItem | null | false | undefined | 0 | '')[][]) {
  const result: (MenuItem | null)[] = [];
  for (const group of groups) {
    const items = group.filter(Boolean) as MenuItem[];
    if (!items.length) continue;
    if (result.length) result.push(null);
    result.push(...items);
  }
  return result;
}

/** Right-click on a chat in the list. */
export function chatMenu(chat: TdChat, list: ListName, tools: ChatTools): (MenuItem | null)[] {
  const pinned = !!mainPosition(chat, list)?.is_pinned;
  const archived = !!mainPosition(chat, 'archive');
  const muted = (chat.notification_settings?.mute_for ?? 0) > 0;
  const unread = chat.unread_count > 0 || chat.is_marked_as_unread;
  const userId = privateUserId(chat);
  const self = userId && userId === myUserId();
  const title = chatTitle(chat);
  const blocked = chat.block_list?.['@type'] === 'blockListMain';
  return menuGroups([
    [
      {
        label: pinned ? 'Unpin' : 'Pin',
        icon: pinned ? <PinOff /> : <Pin />,
        action: () =>
          run(tools, {
            '@type': 'toggleChatIsPinned',
            chat_list: chatListOf(list),
            chat_id: chat.id,
            is_pinned: !pinned,
          }),
      },
      self
        ? null
        : {
            label: archived ? 'Unarchive' : 'Archive',
            icon: archived ? <ArchiveRestore /> : <Archive />,
            action: () =>
              run(tools, {
                '@type': 'addChatToList',
                chat_id: chat.id,
                chat_list: { '@type': archived ? 'chatListMain' : 'chatListArchive' },
              }),
          },
      ...(muted
        ? [{ label: 'Unmute', icon: <BellRing />, action: () => run(tools, muteFor(chat, 0)) }]
        : self
          ? []
          : [
              {
                label: 'Mute for 1 hour',
                icon: <BellOff />,
                action: () => run(tools, muteFor(chat, 3600)),
              },
              {
                label: 'Mute for 8 hours',
                icon: <BellOff />,
                action: () => run(tools, muteFor(chat, 8 * 3600)),
              },
              {
                label: 'Mute for 2 days',
                icon: <BellOff />,
                action: () => run(tools, muteFor(chat, 2 * 86400)),
              },
              {
                label: 'Mute until I turn it back on',
                icon: <BellOff />,
                action: () => run(tools, muteFor(chat, 2147483647)),
              },
            ]),
      unread
        ? {
            label: 'Mark as read',
            icon: <MailOpen />,
            action: () => {
              if (chat.last_message)
                run(tools, {
                  '@type': 'viewMessages',
                  chat_id: chat.id,
                  message_ids: [chat.last_message.id],
                  source: { '@type': 'messageSourceChatList' },
                  force_read: true,
                });
              if (chat.is_marked_as_unread)
                run(tools, {
                  '@type': 'toggleChatIsMarkedAsUnread',
                  chat_id: chat.id,
                  is_marked_as_unread: false,
                });
              if (chat.unread_mention_count)
                run(tools, { '@type': 'readAllChatMentions', chat_id: chat.id });
            },
          }
        : {
            label: 'Mark as unread',
            icon: <Mail />,
            action: () =>
              run(tools, {
                '@type': 'toggleChatIsMarkedAsUnread',
                chat_id: chat.id,
                is_marked_as_unread: true,
              }),
          },
    ],
    [
      {
        label: 'Clear history',
        icon: <Eraser />,
        action: () =>
          tools.confirm({
            title: 'Clear history',
            text: `Delete all messages in ${title}? This can't be undone.`,
            check:
              userId && !self && chat.can_be_deleted_for_all_users
                ? `Also clear for ${title}`
                : undefined,
            action: 'Clear',
            run: (revoke) =>
              telegramBridge()!.invoke({
                '@type': 'deleteChatHistory',
                chat_id: chat.id,
                remove_from_chat_list: false,
                revoke,
              }),
          }),
      },
      userId
        ? {
            label: 'Delete chat',
            icon: <Trash2 />,
            danger: true,
            action: () =>
              tools.confirm({
                title: 'Delete chat',
                text: `Delete the chat with ${title}? This can't be undone.`,
                check:
                  !self && chat.can_be_deleted_for_all_users
                    ? `Also delete for ${title}`
                    : undefined,
                action: 'Delete',
                run: (revoke) =>
                  telegramBridge()!.invoke({
                    '@type': 'deleteChatHistory',
                    chat_id: chat.id,
                    remove_from_chat_list: true,
                    revoke,
                  }),
              }),
          }
        : {
            label: isChannel(chat) ? 'Leave channel' : 'Leave group',
            icon: <LogOut />,
            danger: true,
            action: () =>
              tools.confirm({
                title: isChannel(chat) ? 'Leave channel' : 'Leave group',
                text: `Leave ${title}?`,
                action: 'Leave',
                run: () => telegramBridge()!.invoke({ '@type': 'leaveChat', chat_id: chat.id }),
              }),
          },
      userId && !self
        ? {
            label: blocked ? 'Unblock' : 'Block',
            icon: <Ban />,
            danger: !blocked,
            action: () => {
              const set = () =>
                telegramBridge()!.invoke({
                  '@type': 'setMessageSenderBlockList',
                  sender_id: { '@type': 'messageSenderUser', user_id: userId },
                  block_list: blocked ? null : { '@type': 'blockListMain' },
                });
              if (blocked) void set().catch((e) => tools.actions.onError(message(e)));
              else
                tools.confirm({
                  title: 'Block',
                  text: `Block ${title}? They won't be able to message or call you.`,
                  action: 'Block',
                  run: set,
                });
            },
          }
        : null,
    ],
  ]);
}

const emojiOf = (reaction: Td) =>
  reaction?.['@type'] === 'reactionTypeEmoji' ? (reaction.emoji as string) : '';
/** An emoji drawn in color: symbols like ❤ need the emoji presentation selector. */
export const shownEmoji = (emoji: string) =>
  [...emoji].length === 1 && emoji.codePointAt(0)! < 0x2c00 ? emoji + '\uFE0F' : emoji;
/** One reaction under a message: an emoji, a custom emoji or paid stars. */
export interface Reaction {
  key: string;
  /** TDLib's ReactionType, as sent back to add or remove it. */
  type: Td;
  /** The emoji; for a custom emoji, empty (its picture comes by `customId`). */
  emoji: string;
  customId?: string;
  paid: boolean;
  count: number;
  chosen: boolean;
  /** Who reacted lately (MessageSender), newest first. */
  senders: Td[];
}
const reactionKey = (type: Td) =>
  type?.['@type'] === 'reactionTypeEmoji'
    ? (type.emoji as string)
    : type?.['@type'] === 'reactionTypeCustomEmoji'
      ? `custom:${type.custom_emoji_id}`
      : type?.['@type'] === 'reactionTypePaid'
        ? 'paid'
        : '';
/** The reactions on a message, as Telegram shows them under it. */
export function reactionsOf(m: TdMessage): Reaction[] {
  return ((m.interaction_info?.reactions?.reactions || []) as Td[])
    .map((r) => ({
      key: reactionKey(r.type),
      type: r.type,
      emoji: emojiOf(r.type),
      customId:
        r.type?.['@type'] === 'reactionTypeCustomEmoji' ? String(r.type.custom_emoji_id) : undefined,
      paid: r.type?.['@type'] === 'reactionTypePaid',
      count: r.total_count as number,
      chosen: !!r.is_chosen,
      senders: (r.recent_sender_ids || []) as Td[],
    }))
    .filter((r) => r.key && r.count > 0);
}
/** Adds this account's reaction, or takes it back. Paid stars are sent from Telegram's apps. */
export function toggleReaction(m: TdMessage, type: Td, tools: ChatTools) {
  const key = reactionKey(type);
  if (!key || type['@type'] === 'reactionTypePaid') return;
  const chosen = reactionsOf(m).some((r) => r.key === key && r.chosen);
  run(tools, {
    '@type': chosen ? 'removeMessageReaction' : 'addMessageReaction',
    chat_id: m.chat_id,
    message_id: m.id,
    reaction_type: type,
    ...(!chosen && { is_big: false, update_recent_reactions: true }),
  });
}

/** Right-click on a message: asks TDLib what it allows, then opens the menu. */
export async function openMessageMenu(
  m: TdMessage,
  event: MouseEvent,
  tools: ChatTools & {
    reply?: () => void;
    edit?: () => void;
  },
) {
  event.preventDefault();
  event.stopPropagation();
  const { clientX: x, clientY: y } = event;
  const bridge = telegramBridge();
  if (!bridge) return;
  const [properties, available] = await Promise.all([
    bridge
      .invoke<Td>({ '@type': 'getMessageProperties', chat_id: m.chat_id, message_id: m.id })
      .catch(() => ({}) as Td),
    bridge
      .invoke<Td>({
        '@type': 'getMessageAvailableReactions',
        chat_id: m.chat_id,
        message_id: m.id,
        row_size: 8,
      })
      .catch(() => null),
  ]);
  const p = properties as Td;
  const c = m.content || {};
  const text: TdText | undefined = c['@type'] === 'messageText' ? c.text : c.caption;
  const plain = text?.text || '';
  const info = messageFile(m);
  const chat = chatOf(m.chat_id);
  const title = chat ? chatTitle(chat) : '';
  const seen = new Set<string>();
  const emojis = available
    ? ([...(available.top_reactions || []), ...(available.recent_reactions || [])] as Td[])
        .filter((r) => !r.needs_premium)
        .map((r) => emojiOf(r.type))
        .filter((e) => e && !seen.has(e) && seen.add(e))
        .slice(0, 8)
    : [];
  const items = menuGroups([
    [
      p.can_be_replied !== false && tools.reply
        ? { label: 'Reply', icon: <Reply />, action: tools.reply }
        : null,
      p.can_be_edited && tools.edit
        ? { label: 'Edit', icon: <Pencil />, action: tools.edit }
        : null,
      plain ? { label: 'Copy text', icon: <Copy />, action: () => copyText(plain) } : null,
      p.can_get_link
        ? {
            label: 'Copy message link',
            icon: <Link />,
            action: () =>
              void bridge
                .invoke<Td>({ '@type': 'getMessageLink', chat_id: m.chat_id, message_id: m.id })
                .then((l) => copyText(l.link))
                .catch((e) => tools.actions.onError(message(e))),
          }
        : null,
      p.can_be_forwarded
        ? { label: 'Forward', icon: <Forward />, action: () => tools.forward(m) }
        : null,
      p.can_be_pinned
        ? {
            label: m.is_pinned ? 'Unpin' : 'Pin',
            icon: m.is_pinned ? <PinOff /> : <Pin />,
            action: () =>
              run(
                tools,
                m.is_pinned
                  ? { '@type': 'unpinChatMessage', chat_id: m.chat_id, message_id: m.id }
                  : {
                      '@type': 'pinChatMessage',
                      chat_id: m.chat_id,
                      message_id: m.id,
                      disable_notification: false,
                      only_for_self: false,
                    },
              ),
          }
        : null,
    ],
    [
      info && tools.actions.addFiles
        ? {
            label: 'Add to the board',
            icon: <ImagePlus />,
            action: () =>
              void downloadNow(info.file)
                .then((path) => tools.actions.addFiles!([{ path, name: info.name }]))
                .catch((e) => tools.actions.onError(message(e))),
          }
        : null,
      plain && !info && tools.actions.addText
        ? {
            label: 'Add text to the board',
            icon: <Type />,
            action: () => tools.actions.addText!(plain),
          }
        : null,
      info
        ? {
            label: 'Show in folder',
            icon: <FolderOpen />,
            action: () =>
              void downloadNow(info.file)
                .then((path) => window.canvas?.files?.reveal({ path }))
                .catch((e) => tools.actions.onError(message(e))),
          }
        : null,
    ],
    [
      p.can_be_deleted_only_for_self || p.can_be_deleted_for_all_users
        ? {
            label: 'Delete',
            icon: <Trash2 />,
            danger: true,
            action: () =>
              tools.confirm({
                title: 'Delete message',
                text: 'Delete this message?',
                check:
                  p.can_be_deleted_only_for_self && p.can_be_deleted_for_all_users
                    ? `Also delete for ${chat && privateUserId(chat) ? title : 'everyone'}`
                    : undefined,
                checked: true,
                action: 'Delete',
                run: (forAll) =>
                  bridge.invoke({
                    '@type': 'deleteMessages',
                    chat_id: m.chat_id,
                    message_ids: [m.id],
                    revoke: p.can_be_deleted_only_for_self ? forAll : true,
                  }),
              }),
          }
        : null,
    ],
  ]);
  const chosen = new Set(
    reactionsOf(m)
      .filter((r) => r.chosen)
      .map((r) => r.emoji),
  );
  const header: ReactNode = emojis.length ? (
    <div className="tg-menu-reactions">
      {emojis.map((emoji) => (
        <button
          key={emoji}
          data-chosen={chosen.has(emoji) || undefined}
          title={emoji}
          onClick={() => {
            tools.actions.openMenu(null);
            toggleReaction(m, { '@type': 'reactionTypeEmoji', emoji }, tools);
          }}
        >
          {shownEmoji(emoji)}
        </button>
      ))}
    </div>
  ) : undefined;
  tools.actions.openMenu({ x, y, items, header });
}

export function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const [checked, setChecked] = useState(!!confirm.checked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    try {
      await confirm.run(checked);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="tg-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="tg-dialog"
        role="alertdialog"
        aria-label={confirm.title}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) onClose();
        }}
      >
        <h3>{confirm.title}</h3>
        <p>{confirm.text}</p>
        {confirm.check && (
          <label className="tg-dialog-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            {confirm.check}
          </label>
        )}
        {error && <p className="tg-error">{error}</p>}
        <div className="tg-dialog-actions">
          <span />
          <button className="tg-link" disabled={busy} onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className="tg-link strong danger" disabled={busy} onClick={() => void go()}>
            {confirm.action}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Forwarding a message: pick the chat it goes to. */
export function ForwardDialog({
  message: m,
  onClose,
  onSent,
}: {
  message: TdMessage;
  onClose: () => void;
  onSent: (chatId: number) => void;
}) {
  const { chats } = useTelegram();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const list = sortedChats(chats.values())
    .map(({ chat }) => chat)
    .filter((chat) => !q || chatTitle(chat).toLowerCase().includes(q))
    .slice(0, 60);
  const send = async (chatId: number) => {
    try {
      await telegramBridge()!.invoke({
        '@type': 'forwardMessages',
        chat_id: chatId,
        from_chat_id: m.chat_id,
        message_ids: [m.id],
        send_copy: false,
        remove_caption: false,
      });
      onSent(chatId);
      onClose();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div
      className="tg-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="tg-dialog tg-forward"
        role="dialog"
        aria-label="Forward to"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        <h3>Forward to…</h3>
        <label className="tg-search">
          <Search size={15} />
          <input
            ref={field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
          />
        </label>
        <div className="tg-forward-list">
          {list.map((chat) => (
            <button key={chat.id} className="tg-forward-chat" onClick={() => void send(chat.id)}>
              <Avatar id={chat.id} title={chatTitle(chat)} photo={chat.photo} size={34} />
              <span>{chatTitle(chat)}</span>
            </button>
          ))}
          {!list.length && <p className="tg-list-empty">No chats match.</p>}
        </div>
        {error && <p className="tg-error">{error}</p>}
        <div className="tg-dialog-actions">
          <span />
          <button className="tg-link" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Folder tabs over the chat list: all chats, the person's folders, the archive. */
export function FolderTabs({ list, onList }: { list: ListName; onList: (list: ListName) => void }) {
  const { folders } = useTelegram();
  const tabs: { name: ListName; label: string }[] = [
    { name: 'main', label: 'All chats' },
    ...folders.map((f) => ({ name: `folder:${f.id}`, label: f.name || 'Folder' })),
    { name: 'archive', label: 'Archived' },
  ];
  return (
    <div className="tg-tabs" role="tablist" onPointerDown={(e) => e.stopPropagation()}>
      {tabs.map((tab) => (
        <button
          key={tab.name}
          role="tab"
          aria-selected={tab.name === list}
          data-active={tab.name === list || undefined}
          onClick={() => onList(tab.name)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
