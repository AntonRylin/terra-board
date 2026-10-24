// A signed-in Telegram frame: the chat list and the open chat, with sending,
// files, and drag and drop between chats, the board and other apps.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  BellOff as BellOffIcon,
  Download,
  File as FileIcon,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  MapPin,
  Mic,
  Paperclip,
  Pause,
  Phone,
  PhoneMissed,
  Pin,
  Play,
  Video as VideoIcon,
  Search,
  SendHorizontal,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type { Camera, CanvasObject } from '../../model';
import type { TelegramFrameActions } from './TelegramCard';
import {
  ConfirmDialog,
  FolderTabs,
  ForwardDialog,
  chatMenu,
  openMessageMenu,
  reactionsOf,
  shownEmoji,
  toggleReaction,
  type ChatTools,
  type Confirm,
} from './TelegramMenus';
import {
  chatOf,
  downloadNow,
  fileOf,
  historyOf,
  loadOlder,
  myUserId,
  pinnedVersion,
  telegramBridge,
  useTelegram,
  userOf,
  viewMessages,
  want,
} from './telegram-store';
import {
  avatarColor,
  dayLabel,
  duration,
  fileUrl,
  formatBytes,
  initials,
  isChannel,
  isGroup,
  isService,
  listDate,
  messageFile,
  messageSummary,
  messageTime,
  privateUserId,
  chatListOf,
  sortedChats,
  textParts,
  type ListName,
  packWaveform,
  unpackWaveform,
  userName,
  type StagedFile,
  type Td,
  type TdChat,
  type TdFile,
  type TdMessage,
  type TdText,
} from './td';
import { receiveTelegramDrops, telegramFileType, type TelegramSource } from './telegram-drop';

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
const rowHeight = 64;
const chatKey = (id: string) => `terra-board.telegram-chat:${id}`;
const readChoice = (id: string) => {
  try {
    return Number(localStorage.getItem(chatKey(id))) || 0;
  } catch {
    return 0;
  }
};
const saveChoice = (id: string, chat: number) => {
  try {
    if (chat) localStorage.setItem(chatKey(id), String(chat));
    else localStorage.removeItem(chatKey(id));
  } catch {
    /* Not remembered. */
  }
};

// Chat lists (all chats, folders, the archive) load in pages as they scroll.
const listLoading = new Map<ListName, Promise<void>>();
const listComplete = new Set<ListName>();
function loadChats(list: ListName = 'main', limit = 100) {
  const bridge = telegramBridge();
  if (!bridge || listComplete.has(list)) return Promise.resolve();
  if (!listLoading.has(list))
    listLoading.set(
      list,
      bridge
        .invoke({ '@type': 'loadChats', chat_list: chatListOf(list), limit })
        .then(() => undefined)
        .catch((error: { message?: string }) => {
          // 404: every chat is loaded.
          if (/404|not found/i.test(String(error?.message))) listComplete.add(list);
        })
        .finally(() => listLoading.delete(list)),
    );
  return listLoading.get(list)!;
}
/** A chat's name; your own chat is Saved Messages, as in Telegram. */
export const chatTitle = (chat: TdChat) =>
  privateUserId(chat) && privateUserId(chat) === myUserId()
    ? 'Saved Messages'
    : chat.title || 'Deleted account';

export function TelegramChats({
  object: o,
  camera,
  actions,
}: {
  object: CanvasObject;
  camera: Camera;
  actions: TelegramFrameActions;
}) {
  const [selected, setSelected] = useState(() => readChoice(o.id));
  const { chats } = useTelegram();
  // Files dropped on a chat, waiting in its send dialog.
  const [incoming, setIncoming] = useState<{
    chatId: number;
    files: StagedFile[];
    key: number;
  } | null>(null);
  const openChat = useRef(0);
  const [list, setList] = useState<ListName>('main');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [forwarding, setForwarding] = useState<TdMessage | null>(null);
  const tools: ChatTools = {
    actions,
    confirm: setConfirm,
    forward: setForwarding,
  };
  useEffect(() => {
    listComplete.delete(list);
    void loadChats(list);
  }, [list]);
  const choose = (id: number) => {
    setSelected(id);
    saveChoice(o.id, id);
  };
  // Files for a chat (dropped on it in the list or in the open chat, or from
  // the board): that chat opens with them in its send dialog.
  const deliver = useCallback(async (chatId: number, sources: TelegramSource[]) => {
    try {
      const files = await telegramBridge()!.stage(sources);
      if (!files.length) return;
      choose(chatId);
      setIncoming({ chatId, files, key: Date.now() });
    } catch (e) {
      actions.onError(message(e));
    }
  }, []);
  useEffect(
    () =>
      receiveTelegramDrops(o.id, (sources, x, y) => {
        const chatId = chatAt(o.id, x, y) || openChat.current;
        if (chatId) void deliver(chatId, sources);
        else actions.onError('Drop the files onto a chat.');
      }),
    [o.id],
  );
  const height = o.height - 48;
  const wide = o.width >= 640;
  const listWidth = wide ? Math.round(Math.min(340, Math.max(240, o.width * 0.36))) : o.width;
  const open = selected && chats.has(selected) ? selected : 0;
  openChat.current = open;
  return (
    <div className="tg-chats" style={{ height }}>
      {(wide || !open) && (
        <ChatList
          width={listWidth}
          height={height}
          selected={open}
          zoom={camera.zoom}
          list={list}
          onList={setList}
          onMenu={(chat, event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.openMenu({
              x: event.clientX,
              y: event.clientY,
              items: chatMenu(chat, list, tools),
            });
          }}
          onSelect={choose}
          onFiles={(chatId, paths) =>
            void deliver(
              chatId,
              paths.map((path) => ({ path })),
            )
          }
        />
      )}
      {open ? (
        <Conversation
          key={open}
          frameId={o.id}
          chatId={open}
          zoom={camera.zoom}
          frameWidth={o.width}
          onBack={wide ? undefined : () => choose(0)}
          actions={actions}
          incoming={incoming?.chatId === open ? incoming : null}
          onFiles={(sources) => void deliver(open, sources)}
          onIncomingTaken={() => setIncoming(null)}
          tools={tools}
        />
      ) : (
        wide && (
          <div className="tg-empty">
            <p>Choose a chat</p>
          </div>
        )
      )}
      {confirm && <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />}
      {forwarding && (
        <ForwardDialog
          message={forwarding}
          onClose={() => setForwarding(null)}
          onSent={(chatId) => choose(chatId)}
        />
      )}
    </div>
  );
}

// The chat in the list under a screen point, in one frame.
function chatAt(frameId: string, x: number, y: number) {
  for (const element of document.elementsFromPoint(x, y)) {
    const row = (element as HTMLElement).closest<HTMLElement>('.tg-chat[data-chat-id]');
    if (row && row.closest(`.canvas-telegram[data-file-id="${CSS.escape(frameId)}"]`))
      return Number(row.dataset.chatId) || 0;
  }
  return 0;
}
// Files from Explorer or folder frames (not Telegram's own being dragged out).
const draggingFiles = (event: DragEvent) =>
  event.dataTransfer.types.includes('Files') &&
  !event.dataTransfer.types.includes(telegramFileType);
