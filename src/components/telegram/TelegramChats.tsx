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
  Download,
  File as FileIcon,
  ImagePlus,
  Loader2,
  MapPin,
  Mic,
  Paperclip,
  Pin,
  Play,
  Search,
  SendHorizontal,
  User,
  X,
} from 'lucide-react';
import type { Camera, CanvasObject } from '../../model';
import type { MenuItem } from '../Dialogs';
import type { TelegramFrameActions } from './TelegramCard';
import {
  chatOf,
  downloadNow,
  fileOf,
  historyOf,
  loadOlder,
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
  sortedChats,
  textParts,
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

// The main chat list loads in pages as it is scrolled.
let listLoading: Promise<void> | null = null;
let listComplete = false;
function loadChats(limit = 100) {
  const bridge = telegramBridge();
  if (!bridge || listComplete) return Promise.resolve();
  listLoading ||= bridge
    .invoke({ '@type': 'loadChats', chat_list: { '@type': 'chatListMain' }, limit })
    .then(() => undefined)
    .catch((error: { message?: string }) => {
      // 404: every chat is loaded.
      if (/404|not found/i.test(String(error?.message))) listComplete = true;
    })
    .finally(() => {
      listLoading = null;
    });
  return listLoading;
}

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
  useEffect(() => {
    listComplete = false;
    void loadChats();
  }, []);
  const choose = (id: number) => {
    setSelected(id);
    saveChoice(o.id, id);
  };
  const height = o.height - 48;
  const wide = o.width >= 640;
  const listWidth = wide ? Math.round(Math.min(340, Math.max(240, o.width * 0.36))) : o.width;
  const open = selected && chats.has(selected) ? selected : 0;
  return (
    <div className="tg-chats" style={{ height }}>
      {(wide || !open) && (
        <ChatList
          width={listWidth}
          height={height}
          selected={open}
          zoom={camera.zoom}
          onSelect={choose}
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
        />
      ) : (
        wide && (
          <div className="tg-empty">
            <p>Choose a chat</p>
          </div>
        )
      )}
    </div>
  );
}

function Avatar({
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
  useEffect(() => {
    if (photo) want(photo.small, 4);
  }, [photo?.small.id]);
  const src = file?.local.is_downloading_completed
    ? fileUrl(file)
    : photo?.minithumbnail
      ? `data:image/jpeg;base64,${photo.minithumbnail.data}`
      : null;
  return (
    <span
      className="tg-avatar"
      style={{ width: size, height: size, background: avatarColor(id), fontSize: size * 0.38 }}
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials(title)}
    </span>
  );
}

const muted = (chat: TdChat) => (chat.notification_settings?.mute_for ?? 0) > 0;