const droppedPaths = (event: DragEvent) =>
  [...event.dataTransfer.files].map((file) => window.canvas?.filePath(file) || '').filter(Boolean);

export function Avatar({
  id,
  title,
  photo,
  size,
}: {
  id: number;
  title: string;
  photo?: { small: TdFile; minithumbnail?: { data: string } };
  size: number;
}) {
  useTelegram();
  const file = photo ? fileOf(photo.small) : null;
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (photo) want(photo.small, 4);
  }, [photo?.small.id]);
  const picture = file?.local.is_downloading_completed
    ? fileUrl(file)
    : photo?.minithumbnail
      ? `data:image/jpeg;base64,${photo.minithumbnail.data}`
      : null;
  const src = picture && picture !== failed ? picture : null;
  return (
    <span
      className="tg-avatar"
      style={{ width: size, height: size, background: avatarColor(id), fontSize: size * 0.38 }}
    >
      {src ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />
      ) : (
        initials(title)
      )}
    </span>
  );
}

const muted = (chat: TdChat) => (chat.notification_settings?.mute_for ?? 0) > 0;

const ChatRow = memo(function ChatRow({
  chat,
  pinned,
  active,
  onSelect,
  onFiles,
  onMenu,
}: {
  chat: TdChat;
  pinned: boolean;
  active: boolean;
  onSelect: (id: number) => void;
  onFiles: (chatId: number, paths: string[]) => void;
  onMenu: (chat: TdChat, event: React.MouseEvent) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const last = chat.last_message;
  let prefix = '';
  if (last?.is_outgoing && !isChannel(chat)) prefix = 'You: ';
  else if (last && isGroup(chat) && last.sender_id?.['@type'] === 'messageSenderUser')
    prefix = `${userOf(last.sender_id.user_id)?.first_name || ''}: `.replace(/^: $/, '');
  const unread = chat.unread_count || (chat.is_marked_as_unread ? 1 : 0);
  const outgoingRead = last?.is_outgoing && last.id <= chat.last_read_outbox_message_id;
  return (
    <button
      className="tg-chat"
      data-chat-id={chat.id}
      data-active={active || undefined}
      data-dropping={dropping || undefined}
      style={{ height: rowHeight }}
      onClick={() => onSelect(chat.id)}
      onContextMenu={(event) => onMenu(chat, event)}
      onDragOver={(event) => {
        if (!draggingFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        if (!draggingFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const paths = droppedPaths(event);
        if (paths.length) onFiles(chat.id, paths);
      }}
    >
      <Avatar id={chat.id} title={chatTitle(chat)} photo={chat.photo} size={46} />
      <span className="tg-chat-text">
        <span className="tg-chat-top">
          <span className="tg-chat-title">{chatTitle(chat)}</span>
          {(chat.notification_settings?.mute_for ?? 0) > 0 && (
            <BellOffIcon size={12} className="tg-muted-icon" />
          )}
          {last?.is_outgoing &&
            (outgoingRead ? (
              <CheckCheck size={14} className="tg-tick" />
            ) : (
              <Check size={14} className="tg-tick" />
            ))}
          <span className="tg-chat-date">{listDate(last?.date || 0)}</span>
        </span>
        <span className="tg-chat-bottom">
          <span className="tg-chat-last">
            {chat.draft_message ? (
              <>
                <em>Draft: </em>
                {chat.draft_message.input_message_text?.text?.text}
              </>
            ) : (
              prefix + messageSummary(last)
            )}
          </span>
          {chat.unread_mention_count > 0 && <span className="tg-badge mention">@</span>}
          {unread > 0 ? (
            <span className="tg-badge" data-muted={muted(chat) || undefined}>
              {unread > 999 ? `${Math.floor(unread / 1000)}K` : unread}
            </span>
          ) : (
            pinned && <Pin size={13} className="tg-pin" />
          )}
        </span>
      </span>
    </button>
  );
});

function ChatList({
  width,
  height,
  selected,
  zoom,
  list: listName,
  onList,
  onMenu,
  onSelect,
  onFiles,
}: {
  width: number;
  height: number;
  selected: number;
  zoom: number;
  list: ListName;
  onList: (list: ListName) => void;
  onMenu: (chat: TdChat, event: React.MouseEvent) => void;
  onSelect: (id: number) => void;
  onFiles: (chatId: number, paths: string[]) => void;
}) {
  const { chats } = useTelegram();
  const [query, setQuery] = useState('');
  const [scroll, setScroll] = useState(0);
  // Chats change in place, so this is worked out on every update (it is quick).
  const all = sortedChats(chats.values(), listName);
  const q = query.trim().toLowerCase();
  const list = q ? all.filter(({ chat }) => chatTitle(chat).toLowerCase().includes(q)) : all;
  const viewport = height - 52 - 36;
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 4);
  const last = Math.min(list.length, Math.ceil((scroll + viewport) / rowHeight) + 4);
  return (
    <div className="tg-list" style={{ width, height }}>
      <FolderTabs list={listName} onList={onList} />
      <label className="tg-search" onPointerDown={(e) => e.stopPropagation()}>
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats"
          spellCheck={false}
        />
        {query && (
          <button aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={14} />
          </button>
        )}
      </label>
      <div
        className="tg-list-scroll"
        style={{ height: viewport }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          if (el.scrollTop + el.clientHeight > el.scrollHeight - rowHeight * 10)
            void loadChats(listName);
        }}
      >
        <div style={{ height: list.length * rowHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>
            {list.slice(first, last).map(({ chat, pinned }) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                pinned={pinned}
                active={chat.id === selected}
                onSelect={onSelect}
                onFiles={onFiles}
                onMenu={onMenu}
              />
            ))}
          </div>
        </div>
        {!list.length && (
          <p className="tg-list-empty">
            {query
              ? 'No chats match.'
              : listComplete.has(listName)
                ? listName === 'archive'
                  ? 'No archived chats.'
                  : 'No chats here.'
                : 'Loading chats…'}
          </p>
        )}
      </div>
      {zoom < 0.5 && <div className="tg-zoom-hint">Zoom in to read</div>}
    </div>
  );
}

// Whether the open chat is on screen and Terra is in front, so its messages
// count as seen.
function onScreen(element: HTMLElement | null, zoom: number, width: number) {
  if (!element || document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  if (width * zoom < 280) return false;
  const r = element.getBoundingClientRect();
  return r.bottom > 40 && r.right > 40 && r.top < innerHeight - 40 && r.left < innerWidth - 40;
}

function Conversation({
  frameId,
  chatId,
  zoom,
  frameWidth,
  onBack,
  actions,
  incoming,
  onFiles,
  onIncomingTaken,
  tools,
}: {
  frameId: string;
  chatId: number;
  zoom: number;
  frameWidth: number;
  onBack?: () => void;
  actions: TelegramFrameActions;
  incoming: { files: StagedFile[]; key: number } | null;
  onFiles: (sources: TelegramSource[]) => void;
  onIncomingTaken: () => void;
  tools: ChatTools;
}) {
  const bridge = telegramBridge()!;
  useTelegram();
  const chat = chatOf(chatId)!;
  const history = historyOf(chatId);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const previous = useRef({ first: 0, height: 0 });
  const [sponsored, setSponsored] = useState<Td | null>(null);
  const [canPost, setCanPost] = useState(!isChannel(chat));
  const [replyTo, setReplyTo] = useState<TdMessage | null>(null);
  const [editing, setEditing] = useState<TdMessage | null>(null);
  // The chat's pinned message, in a bar under its name.
  const [pinned, setPinned] = useState<TdMessage | null>(null);
  const pins = pinnedVersion(chatId);
  useEffect(() => {
    let live = true;
    void bridge
      .invoke<TdMessage>({ '@type': 'getChatPinnedMessage', chat_id: chatId })
      .then((m) => live && setPinned(m))
      .catch(() => live && setPinned(null));
    return () => {
      live = false;
    };
  }, [chatId, pins]);
  // Files waiting in the send dialog.
  const [sending, setSending] = useState<StagedFile[] | null>(null);
  const [dropping, setDropping] = useState(false);
  const [sendError, setSendError] = useState('');

  useEffect(() => {
    void bridge.invoke({ '@type': 'openChat', chat_id: chatId }).catch(() => {});
    if (!history.ids.length) void loadOlder(chatId);
    // Channels and bots may carry Telegram's sponsored messages, which
    // clients must show.
    if (isChannel(chat) || chat.type?.['@type'] === 'chatTypePrivate')
      void bridge
        .invoke<{ messages: Td[] }>({ '@type': 'getChatSponsoredMessages', chat_id: chatId })
        .then((r) => setSponsored(r.messages?.[0] ?? null))
        .catch(() => {});
    if (isChannel(chat))
      void bridge
        .invoke<Td>({ '@type': 'getSupergroup', supergroup_id: chat.type.supergroup_id })
        .then((group) => {
          const s = group.status || {};
          setCanPost(
            s['@type'] === 'chatMemberStatusCreator' ||
              (s['@type'] === 'chatMemberStatusAdministrator' && !!s.rights?.can_post_messages),
          );
        })
        .catch(() => setCanPost(false));
    return () => {
      void bridge.invoke({ '@type': 'closeChat', chat_id: chatId }).catch(() => {});
    };
  }, [chatId]);

  // Files dropped while the dialog is open join the ones already there.
  useEffect(() => {
    if (!incoming) return;
    if (canPost) setSending((current) => [...(current || []), ...incoming.files].slice(0, 20));
    else actions.onError('You can’t send files to this chat.');
    onIncomingTaken();
  }, [incoming?.key]);
  const pick = async () => {
    try {
      const picked = await bridge.pick();
      if (picked.length) setSending((current) => [...(current || []), ...picked].slice(0, 20));
    } catch (e) {
      actions.onError(message(e));
    }
  };

  const ids = history.ids;
  const lastId = ids[ids.length - 1] || 0;
  // Seen while on screen: incoming messages up to the newest.
  useEffect(() => {
    const check = () => {
      if (!onScreen(scroller.current, zoom, frameWidth)) return;
      const current = chatOf(chatId);
      if (!current) return;
      const unseen = ids.filter((id) => id > current.last_read_inbox_message_id).slice(-50);
      if (unseen.length || current.is_marked_as_unread)
        viewMessages(chatId, unseen.length ? unseen : [lastId]);
      if (sponsored && stick.current) viewMessages(chatId, [sponsored.message_id]);
    };
    check();
    const timer = setInterval(check, 1500);
    return () => clearInterval(timer);
  }, [chatId, lastId, zoom, frameWidth, sponsored]);

  // Older messages added above keep what was on screen in place; at the
  // bottom, the newest stays in view (also as pictures load).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = ids[0] || 0;
    const before = previous.current;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (before.first && first && first < before.first)
      el.scrollTop += el.scrollHeight - before.height;
    previous.current = { first, height: el.scrollHeight };
  });
  useEffect(() => {
    const el = scroller.current,
      inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      previous.current.height = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (el.scrollTop < 400 && !history.loading && !history.complete) void loadOlder(chatId);
  };

  const messages = ids.map((id) => history.messages.get(id)!).filter(Boolean);
  const title = chatTitle(chat);
  const user = privateUserId(chat) ? userOf(privateUserId(chat)) : undefined;
  const subtitle = isChannel(chat)
    ? 'Channel'
    : isGroup(chat)
      ? 'Group'
      : user?.type?.['@type'] === 'userTypeBot'
        ? 'Bot'
        : statusText(user?.status);

  const dropFiles = (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const paths = droppedPaths(event);
    if (paths.length) onFiles(paths.map((path) => ({ path })));
  };

  return (
    <div
      className="tg-conversation"
      data-dropping={dropping || undefined}
      onDragOver={(event) => {
        if (!draggingFiles(event) || !canPost) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(event) => {
        if (draggingFiles(event) && canPost) dropFiles(event);
      }}
    >
      <div className="tg-chat-head" onPointerDown={(e) => e.stopPropagation()}>
        {onBack && (
          <button className="cf-button" aria-label="Back to chats" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
        )}
        <Avatar id={chat.id} title={title} photo={chat.photo} size={36} />
        <span className="tg-chat-head-text">
          <span className="tg-chat-head-title">{title}</span>
          <span className="tg-chat-head-sub">{subtitle}</span>
        </span>
      </div>
      {pinned && (
        <div className="tg-pinned-bar" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="tg-pinned-text"
            onClick={() =>
              scroller.current
                ?.querySelector(`[data-message-id="${pinned.id}"]`)
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          >
            <span className="tg-reply-name">Pinned message</span>
            <span className="tg-reply-text">{messageSummary(pinned)}</span>
          </button>
          <button
            className="cf-button"
            aria-label="Unpin"
            title="Unpin"
            onClick={() =>
              void bridge
                .invoke({ '@type': 'unpinChatMessage', chat_id: chatId, message_id: pinned.id })
                .catch((e) => actions.onError(message(e)))
            }
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div
        ref={scroller}
        className="tg-messages"
        onScroll={onScroll}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div ref={content}>
          {history.loading && !messages.length && <p className="tg-list-empty">Loading…</p>}
          {history.complete && messages.length > 0 && (
            <p className="tg-start">Beginning of the chat</p>
          )}
          {history.loading && messages.length > 0 && (
            <p className="tg-start">
              <Loader2 size={14} className="tg-spin" />
            </p>
          )}
          {messages.map((m, i) => {
            const previous = messages[i - 1];
            const newDay =
              !previous ||
              new Date(previous.date * 1000).toDateString() !==
                new Date(m.date * 1000).toDateString();
            const sameSender =
              !newDay &&
              previous &&
              !isService(previous) &&
              sender(previous) === sender(m) &&
              m.date - previous.date < 300;
            return (
              <div key={m.id} data-message-id={m.id}>
                {newDay && <div className="tg-day">{dayLabel(m.date)}</div>}
                <Bubble
                  message={m}
                  chat={chat}
                  showName={!sameSender && isGroup(chat) && !m.is_outgoing}
                  actions={actions}
                  tools={tools}
                  onReply={canPost ? () => setReplyTo(m) : undefined}
                  onEdit={() => {
                    setReplyTo(null);
                    setEditing(m);
                  }}
                />
              </div>
            );
          })}
          {sponsored && <Sponsored chatId={chatId} message={sponsored} actions={actions} />}
        </div>
      </div>
      {canPost ? (
        <Composer
          key={editing?.id || 0}
          chatId={chatId}
          editing={editing}
          clearEdit={() => setEditing(null)}
          replyTo={replyTo}
          clearReply={() => setReplyTo(null)}
          error={sendError}
          setError={setSendError}
          onSent={() => {
            stick.current = true;
          }}
          onPick={() => void pick()}
        />
      ) : (
        <div className="tg-readonly">
          {isChannel(chat)
            ? 'Only the channel’s admins post here.'
            : 'You can’t write in this chat.'}
        </div>
      )}
      {dropping && (
        <div className="tg-drop-hint">
          <ImagePlus size={28} />
          Drop to send to {title}
        </div>
      )}
      {sending && (
        <SendDialog
          title={title}
          files={sending}
          setFiles={setSending}
          onAdd={() => void pick()}
          onClose={() => setSending(null)}
          chatId={chatId}
          replyTo={replyTo?.id}
          onSent={() => {
            setReplyTo(null);
            stick.current = true;
          }}
        />
      )}
    </div>
  );
}

const sender = (m: TdMessage) =>
  m.sender_id?.['@type'] === 'messageSenderUser'
    ? `u${m.sender_id.user_id}`
    : `c${m.sender_id?.chat_id}`;
function senderName(m: TdMessage) {
  if (m.sender_id?.['@type'] === 'messageSenderUser') return userName(userOf(m.sender_id.user_id));
  return chatOf(m.sender_id?.chat_id)?.title || m.author_signature || '';
}
function statusText(status: Td | undefined) {
  switch (status?.['@type']) {
    case 'userStatusOnline':
      return 'online';
    case 'userStatusRecently':
      return 'last seen recently';
    case 'userStatusOffline':
      return status.was_online
        ? `last seen ${listDate(status.was_online)}`
        : 'last seen a while ago';
    case 'userStatusLastWeek':
      return 'last seen within a week';
    case 'userStatusLastMonth':
      return 'last seen within a month';
    default:
      return '';
  }
}

function Text({ text, onLink }: { text?: TdText; onLink: (url: string) => void }) {
  const parts = textParts(text);
  if (!parts.length) return null;
  return (
    <span className="tg-text">
      {parts.map((p, i) => {
        let node: ReactNode = p.text;
        if (p.code) node = <code>{node}</code>;
        if (p.pre) node = <pre>{node}</pre>;
        if (p.bold) node = <strong>{node}</strong>;
        if (p.italic) node = <em>{node}</em>;
        if (p.underline) node = <u>{node}</u>;
        if (p.strike) node = <s>{node}</s>;
        if (p.spoiler) node = <span className="tg-spoiler">{node}</span>;
        if (p.url) {
          const url = p.url;
          node = (
            <a
              href={url}
              onClick={(e) => {
                e.preventDefault();
                onLink(url);
              }}
            >
              {node}
            </a>
          );
        }
        return <span key={i}>{node}</span>;
      })}
    </span>
  );
}

// Programs that clicking a file must never start; they open their folder instead.
const risky =
  /\.(exe|msi|msix|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|jar|cpl|dll|appx|appxbundle|application|gadget|inf|url|iso|img|vhd|vhdx)$/i;

function useFile(file: TdFile | undefined, auto: boolean, priority = 1) {
  useTelegram();
  useEffect(() => {
    if (auto && file) want(file, priority);
  }, [file?.id, auto]);
  return file ? fileOf(file) : undefined;
}

function Progress({ file }: { file: TdFile }) {
  const total = file.size || file.expected_size;
  const done = file.local.downloaded_size;
  return (
    <span className="tg-file-progress">
      {file.local.is_downloading_active ? (
        <>
          <Loader2 size={13} className="tg-spin" /> {formatBytes(done)} of {formatBytes(total)}
        </>
      ) : (
        formatBytes(total)
      )}
    </span>
  );
}

function Visual({
  thumbnail,
  mini,
  width,
  height,
  children,
  round,
}: {
  thumbnail?: TdFile;
  mini?: { data: string };
  width: number;
  height: number;
  children?: ReactNode;
  round?: boolean;
}) {
  const thumb = useFile(thumbnail, true, 8);
  const max = 320;
  const scale = Math.min(1, max / Math.max(width || max, 1), 360 / Math.max(height || max, 1));
  const w = Math.max(120, Math.round((width || max) * scale)),
    h = Math.max(80, Math.round((height || max * 0.66) * scale));
  return (
    <span className="tg-visual" data-round={round || undefined} style={{ width: w, height: h }}>
      {thumb?.local.is_downloading_completed ? (
        <img src={fileUrl(thumb)} alt="" draggable={false} />
      ) : mini ? (
        <img
          className="tg-blur"
          src={`data:image/jpeg;base64,${mini.data}`}
          alt=""
          draggable={false}
        />
      ) : null}
      {children}
    </span>
  );
}

function Media({ message: m, actions }: { message: TdMessage; actions: TelegramFrameActions }) {
  const c = m.content;
  const type = c['@type'];
  if (type === 'messagePhoto') {
    const sizes = (c.photo.sizes || []) as { photo: TdFile; width: number; height: number }[];
    // The size that fits a bubble sharply at 2x, else the largest.
    const size = sizes.find((s) => Math.max(s.width, s.height) >= 640) || sizes[sizes.length - 1];
    return <Photo size={size} mini={c.photo.minithumbnail} spoiler={c.has_spoiler} />;
  }
  if (type === 'messageVideo' || type === 'messageAnimation' || type === 'messageVideoNote') {
    const v =
      type === 'messageVideo' ? c.video : type === 'messageAnimation' ? c.animation : c.video_note;
    const file: TdFile =
      type === 'messageVideo' ? v.video : type === 'messageAnimation' ? v.animation : v.video;
    return (
      <Video
        file={file}
        thumbnail={v.thumbnail?.file}
        mini={v.minithumbnail}
        width={type === 'messageVideoNote' ? 240 : v.width}
        height={type === 'messageVideoNote' ? 240 : v.height}
        seconds={v.duration}
        loop={type !== 'messageVideo'}
        round={type === 'messageVideoNote'}
      />
    );
  }
  if (type === 'messageSticker') return <Sticker sticker={c.sticker} />;
  if (type === 'messageCall') {
    const missed = ['callDiscardReasonMissed', 'callDiscardReasonDeclined'].includes(
      c.discard_reason?.['@type'],
    );
    const Icon = missed ? PhoneMissed : c.is_video ? VideoIcon : Phone;
    return (
      <span className="tg-file tg-call" data-missed={missed || undefined}>
        <Icon size={22} />
        <span className="tg-file-text">
          <span className="tg-file-name">
            {missed
              ? m.is_outgoing
                ? 'Cancelled call'
                : 'Missed call'
              : m.is_outgoing
                ? `Outgoing ${c.is_video ? 'video ' : ''}call`
                : `Incoming ${c.is_video ? 'video ' : ''}call`}
          </span>
          {c.duration > 0 && <span className="tg-file-progress">{duration(c.duration)}</span>}
        </span>
      </span>
    );
  }
  if (type === 'messageVoiceNote') return <Voice message={m} />;
  if (type === 'messageAudio') return <Audio message={m} />;
  if (type === 'messageDocument') return <Document message={m} actions={actions} />;
  if (type === 'messageLocation' || type === 'messageVenue') {
    const at = c.location || c.venue?.location;
    return (
      <button
        className="tg-file"
        onClick={() =>
          actions.openLink(
            `https://www.openstreetmap.org/?mlat=${at.latitude}&mlon=${at.longitude}#map=16/${at.latitude}/${at.longitude}`,
          )
        }
      >
        <MapPin size={22} />
        <span className="tg-file-text">
          <span className="tg-file-name">{c.venue?.title || 'Location'}</span>
          <span className="tg-file-progress">{c.venue?.address || 'Open the map'}</span>
        </span>
      </button>
    );
  }
  if (type === 'messageContact')
    return (
      <span className="tg-file">
        <User size={22} />
        <span className="tg-file-text">
          <span className="tg-file-name">
            {[c.contact.first_name, c.contact.last_name].filter(Boolean).join(' ')}
          </span>
          <span className="tg-file-progress">{c.contact.phone_number}</span>
        </span>
      </span>
    );
  if (type === 'messagePoll') {
    const poll = c.poll;
    const total = poll.total_voter_count || 0;
    return (
      <span className="tg-poll">
        <strong>{poll.question?.text}</strong>
        {poll.options.map((option: Td, i: number) => (
          <span key={i} className="tg-poll-option">
            <span
              className="tg-poll-bar"
              style={{ width: `${total ? (option.voter_count * 100) / total : 0}%` }}
            />
            <span>{option.text?.text}</span>
            <span>{total ? Math.round((option.voter_count * 100) / total) : 0}%</span>
          </span>
        ))}
        <span className="tg-file-progress">
          {total} {total === 1 ? 'vote' : 'votes'} · vote in the Telegram app
        </span>
      </span>
    );
  }
  return null;
}

function Photo({
  size,
  mini,
  spoiler,
}: {
  size?: { photo: TdFile; width: number; height: number };
  mini?: { data: string };
  spoiler?: boolean;
}) {
  const [revealed, setRevealed] = useState(!spoiler);
  const file = useFile(size?.photo, true, 16);
  if (!size || !file) return null;
  return (
    <Visual mini={mini} width={size.width} height={size.height}>
      {file.local.is_downloading_completed && (
        <img
          className="tg-photo"
          data-spoiler={!revealed || undefined}
          src={fileUrl(file)}
          alt=""
          draggable={false}
          onClick={() => setRevealed(true)}
        />
      )}
      {!file.local.is_downloading_completed && <Loader2 size={22} className="tg-spin tg-center" />}
    </Visual>
  );
}

function Video({
  file: source,
  thumbnail,
  mini,
  width,
  height,
  seconds,
  loop,
  round,
}: {
  file: TdFile;
  thumbnail?: TdFile;
  mini?: { data: string };
  width: number;
  height: number;
  seconds: number;
  loop: boolean;
  round: boolean;
}) {
  // Short loops (GIFs, video messages) download by themselves when small.
  const small = (source.size || source.expected_size) < 8 * 1048576;
  const file = useFile(source, loop && small, 8)!;
  const done = file.local.is_downloading_completed;
  return (
    <Visual thumbnail={thumbnail} mini={mini} width={width} height={height} round={round}>
      {done ? (
        <video
          className="tg-video"
          src={fileUrl(file)}
          controls={!loop}
          autoPlay={loop}
          loop={loop}
          muted={loop}
          playsInline
          draggable={false}
        />
      ) : (
        <button className="tg-play" aria-label="Download and play" onClick={() => want(file, 32)}>
          {file.local.is_downloading_active ? (
            <Loader2 size={22} className="tg-spin" />
          ) : (
            <Play size={22} />
          )}
        </button>
      )}
      {!done && (
        <span className="tg-duration">
          {duration(seconds)}
          {file.local.is_downloading_active
            ? ` · ${Math.round((file.local.downloaded_size * 100) / (file.size || file.expected_size || 1))}%`
            : ` · ${formatBytes(file.size || file.expected_size)}`}
        </span>
      )}
    </Visual>
  );
}

function Sticker({ sticker }: { sticker: Td }) {
  const format = sticker.format?.['@type'];
  const file = useFile(sticker.sticker, format !== 'stickerFormatTgs', 4);
  const thumb = useFile(sticker.thumbnail?.file, format === 'stickerFormatTgs', 4);
  const size = 160;
  if (format === 'stickerFormatWebm' && file?.local.is_downloading_completed)
    return (
      <video
        className="tg-sticker"
        src={fileUrl(file)}
        autoPlay
        loop
        muted
        playsInline
        width={size}
        height={size}
      />
    );
  if (format === 'stickerFormatWebp' && file?.local.is_downloading_completed)
    return (
      <img
        className="tg-sticker"
        src={fileUrl(file)}
        alt={sticker.emoji}
        width={size}
        height={size}
        draggable={false}
      />
    );
  if (thumb?.local.is_downloading_completed)
    return (
      <img
        className="tg-sticker"
        src={fileUrl(thumb)}
        alt={sticker.emoji}
        width={size}
        height={size}
        draggable={false}
      />
    );
  return <span className="tg-emoji">{sticker.emoji || '🙂'}</span>;
}

function Audio({ message: m }: { message: TdMessage }) {
  const c = m.content;
  const voice = c['@type'] === 'messageVoiceNote';
  const source: TdFile = voice ? c.voice_note.voice : c.audio.audio;
  const file = useFile(source, voice, 16)!;
  const done = file.local.is_downloading_completed;
  return (
    <span className="tg-audio">
      {done ? (
        <audio src={fileUrl(file)} controls preload="metadata" />
      ) : (
        <button className="tg-file" onClick={() => want(file, 32)}>
          {file.local.is_downloading_active ? (
            <Loader2 size={22} className="tg-spin" />
          ) : voice ? (
            <Mic size={22} />
          ) : (
            <Play size={22} />
          )}
          <span className="tg-file-text">
            <span className="tg-file-name">
              {voice
                ? 'Voice message'
                : [c.audio.performer, c.audio.title].filter(Boolean).join(' – ') ||
                  c.audio.file_name}
            </span>
            <span className="tg-file-progress">
              {duration(voice ? c.voice_note.duration : c.audio.duration)} ·{' '}
              <Progress file={file} />
            </span>
          </span>
        </button>
      )}
    </span>
  );
}

function Document({ message: m, actions }: { message: TdMessage; actions: TelegramFrameActions }) {
  const doc = m.content.document;
  const file = useFile(doc.document, false)!;
  const thumb = useFile(doc.thumbnail?.file, true, 4);
  const done = file.local.is_downloading_completed;
  const open = () => {
    if (!done) {
      want(file, 32);
      return;
    }
    const files = window.canvas?.files;
    if (!files) return;
    const task = risky.test(doc.file_name || '')
      ? files.reveal({ path: file.local.path })
      : files.open({ path: file.local.path });
    void task.catch((e: unknown) => actions.onError(message(e)));
  };
  return (
    <button className="tg-file" onClick={open} title={done ? 'Open' : 'Download'}>
      {thumb?.local.is_downloading_completed ? (
        <img className="tg-file-thumb" src={fileUrl(thumb)} alt="" draggable={false} />
      ) : (
        <span className="tg-file-icon">
          {file.local.is_downloading_active ? (
            <Loader2 size={20} className="tg-spin" />
          ) : done ? (
            <FileIcon size={20} />
          ) : (
            <Download size={20} />
          )}
        </span>
      )}
      <span className="tg-file-text">
        <span className="tg-file-name">{doc.file_name || 'File'}</span>
        <Progress file={file} />
      </span>
    </button>
  );
}

const Bubble = memo(function Bubble({
  message: m,
  chat,
  showName,
  actions,
  tools,
  onReply,
  onEdit,
}: {
  message: TdMessage;
  chat: TdChat;
  showName: boolean;
  actions: TelegramFrameActions;
  tools: ChatTools;
  onReply?: () => void;
  onEdit: () => void;
}) {
  if (isService(m)) return <div className="tg-service">{serviceText(m)}</div>;
  const c = m.content;
  const text: TdText | undefined = c['@type'] === 'messageText' ? c.text : c.caption;
  const media = c['@type'] !== 'messageText';
  const info = messageFile(m);
  const failed = m.sending_state?.['@type'] === 'messageSendingStateFailed';
  const sending = m.sending_state?.['@type'] === 'messageSendingStatePending';
  const read = m.is_outgoing && m.id <= chat.last_read_outbox_message_id;
  const known = [
    'messageText',
    'messagePhoto',
    'messageVideo',
    'messageAnimation',
    'messageVideoNote',
    'messageSticker',
    'messageVoiceNote',
    'messageAudio',
    'messageDocument',
    'messageLocation',
    'messageVenue',
    'messageContact',
    'messagePoll',
    'messageCall',
  ].includes(c['@type']);
  const reply =
    m.reply_to?.['@type'] === 'messageReplyToMessage'
      ? historyOf(m.chat_id).messages.get(m.reply_to.message_id)
      : undefined;

  // Out of the frame as a real file once downloaded (to the board, Explorer or
  // another app); before that, the board downloads it where it is dropped.
  const dragStart = (event: DragEvent) => {
    if (!info) return;
    const file = fileOf(info.file);
    if (file.local.is_downloading_completed && file.local.path) {
      event.preventDefault();
      telegramBridge()?.drag(file.local.path);
      return;
    }
    event.dataTransfer.setData(
      telegramFileType,
      JSON.stringify({ fileId: file.id, name: info.name }),
    );
    event.dataTransfer.setData('text/plain', info.name);
    event.dataTransfer.effectAllowed = 'copy';
  };
  const menu = (event: React.MouseEvent) =>
    void openMessageMenu(m, event, { ...tools, reply: onReply, edit: onEdit });
  const reactions = reactionsOf(m);
  const sticker = c['@type'] === 'messageSticker' || c['@type'] === 'messageVideoNote';
  return (
    <div className="tg-row" data-out={m.is_outgoing || undefined}>
      <div
        className="tg-bubble"
        data-media={media || undefined}
        data-bare={sticker || undefined}
        data-failed={failed || undefined}
        draggable={!!info}
        onDragStart={dragStart}
        onContextMenu={menu}
        onDoubleClick={onReply}
      >
        {showName && <span className="tg-sender">{senderName(m)}</span>}
        {m.forward_info && <span className="tg-forwarded">Forwarded</span>}
        {reply && (
          <span className="tg-reply">
            <span className="tg-reply-name">{senderName(reply)}</span>
            <span className="tg-reply-text">{messageSummary(reply)}</span>
          </span>
        )}
        {known ? (
          <Media message={m} actions={actions} />
        ) : (
          <span className="tg-unsupported">
            {messageSummary(m)} · open the Telegram app to see it
          </span>
        )}
        <Text text={text} onLink={actions.openLink} />
        {reactions.length > 0 && (
          <span className="tg-reactions">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                data-chosen={r.chosen || undefined}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => toggleReaction(m, r.emoji, tools)}
              >
                {shownEmoji(r.emoji)} {r.count}
              </button>
            ))}
          </span>
        )}
        <span className="tg-meta">
          {m.is_pinned && <Pin size={11} />}
          {m.edit_date > 0 && 'edited '}
          {messageTime(m.date)}
          {m.is_outgoing &&
            (failed ? (
              ' · not sent'
            ) : sending ? (
              <Loader2 size={12} className="tg-spin" />
            ) : read ? (
              <CheckCheck size={14} />
            ) : (
              <Check size={14} />
            ))}
        </span>
      </div>
    </div>
  );
});

function serviceText(m: TdMessage) {
  const who = senderName(m);
  const text = messageSummary(m);
  return who && !/^(Created|Joined Telegram)/.test(text) ? `${who}: ${text}` : text;
}

function Sponsored({
  chatId,
  message: s,
  actions,
}: {
  chatId: number;
  message: Td;
  actions: TelegramFrameActions;
}) {
  const text: TdText | undefined = s.content?.text || s.content?.caption;
  const click = () => {
    void telegramBridge()
      ?.invoke({ '@type': 'clickChatSponsoredMessage', chat_id: chatId, message_id: s.message_id })
      .catch(() => {});
    if (s.sponsor?.url) actions.openLink(s.sponsor.url);
  };
  return (
    <div className="tg-row">
      <div className="tg-bubble tg-sponsored">
        <span className="tg-sender">{s.is_recommended ? 'Recommended' : 'Sponsored'}</span>
        <strong>{s.title}</strong>
        <Text text={text} onLink={actions.openLink} />
        {s.additional_info && <span className="tg-file-progress">{s.additional_info}</span>}
        <button className="tg-button" onClick={click}>
          {s.button_text || 'Open'}
        </button>
      </div>
    </div>
  );
}

const imageName = /\.(jpe?g|png|webp|bmp|heic|avif)$/i;
const videoName = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Sends files to a chat, the caption on the first. Pictures and videos go as
 * media when `compress` is on (as Telegram's apps send them), anything else
 * (or everything, with it off) as files.
 */
async function sendFiles(
  chatId: number,
  files: StagedFile[],
  caption: string,
  compress: boolean,
  replyTo?: number,
) {
  const bridge = telegramBridge()!;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const text = { '@type': 'formattedText', text: i === 0 ? caption : '', entities: [] };
    const local = { '@type': 'inputFileLocal', path: f.path };
    const content =
      compress && imageName.test(f.name) && f.size < 10 * 1048576
        ? {
            '@type': 'inputMessagePhoto',
            photo: { '@type': 'inputPhoto', photo: local },
            caption: text,
          }
        : compress && videoName.test(f.name)
          ? {
              '@type': 'inputMessageVideo',
              video: { '@type': 'inputVideo', video: local },
              caption: text,
            }
          : {
              '@type': 'inputMessageDocument',
              document: { '@type': 'inputDocument', document: local },
              caption: text,
            };
    await bridge.invoke({
      '@type': 'sendMessage',
      chat_id: chatId,
      reply_to: i === 0 && replyTo ? { message_id: replyTo } : undefined,
      input_message_content: content,
    });
  }
}

// Loudness samples taken while recording, as 100 waveform values.
function waveformOf(levels: number[]) {
  if (!levels.length) return '';
  const peak = Math.max(...levels, 0.01);
  const values = Array.from({ length: 100 }, (_, i) => {
    const from = Math.floor((i * levels.length) / 100),
      to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / 100));
    const slice = levels.slice(from, to);
    return (Math.max(...slice) / peak) * 31;
  });
  return packWaveform(values);
}