const ChatRow = memo(function ChatRow({
  chat,
  pinned,
  active,
  onSelect,
}: {
  chat: TdChat;
  pinned: boolean;
  active: boolean;
  onSelect: (id: number) => void;
}) {
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
      data-active={active || undefined}
      style={{ height: rowHeight }}
      onClick={() => onSelect(chat.id)}
    >
      <Avatar id={chat.id} title={chat.title} photo={chat.photo} size={46} />
      <span className="tg-chat-text">
        <span className="tg-chat-top">
          <span className="tg-chat-title">{chat.title || 'Deleted account'}</span>
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
  onSelect,
}: {
  width: number;
  height: number;
  selected: number;
  zoom: number;
  onSelect: (id: number) => void;
}) {
  const { chats } = useTelegram();
  const [query, setQuery] = useState('');
  const [scroll, setScroll] = useState(0);
  // Chats change in place, so this is worked out on every update (it is quick).
  const all = sortedChats(chats.values());
  const q = query.trim().toLowerCase();
  const list = q ? all.filter(({ chat }) => chat.title.toLowerCase().includes(q)) : all;
  const viewport = height - 52;
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 4);
  const last = Math.min(list.length, Math.ceil((scroll + viewport) / rowHeight) + 4);
  return (
    <div className="tg-list" style={{ width, height }}>
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
          if (el.scrollTop + el.clientHeight > el.scrollHeight - rowHeight * 10) void loadChats();
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
              />
            ))}
          </div>
        </div>
        {!list.length && (
          <p className="tg-list-empty">{query ? 'No chats match.' : 'Loading chats…'}</p>
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
}: {
  frameId: string;
  chatId: number;
  zoom: number;
  frameWidth: number;
  onBack?: () => void;
  actions: TelegramFrameActions;
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
  const [pending, setPending] = useState<StagedFile[]>([]);
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

  // Files dropped from the board wait in the composer, like Telegram's own apps.
  const addSources = useCallback(async (sources: TelegramSource[]) => {
    try {
      const staged = await bridge.stage(sources);
      setPending((p) => [...p, ...staged].slice(0, 20));
      setSendError('');
    } catch (e) {
      actions.onError(message(e));
    }
  }, []);
  useEffect(() => receiveTelegramDrops(frameId, (s) => void addSources(s)), [frameId]);

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
  const title = chat.title || 'Deleted account';
  const user = privateUserId(chat) ? userOf(privateUserId(chat)) : undefined;
  const subtitle = isChannel(chat)
    ? 'Channel'
    : isGroup(chat)
      ? 'Group'
      : user?.type?.['@type'] === 'userTypeBot'
        ? 'Bot'
        : statusText(user?.status);

  const dropFiles = async (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    const paths = [...event.dataTransfer.files]
      .map((file) => window.canvas?.filePath(file) || '')
      .filter(Boolean);
    if (paths.length) await addSources(paths.map((path) => ({ path })));
  };
  const draggingFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes('Files') &&
    !event.dataTransfer.types.includes(telegramFileType);

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
        if (draggingFiles(event) && canPost) void dropFiles(event);
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
              <div key={m.id}>
                {newDay && <div className="tg-day">{dayLabel(m.date)}</div>}
                <Bubble
                  message={m}
                  chat={chat}
                  showName={!sameSender && isGroup(chat) && !m.is_outgoing}
                  actions={actions}
                  onReply={canPost ? () => setReplyTo(m) : undefined}
                />
              </div>
            );
          })}
          {sponsored && <Sponsored chatId={chatId} message={sponsored} actions={actions} />}
        </div>
      </div>
      {canPost ? (
        <Composer
          chatId={chatId}
          pending={pending}
          setPending={setPending}
          replyTo={replyTo}
          clearReply={() => setReplyTo(null)}
          error={sendError}
          setError={setSendError}
          onSent={() => {
            stick.current = true;
          }}
          onPick={async () => {
            try {
              const staged = await bridge.pick();
              setPending((p) => [...p, ...staged].slice(0, 20));
            } catch (e) {
              actions.onError(message(e));
            }
          }}
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
  if (type === 'messageVoiceNote' || type === 'messageAudio') return <Audio message={m} />;
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
  onReply,
}: {
  message: TdMessage;
  chat: TdChat;
  showName: boolean;
  actions: TelegramFrameActions;
  onReply?: () => void;
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
  const menu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const plain = text?.text || '';
    const items: (MenuItem | null)[] = [
      onReply ? { label: 'Reply', action: onReply } : null,
      plain
        ? {
            label: 'Copy text',
            action: () => void navigator.clipboard.writeText(plain).catch(() => {}),
          }
        : null,
      plain && !info
        ? { label: 'Add text to the board', action: () => actions.addText(plain) }
        : null,
      info
        ? {
            label: 'Add to the board',
            action: () =>
              void downloadNow(info.file)
                .then((path) => actions.addFiles([{ path, name: info.name }]))
                .catch((e) => actions.onError(message(e))),
          }
        : null,
      info
        ? {
            label: 'Show in folder',
            action: () =>
              void downloadNow(info.file)
                .then((path) => window.canvas?.files?.reveal({ path }))
                .catch((e) => actions.onError(message(e))),
          }
        : null,
      m.can_be_deleted_for_all_users || m.can_be_deleted_only_for_self || m.is_outgoing
        ? {
            label: 'Delete',
            danger: true,
            action: () =>
              void telegramBridge()
                ?.invoke({
                  '@type': 'deleteMessages',
                  chat_id: m.chat_id,
                  message_ids: [m.id],
                  revoke: !!m.can_be_deleted_for_all_users,
                })
                .catch((e) => actions.onError(message(e))),
          }
        : null,
    ];
    actions.openMenu({ x: event.clientX, y: event.clientY, items });
  };
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
        <span className="tg-meta">
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

const imageName = /\.(jpe?g|png|webp|gif|bmp|heic|avif)$/i;
const videoName = /\.(mp4|mov|m4v|webm)$/i;

function Composer({
  chatId,
  pending,
  setPending,
  replyTo,
  clearReply,
  error,
  setError,
  onSent,
  onPick,
}: {
  chatId: number;
  pending: StagedFile[];
  setPending: (update: (p: StagedFile[]) => StagedFile[]) => void;
  replyTo: TdMessage | null;
  clearReply: () => void;
  error: string;
  setError: (text: string) => void;
  onSent: () => void;
  onPick: () => void;
}) {
  const bridge = telegramBridge()!;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    if (replyTo) field.current?.focus();
  }, [replyTo]);
  const send = async () => {
    const value = text.trim();
    if (busy || (!value && !pending.length)) return;
    setBusy(true);
    setError('');
    const reply = replyTo ? { message_id: replyTo.id } : undefined;
    try {
      if (pending.length) {
        for (let i = 0; i < pending.length; i++) {
          const f = pending[i];
          const caption = { '@type': 'formattedText', text: i === 0 ? value : '', entities: [] };
          const local = { '@type': 'inputFileLocal', path: f.path };
          // Pictures and videos go as media (as Telegram's apps send them);
          // anything else, or anything very large, as a file.
          const content =
            imageName.test(f.name) && f.size < 10 * 1048576 && !/\.gif$/i.test(f.name)
              ? {
                  '@type': 'inputMessagePhoto',
                  photo: { '@type': 'inputPhoto', photo: local },
                  caption,
                }
              : videoName.test(f.name)
                ? {
                    '@type': 'inputMessageVideo',
                    video: { '@type': 'inputVideo', video: local },
                    caption,
                  }
                : {
                    '@type': 'inputMessageDocument',
                    document: { '@type': 'inputDocument', document: local },
                    caption,
                  };
          await bridge.invoke({
            '@type': 'sendMessage',
            chat_id: chatId,
            reply_to: i === 0 ? reply : undefined,
            input_message_content: content,
          });
        }
        setPending(() => []);
      } else
        await bridge.invoke({
          '@type': 'sendMessage',
          chat_id: chatId,
          reply_to: reply,
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
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      if (replyTo) clearReply();
      else if (pending.length) setPending(() => []);
      else field.current?.blur();
    }
  };
  return (
    <div className="tg-composer" onPointerDown={(e) => e.stopPropagation()}>
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
      {pending.length > 0 && (
        <div className="tg-pending">
          {pending.map((f, i) => (
            <span key={f.path + i} className="tg-chip" title={f.path}>
              {imageName.test(f.name) ? <ImagePlus size={13} /> : <FileIcon size={13} />}
              <span>{f.name}</span>
              <small>{formatBytes(f.size)}</small>
              <button
                aria-label={`Remove ${f.name}`}
                onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="tg-error">{error}</div>}
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
          placeholder={pending.length ? 'Add a caption…' : 'Message'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyDown}
        />
        <button
          className="cf-button tg-send"
          aria-label="Send"
          title="Send (Enter)"
          disabled={busy || (!text.trim() && !pending.length)}
          onClick={() => void send()}
        >
          {busy ? <Loader2 size={18} className="tg-spin" /> : <SendHorizontal size={18} />}
        </button>
      </div>
    </div>
  );
}