function Bars({
  values,
  progress,
  height = 26,
}: {
  values: number[];
  progress: number;
  height?: number;
}) {
  const bars = values.length ? values : Array.from({ length: 40 }, () => 6);
  // About 40 bars, like Telegram's apps.
  const step = Math.max(1, Math.round(bars.length / 40));
  const shown: number[] = [];
  for (let i = 0; i < bars.length; i += step) shown.push(Math.max(...bars.slice(i, i + step)));
  return (
    <span className="tg-bars" style={{ height }}>
      {shown.map((v, i) => (
        <span
          key={i}
          data-played={i / shown.length < progress || undefined}
          style={{ height: Math.max(3, (v / 31) * height) }}
        />
      ))}
    </span>
  );
}

// A voice message: play button, loudness bars that fill as it plays, time.
function Voice({ message: m }: { message: TdMessage }) {
  const note = m.content.voice_note;
  const file = useFile(note.voice, true, 16)!;
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [wanted, setWanted] = useState(false);
  const done = file.local.is_downloading_completed;
  const length = note.duration || 1;
  useEffect(() => {
    if (done && wanted && audio.current?.paused) void audio.current.play().catch(() => {});
  }, [done, wanted]);
  const toggle = () => {
    const el = audio.current;
    if (!done || !el) {
      want(file, 32);
      setWanted(true);
      return;
    }
    if (el.paused) {
      void el.play().catch(() => {});
      if (!m.is_outgoing && !m.content.is_listened)
        void telegramBridge()
          ?.invoke({ '@type': 'openMessageContent', chat_id: m.chat_id, message_id: m.id })
          .catch(() => {});
    } else el.pause();
  };
  return (
    <span
      className="tg-voice"
      data-unheard={(!m.is_outgoing && !m.content.is_listened) || undefined}
    >
      <button className="tg-voice-play" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
        {file.local.is_downloading_active ? (
          <Loader2 size={20} className="tg-spin" />
        ) : playing ? (
          <Pause size={20} />
        ) : (
          <Play size={20} />
        )}
      </button>
      <span className="tg-voice-body">
        <span
          className="tg-voice-wave"
          onClick={(event) => {
            const el = audio.current;
            if (!el || !done) return;
            const r = event.currentTarget.getBoundingClientRect();
            el.currentTime = ((event.clientX - r.left) / r.width) * (el.duration || length);
          }}
        >
          <Bars values={unpackWaveform(note.waveform)} progress={position / length} />
        </span>
        <span className="tg-file-progress">
          {duration(playing || position ? position : length)}
          {!done && !file.local.is_downloading_active && ` · ${formatBytes(file.size)}`}
        </span>
      </span>
      {done && (
        <audio
          ref={audio}
          src={fileUrl(file)}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        />
      )}
    </span>
  );
}

// Files on their way to a chat, as Telegram's apps ask before sending: the
// files, whether pictures go compressed, and a caption.
function SendDialog({
  title,
  files,
  setFiles,
  onAdd,
  onClose,
  chatId,
  replyTo,
  onSent,
}: {
  title: string;
  files: StagedFile[];
  setFiles: (files: StagedFile[]) => void;
  onAdd: () => void;
  onClose: () => void;
  chatId: number;
  replyTo?: number;
  onSent: () => void;
}) {
  const [caption, setCaption] = useState('');
  const media = files.some((f) => imageName.test(f.name) || videoName.test(f.name));
  const [compress, setCompress] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const asMedia =
    media && compress && files.every((f) => imageName.test(f.name) || videoName.test(f.name));
  const heading = asMedia
    ? files.every((f) => imageName.test(f.name))
      ? files.length === 1
        ? 'Send a photo'
        : `Send ${files.length} photos`
      : files.length === 1
        ? 'Send a video'
        : `Send ${files.length} items`
    : files.length === 1
      ? 'Send as a file'
      : `Send ${files.length} files`;
  const send = async () => {
    if (busy || !files.length) return;
    setBusy(true);
    setError('');
    try {
      await sendFiles(chatId, files, caption.trim(), compress, replyTo);
      onSent();
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
        role="dialog"
        aria-label={heading}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) onClose();
        }}
      >
        <h3>{heading}</h3>
        <p className="tg-dialog-to">to {title}</p>
        <div className="tg-dialog-files">
          {files.map((f, i) => (
            <div key={f.path + i} className="tg-dialog-file">
              <span className="tg-file-icon">
                {imageName.test(f.name) ? <ImageIcon size={20} /> : <FileIcon size={20} />}
              </span>
              <span className="tg-file-text">
                <span className="tg-file-name">{f.name}</span>
                <span className="tg-file-progress">{formatBytes(f.size)}</span>
              </span>
              <button
                className="cf-button"
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={() => {
                  const next = files.filter((_, j) => j !== i);
                  if (next.length) setFiles(next);
                  else onClose();
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
        {media && (
          <label className="tg-dialog-check">
            <input
              type="checkbox"
              checked={compress}
              onChange={(e) => setCompress(e.target.checked)}
            />
            Send pictures and videos as media (compressed)
          </label>
        )}
        <label className="tg-dialog-caption">
          Caption
          <input
            ref={field}
            value={caption}
            maxLength={4096}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
          />
        </label>
        {error && <p className="tg-error">{error}</p>}
        <div className="tg-dialog-actions">
          <button className="tg-link" disabled={busy || files.length >= 20} onClick={onAdd}>
            Add
          </button>
          <span />
          <button className="tg-link" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="tg-link strong" disabled={busy} onClick={() => void send()}>
            {busy ? <Loader2 size={15} className="tg-spin" /> : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

type Recording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  context: AudioContext;
  parts: Blob[];
  levels: number[];
  timer: number;
  started: number;
  cancelled: boolean;
};

function Composer({
  chatId,
  editing,
  clearEdit,
  replyTo,
  clearReply,
  error,
  setError,
  onSent,
  onPick,
}: {
  chatId: number;
  editing: TdMessage | null;
  clearEdit: () => void;
  replyTo: TdMessage | null;
  clearReply: () => void;
  error: string;
  setError: (text: string) => void;
  onSent: () => void;
  onPick: () => void;
}) {
  const bridge = telegramBridge()!;
  const editText = (
    editing?.content?.['@type'] === 'messageText' ? editing.content.text : editing?.content?.caption
  ) as TdText | undefined;
  const [text, setText] = useState(editText?.text || '');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) field.current?.focus();
  }, []);
  const recording = useRef<Recording | null>(null);
  const [recordState, setRecordState] = useState<{ seconds: number; levels: number[] } | null>(
    null,
  );
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    if (replyTo) field.current?.focus();
  }, [replyTo]);
  // Leaving the chat drops a recording in progress.
  useEffect(() => () => stopRecording(false), []);

  const send = async () => {
    const value = text.trim();
    if (busy || (!value && !editing)) return;
    setBusy(true);
    setError('');
    try {
      if (editing) {
        const formatted = { '@type': 'formattedText', text: value, entities: [] };
        await bridge.invoke(
          editing.content['@type'] === 'messageText'
            ? {
                '@type': 'editMessageText',
                chat_id: chatId,
                message_id: editing.id,
                input_message_content: { '@type': 'inputMessageText', text: formatted },
              }
            : {
                '@type': 'editMessageCaption',
                chat_id: chatId,
                message_id: editing.id,
                caption: formatted,
              },
        );
        setText('');
        clearEdit();
        return;
      }
      await bridge.invoke({
        '@type': 'sendMessage',
        chat_id: chatId,
        reply_to: replyTo ? { message_id: replyTo.id } : undefined,
        input_message_content: {
          '@type': 'inputMessageText',
          text: { '@type': 'formattedText', text: value, entities: [] },
        },
      });
      setText('');
      clearReply();
      onSent();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  const startRecording = async () => {
    if (recording.current || busy) return;
    setError('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      setError(
        (e as Error)?.name === 'NotAllowedError'
          ? 'Terra couldn’t use the microphone. Check Windows Settings → Privacy & security → Microphone.'
          : 'No microphone was found.',
      );
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const recorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32000,
    });
    const r: Recording = {
      recorder,
      stream,
      context,
      parts: [],
      levels: [],
      started: Date.now(),
      cancelled: false,
      timer: 0,
    };
    recorder.ondataavailable = (event) => event.data.size && r.parts.push(event.data);
    recorder.onstop = () => void finishRecording(r);
    r.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      r.levels.push(Math.sqrt(sum / samples.length));
      const seconds = (Date.now() - r.started) / 1000;
      setRecordState({ seconds, levels: r.levels.slice(-48) });
      // Telegram's apps stop at about an hour; ten minutes is plenty here.
      if (seconds >= 600) stopRecording(true);
    }, 60);
    recording.current = r;
    recorder.start(250);
    setRecordState({ seconds: 0, levels: [] });
  };
  function stopRecording(sendIt: boolean) {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    r.cancelled = !sendIt;
    clearInterval(r.timer);
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    else void finishRecording(r);
    setRecordState(null);
  }
  async function finishRecording(r: Recording) {
    r.stream.getTracks().forEach((t) => t.stop());
    void r.context.close().catch(() => {});
    if (r.cancelled) return;
    const seconds = (Date.now() - r.started) / 1000;
    if (seconds < 0.6) {
      setError('Hold on a bit longer to record a voice message.');
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await new Blob(r.parts).arrayBuffer());
      const saved = await bridge.voice(bytes);
      await bridge.invoke({
        '@type': 'sendMessage',
        chat_id: chatId,
        reply_to: replyTo ? { message_id: replyTo.id } : undefined,
        input_message_content: {
          '@type': 'inputMessageVoiceNote',
          voice_note: {
            '@type': 'inputVoiceNote',
            voice_note: { '@type': 'inputFileLocal', path: saved.path },
            duration: Math.round(saved.seconds),
            waveform: waveformOf(r.levels),
          },
          caption: { '@type': 'formattedText', text: '', entities: [] },
        },
      });
      clearReply();
      onSent();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      if (editing) clearEdit();
      else if (replyTo) clearReply();
      else field.current?.blur();
    }
  };
  const peak = Math.max(0.02, ...(recordState?.levels ?? []));
  return (
    <div
      className="tg-composer"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(event) => {
        if (recordState && event.key === 'Escape') {
          event.stopPropagation();
          stopRecording(false);
        }
      }}
    >
      {replyTo && (
        <div className="tg-composer-reply">
          <span className="tg-reply">
            <span className="tg-reply-name">Reply to {senderName(replyTo)}</span>
            <span className="tg-reply-text">{messageSummary(replyTo)}</span>
          </span>
          <button className="cf-button" aria-label="Cancel reply" onClick={clearReply}>
            <X size={15} />
          </button>
        </div>
      )}
      {editing && (
        <div className="tg-composer-reply">
          <span className="tg-reply">
            <span className="tg-reply-name">Edit message</span>
            <span className="tg-reply-text">{messageSummary(editing)}</span>
          </span>
          <button className="cf-button" aria-label="Cancel editing" onClick={clearEdit}>
            <X size={15} />
          </button>
        </div>
      )}
      {error && <div className="tg-error">{error}</div>}
      {recordState ? (
        <div className="tg-composer-row tg-recording">
          <button
            className="cf-button"
            aria-label="Cancel the recording"
            title="Cancel (Esc)"
            autoFocus
            onClick={() => stopRecording(false)}
          >
            <Trash2 size={18} />
          </button>
          <span className="tg-rec-dot" />
          <span className="tg-rec-time">{duration(recordState.seconds)}</span>
          <span className="tg-rec-levels">
            {recordState.levels.map((v, i) => (
              <span key={i} style={{ height: Math.max(3, (v / peak) * 22) }} />
            ))}
          </span>
          <button
            className="cf-button tg-send"
            aria-label="Send the voice message"
            title="Send"
            onClick={() => stopRecording(true)}
          >
            <SendHorizontal size={18} />
          </button>
        </div>
      ) : (
        <div className="tg-composer-row">
          <button
            className="cf-button"
            aria-label="Attach files"
            title="Attach files"
            onClick={onPick}
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={field}
            rows={1}
            value={text}
            placeholder="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={keyDown}
          />
          {text.trim() || busy || editing ? (
            <button
              className="cf-button tg-send"
              aria-label="Send"
              title="Send (Enter)"
              disabled={busy}
              onClick={() => void send()}
            >
              {busy ? <Loader2 size={18} className="tg-spin" /> : <SendHorizontal size={18} />}
            </button>
          ) : (
            <button
              className="cf-button tg-mic"
              aria-label="Record a voice message"
              title="Record a voice message"
              onClick={() => void startRecording()}
            >
              <Mic size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
