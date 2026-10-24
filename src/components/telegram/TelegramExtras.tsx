// More of what Telegram's apps do, in a Telegram frame: voting in polls,
// searching a chat, the emoji, sticker and GIF picker, scheduled messages, bot
// buttons, new groups and channels, stories, and declining calls.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Phone,
  PhoneOff,
  Search,
  Send,
  Sticker as StickerIcon,
  Trash2,
  X,
} from 'lucide-react';
import type { TelegramFrameActions } from './TelegramCard';
import {
  chatOf,
  fileOf,
  jumpTo,
  storiesOf,
  telegramBridge,
  useTelegram,
  userOf,
  want,
} from './telegram-store';
import {
  fileUrl,
  listDate,
  messageSummary,
  messageTime,
  userName,
  type Td,
  type TdFile,
  type TdMessage,
} from './td';
import { Avatar, chatTitle } from './TelegramChats';

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

function Overlay({
  label,
  onClose,
  children,
  className = '',
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className="tg-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={'tg-dialog ' + className}
        role="dialog"
        aria-label={label}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') onClose();
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** A poll: vote by clicking an option (or several, then Vote); results after. */
export function PollView({
  message: m,
  onError,
}: {
  message: TdMessage;
  onError: (e: string) => void;
}) {
  const poll = m.content.poll as Td;
  const options = poll.options as Td[];
  const voted = options.some((o) => o.is_chosen);
  const showResults = voted || poll.is_closed || m.is_outgoing;
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const total = poll.total_voter_count || 0;
  const vote = async (ids: number[]) => {
    setBusy(true);
    try {
      await telegramBridge()!.invoke({
        '@type': 'setPollAnswer',
        chat_id: m.chat_id,
        message_id: m.id,
        option_ids: ids,
      });
      setPicked([]);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const quiz = poll.type?.['@type'] === 'pollTypeQuiz';
  return (
    <span className="tg-poll" onPointerDown={(e) => e.stopPropagation()}>
      <strong>{poll.question?.text}</strong>
      <span className="tg-file-progress">
        {poll.is_closed
          ? 'Final results'
          : poll.is_anonymous
            ? `Anonymous ${quiz ? 'quiz' : 'poll'}`
            : quiz
              ? 'Quiz'
              : 'Poll'}
      </span>
      {options.map((option, i) =>
        showResults ? (
          <span key={i} className="tg-poll-option" data-chosen={option.is_chosen || undefined}>
            <span
              className="tg-poll-bar"
              style={{
                width: `${option.vote_percentage ?? (total ? (option.voter_count * 100) / total : 0)}%`,
              }}
            />
            <span>{option.text?.text}</span>
            <span>{Math.round(option.vote_percentage ?? 0)}%</span>
          </span>
        ) : (
          <button
            key={i}
            className="tg-poll-choice"
            data-picked={picked.includes(i) || undefined}
            disabled={busy}
            onClick={() =>
              poll.allows_multiple_answers
                ? setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
                : void vote([i])
            }
          >
            <span className="tg-poll-dot" />
            {option.text?.text}
          </button>
        ),
      )}
      {!showResults && poll.allows_multiple_answers && (
        <button
          className="tg-button"
          disabled={busy || !picked.length}
          onClick={() => void vote(picked)}
        >
          Vote
        </button>
      )}
      <span className="tg-file-progress">
        {total} {total === 1 ? 'vote' : 'votes'}
        {voted && !poll.is_closed && !quiz && (
          <>
            {' · '}
            <button className="tg-link" disabled={busy} onClick={() => void vote([])}>
              Retract vote
            </button>
          </>
        )}
      </span>
    </span>
  );
}

/** Searching a chat's messages; a result shows the chat at that message. */
export function SearchPanel({
  chatId,
  onShow,
  onClose,
}: {
  chatId: number;
  onShow: (id: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TdMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let live = true;
    setBusy(true);
    const timer = setTimeout(() => {
      void telegramBridge()!
        .invoke<{ messages: TdMessage[] }>({
          '@type': 'searchChatMessages',
          chat_id: chatId,
          query: q,
          from_message_id: 0,
          offset: 0,
          limit: 50,
        })
        .then((r) => live && setResults(r.messages || []))
        .catch(() => live && setResults([]))
        .finally(() => live && setBusy(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, chatId]);
  return (
    <div className="tg-search-panel" onPointerDown={(e) => e.stopPropagation()}>
      <label className="tg-search">
        <Search size={15} />
        <input
          ref={field}
          value={query}
          placeholder="Search this chat"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
          }}
        />
        {busy && <Loader2 size={14} className="tg-spin" />}
        <button aria-label="Close search" onClick={onClose}>
          <X size={14} />
        </button>
      </label>
      {results && (
        <div className="tg-search-results">
          {results.length ? (
            results.map((m) => (
              <button
                key={m.id}
                className="tg-search-result"
                onClick={() =>
                  void jumpTo(chatId, m.id)
                    .then(() => onShow(m.id))
                    .catch(() => {})
                }
              >
                <span className="tg-search-who">
                  {m.sender_id?.['@type'] === 'messageSenderUser'
                    ? userName(userOf(m.sender_id.user_id))
                    : chatOf(m.chat_id)?.title}
                  <small>{listDate(m.date)}</small>
                </span>
                <span className="tg-search-text">{messageSummary(m)}</span>
              </button>
            ))
          ) : (
            <p className="tg-list-empty">Nothing found.</p>
          )}
        </div>
      )}
    </div>
  );
}

// Emoji as Telegram's picker groups them, the commonest first.
const emojiGroups: [string, string][] = [
  [
    'Smileys',
    '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖',
  ],
  [
    'People',
    '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 👀 👁️ 👅 👄 💋 🧠 🫶 🤦 🤷 🙋 🙇 💃 🕺 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵',
  ],
  [
    'Hearts',
    '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 🔥 💥 💯 ✅ ❌ ❓ ❗ 💤 🎉 🎊 🎁 🏆 🥇',
  ],
  [
    'Nature',
    '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🐟 🌸 🌹 🌻 🌷 🌱 🌲 🌴 🍀 🍁 🌈 ☀️ 🌙 ⛅ ❄️ 🌊',
  ],
  [
    'Food',
    '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🍞 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🌮 🍣 🍜 🍝 🍰 🎂 🍩 🍪 🍫 🍿 ☕ 🍵 🍺 🍷 🥂 🍾',
  ],
  [
    'Things',
    '⚽ 🏀 🏈 🎾 🎮 🎲 🎯 🎸 🎹 🎧 🎤 🎬 📷 💻 ⌨️ 🖥️ 📱 ☎️ 💡 🔑 🔒 📌 📎 ✂️ 📝 📚 📅 ⏰ 💰 💳 🚗 🚕 🚌 🚲 ✈️ 🚀 🏠 🏢 🗺️ ⛰️ 🏖️',
  ],
];

/** Emoji, stickers and saved GIFs, as Telegram's picker offers them. */
export function Picker({
  onEmoji,
  onSticker,
  onGif,
  onClose,
}: {
  onEmoji: (emoji: string) => void;
  onSticker: (sticker: Td) => void;
  onGif: (animation: Td) => void;
  onClose: () => void;
}) {
  useTelegram();
  const [tab, setTab] = useState<'emoji' | 'stickers' | 'gifs'>('emoji');
  const [sets, setSets] = useState<Td[]>([]);
  const [set, setSet] = useState<string>('recent');
  const [stickers, setStickers] = useState<Td[] | null>(null);
  const [gifs, setGifs] = useState<Td[] | null>(null);
  const bridge = telegramBridge()!;
  useEffect(() => {
    if (tab !== 'stickers' || sets.length) return;
    void bridge
      .invoke<{ sets: Td[] }>({
        '@type': 'getInstalledStickerSets',
        sticker_type: { '@type': 'stickerTypeRegular' },
      })
      .then((r) => setSets(r.sets || []))
      .catch(() => {});
  }, [tab]);
  useEffect(() => {
    if (tab !== 'stickers') return;
    setStickers(null);
    const task =
      set === 'recent'
        ? bridge.invoke<{ stickers: Td[] }>({ '@type': 'getRecentStickers', is_attached: false })
        : bridge.invoke<{ stickers: Td[] }>({ '@type': 'getStickerSet', set_id: set });
    void task.then((r) => setStickers(r.stickers || [])).catch(() => setStickers([]));
  }, [tab, set]);
  useEffect(() => {
    if (tab !== 'gifs' || gifs) return;
    void bridge
      .invoke<{ animations: Td[] }>({ '@type': 'getSavedAnimations' })
      .then((r) => setGifs(r.animations || []))
      .catch(() => setGifs([]));
  }, [tab]);
  return (
    <div
      className="tg-picker"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="tg-tabs">
        {(['emoji', 'stickers', 'gifs'] as const).map((t) => (
          <button key={t} data-active={tab === t || undefined} onClick={() => setTab(t)}>
            {t === 'emoji' ? 'Emoji' : t === 'stickers' ? 'Stickers' : 'GIFs'}
          </button>
        ))}
        <span className="tg-tabs-space" />
        <button aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {tab === 'emoji' && (
        <div className="tg-picker-body">
          {emojiGroups.map(([name, list]) => (
            <div key={name}>
              <p className="tg-picker-group">{name}</p>
              <div className="tg-emoji-grid">
                {list.split(' ').map((e) => (
                  <button key={e} onClick={() => onEmoji(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'stickers' && (
        <>
          <div className="tg-sticker-sets">
            <button data-active={set === 'recent' || undefined} onClick={() => setSet('recent')}>
              Recent
            </button>
            {sets.map((s) => (
              <button
                key={s.id}
                data-active={set === s.id || undefined}
                onClick={() => setSet(s.id)}
                title={s.title}
              >
                {s.title}
              </button>
            ))}
          </div>
          <div className="tg-picker-body tg-sticker-grid">
            {stickers === null ? (
              <Loader2 size={18} className="tg-spin" />
            ) : stickers.length ? (
              stickers.map((s) => (
                <StickerCell key={s.sticker.id} sticker={s} onPick={() => onSticker(s)} />
              ))
            ) : (
              <p className="tg-list-empty">No stickers here.</p>
            )}
          </div>
        </>
      )}
      {tab === 'gifs' && (
        <div className="tg-picker-body tg-gif-grid">
          {gifs === null ? (
            <Loader2 size={18} className="tg-spin" />
          ) : gifs.length ? (
            gifs.map((a) => <GifCell key={a.animation.id} animation={a} onPick={() => onGif(a)} />)
          ) : (
            <p className="tg-list-empty">No saved GIFs. GIFs you save in Telegram show here.</p>
          )}
        </div>
      )}
    </div>
  );
}

function picture(file: TdFile | undefined, priority = 2) {
  if (!file) return null;
  want(file, priority);
  const f = fileOf(file);
  return f.local.is_downloading_completed ? fileUrl(f) : null;
}
function StickerCell({ sticker, onPick }: { sticker: Td; onPick: () => void }) {
  useTelegram();
  const format = sticker.format?.['@type'];
  // Static stickers show themselves; animated ones their picture.
  const src =
    format === 'stickerFormatWebp' ? picture(sticker.sticker) : picture(sticker.thumbnail?.file);
  const video =
    format === 'stickerFormatWebm' && !sticker.thumbnail ? picture(sticker.sticker) : null;
  return (
    <button className="tg-sticker-cell" title={sticker.emoji} onClick={onPick}>
      {src ? (
        <img src={src} alt={sticker.emoji} draggable={false} />
      ) : video ? (
        <video src={video} muted autoPlay loop playsInline />
      ) : (
        <span>{sticker.emoji}</span>
      )}
    </button>
  );
}
function GifCell({ animation, onPick }: { animation: Td; onPick: () => void }) {
  useTelegram();
  const src = picture(animation.thumbnail?.file);
  const mini = animation.minithumbnail
    ? `data:image/jpeg;base64,${animation.minithumbnail.data}`
    : null;
  return (
    <button className="tg-gif-cell" onClick={onPick}>
      {src || mini ? (
        <img src={src || mini!} alt="" draggable={false} />
      ) : (
        <StickerIcon size={18} />
      )}
    </button>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const localValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Choosing when a message goes. */
export function ScheduleDialog({
  onPick,
  onClose,
}: {
  onPick: (date: number) => void;
  onClose: () => void;
}) {
  const soon = new Date(Date.now() + 3600 * 1000);
  soon.setMinutes(0, 0, 0);
  const [value, setValue] = useState(localValue(soon));
  const when = new Date(value).getTime() / 1000;
  const valid = Number.isFinite(when) && when > Date.now() / 1000 + 30;
  return (
    <Overlay label="Schedule message" onClose={onClose}>
      <h3>Schedule message</h3>
      <label className="tg-dialog-caption">
        Send on
        <input
          type="datetime-local"
          value={value}
          min={localValue(new Date())}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </label>
      <div className="tg-dialog-actions">
        <span />
        <button className="tg-link" onClick={onClose}>
          Cancel
        </button>
        <button
          className="tg-link strong"
          disabled={!valid}
          onClick={() => onPick(Math.round(when))}
        >
          Schedule
        </button>
      </div>
    </Overlay>
  );
}

/** A chat's scheduled messages: send now or delete. */
export function ScheduledPanel({
  chatId,
  onClose,
  onError,
}: {
  chatId: number;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [list, setList] = useState<TdMessage[] | null>(null);
  const bridge = telegramBridge()!;
  const load = () =>
    void bridge
      .invoke<{ messages: TdMessage[] }>({ '@type': 'getChatScheduledMessages', chat_id: chatId })
      .then((r) => setList((r.messages || []).slice().reverse()))
      .catch(() => setList([]));
  useEffect(load, [chatId]);
  const act = (query: Td) =>
    void bridge
      .invoke(query)
      .then(load)
      .catch((e) => onError(message(e)));
  return (
    <Overlay label="Scheduled messages" onClose={onClose} className="tg-forward">
      <h3>Scheduled messages</h3>
      <div className="tg-forward-list">
        {list === null ? (
          <Loader2 size={18} className="tg-spin" />
        ) : list.length ? (
          list.map((m) => (
            <div key={m.id} className="tg-scheduled">
              <span className="tg-file-text">
                <span className="tg-file-name">{messageSummary(m)}</span>
                <span className="tg-file-progress">
                  {m.scheduling_state?.send_date
                    ? `${listDate(m.scheduling_state.send_date)} ${messageTime(m.scheduling_state.send_date)}`
                    : 'When online'}
                </span>
              </span>
              <button
                className="cf-button"
                title="Send now"
                aria-label="Send now"
                onClick={() =>
                  act({
                    '@type': 'editMessageSchedulingState',
                    chat_id: chatId,
                    message_id: m.id,
                    scheduling_state: null,
                  })
                }
              >
                <Send size={15} />
              </button>
              <button
                className="cf-button"
                title="Delete"
                aria-label="Delete"
                onClick={() =>
                  act({
                    '@type': 'deleteMessages',
                    chat_id: chatId,
                    message_ids: [m.id],
                    revoke: true,
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))
        ) : (
          <p className="tg-list-empty">No scheduled messages.</p>
        )}
      </div>
      <div className="tg-dialog-actions">
        <span />
        <button className="tg-link" onClick={onClose}>
          Close
        </button>
      </div>
    </Overlay>
  );
}

/** A bot's buttons under its message. */
export function InlineKeyboard({
  message: m,
  actions,
  onNotice,
}: {
  message: TdMessage;
  actions: TelegramFrameActions;
  onNotice: (text: string) => void;
}) {
  const rows = (m.reply_markup?.rows || []) as Td[][];
  const [busy, setBusy] = useState('');
  const press = async (button: Td, key: string) => {
    const type = button.type || {};
    switch (type['@type']) {
      case 'inlineKeyboardButtonTypeUrl':
      case 'inlineKeyboardButtonTypeLoginUrl':
      case 'inlineKeyboardButtonTypeWebApp':
        actions.openLink(type.url);
        return;
      case 'inlineKeyboardButtonTypeCopyText':
        void navigator.clipboard.writeText(type.text).catch(() => {});
        onNotice('Copied');
        return;
      case 'inlineKeyboardButtonTypeCallback':
        setBusy(key);
        try {
          const answer = await telegramBridge()!.invoke<Td>({
            '@type': 'getCallbackQueryAnswer',
            chat_id: m.chat_id,
            message_id: m.id,
            payload: { '@type': 'callbackQueryPayloadData', data: type.data },
          });
          if (answer.text) onNotice(answer.text);
          if (answer.url) actions.openLink(answer.url);
        } catch (e) {
          actions.onError(message(e));
        } finally {
          setBusy('');
        }
        return;
      default:
        onNotice('Open the Telegram app for this button.');
    }
  };
  return (
    <span className="tg-keyboard" onPointerDown={(e) => e.stopPropagation()}>
      {rows.map((row, r) => (
        <span key={r} className="tg-keyboard-row">
          {row.map((button, c) => (
            <button
              key={c}
              disabled={
                busy === `${r}:${c}` ||
                button.type?.['@type'] === 'inlineKeyboardButtonTypeDisabled'
              }
              onClick={() => void press(button, `${r}:${c}`)}
            >
              {busy === `${r}:${c}` ? <Loader2 size={13} className="tg-spin" /> : button.text}
            </button>
          ))}
        </span>
      ))}
    </span>
  );
}

/** A bot's own keyboard, over the message box: its buttons send their text. */
export function ReplyKeyboard({
  markup,
  onText,
  onError,
}: {
  markup: Td;
  onText: (text: string) => void;
  onError: (e: string) => void;
}) {
  const rows = (markup.rows || []) as Td[][];
  return (
    <div className="tg-keyboard tg-reply-keyboard" onPointerDown={(e) => e.stopPropagation()}>
      {rows.map((row, r) => (
        <span key={r} className="tg-keyboard-row">
          {row.map((button, c) => (
            <button
              key={c}
              onClick={() =>
                button.type?.['@type'] === 'keyboardButtonTypeText'
                  ? onText(button.text)
                  : onError('Open the Telegram app for this button.')
              }
            >
              {button.text}
            </button>
          ))}
        </span>
      ))}
    </div>
  );
}

/** A new group (with people from your contacts) or channel. */
export function NewChatDialog({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'group' | 'channel';
  onClose: () => void;
  onCreated: (chatId: number) => void;
}) {
  useTelegram();
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState('');
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<number[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bridge = telegramBridge()!;
  useEffect(() => {
    if (kind !== 'group') return;
    void bridge
      .invoke<{ user_ids: number[] }>({ '@type': 'getContacts' })
      .then((r) => {
        setContacts(r.user_ids || []);
        for (const id of r.user_ids || [])
          if (!userOf(id)) void bridge.invoke({ '@type': 'getUser', user_id: id }).catch(() => {});
      })
      .catch(() => {});
  }, [kind]);
  const q = query.trim().toLowerCase();
  const shown = contacts.filter((id) => !q || userName(userOf(id)).toLowerCase().includes(q));
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const result =
        kind === 'group'
          ? await bridge.invoke<Td>({
              '@type': 'createNewBasicGroupChat',
              user_ids: chosen,
              title: title.trim(),
              message_auto_delete_time: 0,
            })
          : await bridge.invoke<Td>({
              '@type': 'createNewSupergroupChat',
              title: title.trim(),
              is_forum: false,
              is_channel: true,
              description: about.trim(),
              location: null,
              message_auto_delete_time: 0,
              for_import: false,
            });
      onCreated(result.chat_id ?? result.id);
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Overlay
      label={kind === 'group' ? 'New group' : 'New channel'}
      onClose={onClose}
      className="tg-forward"
    >
      <h3>{kind === 'group' ? 'New group' : 'New channel'}</h3>
      <label className="tg-dialog-caption">
        {kind === 'group' ? 'Group name' : 'Channel name'}
        <input value={title} maxLength={128} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </label>
      {kind === 'channel' ? (
        <label className="tg-dialog-caption">
          Description (optional)
          <input value={about} maxLength={255} onChange={(e) => setAbout(e.target.value)} />
        </label>
      ) : (
        <>
          <label className="tg-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Add people"
            />
          </label>
          <div className="tg-forward-list">
            {shown.map((id) => {
              const user = userOf(id);
              const name = userName(user) || 'Contact';
              return (
                <label key={id} className="tg-forward-chat">
                  <input
                    type="checkbox"
                    checked={chosen.includes(id)}
                    onChange={() =>
                      setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
                    }
                  />
                  <Avatar id={id} title={name} photo={user?.profile_photo} size={30} />
                  <span>{name}</span>
                </label>
              );
            })}
            {!shown.length && <p className="tg-list-empty">No contacts.</p>}
          </div>
        </>
      )}
      {error && <p className="tg-error">{error}</p>}
      <div className="tg-dialog-actions">
        <span className="tg-file-progress">
          {kind === 'group' ? `${chosen.length} chosen` : ''}
        </span>
        <button className="tg-link" onClick={onClose}>
          Cancel
        </button>
        <button
          className="tg-link strong"
          disabled={busy || !title.trim() || (kind === 'group' && !chosen.length)}
          onClick={() => void create()}
        >
          Create
        </button>
      </div>
    </Overlay>
  );
}

/** People and channels with stories, over the chat list, as in Telegram's apps. */
export function StoriesBar({ onOpen }: { onOpen: (chatId: number) => void }) {
  const { stories, chats } = useTelegram();
  useEffect(() => {
    void telegramBridge()
      ?.invoke({ '@type': 'loadActiveStories', story_list: { '@type': 'storyListMain' } })
      .catch(() => {});
  }, []);
  const list = [...stories.values()]
    .filter((s) => s.list?.['@type'] !== 'storyListArchive' && chats.has(s.chat_id))
    .sort((a, b) => b.order - a.order);
  if (!list.length) return null;
  return (
    <div className="tg-stories" onPointerDown={(e) => e.stopPropagation()}>
      {list.map((s) => {
        const chat = chats.get(s.chat_id)!;
        const unseen = s.stories.some((i: Td) => i.story_id > s.max_read_story_id);
        return (
          <button
            key={s.chat_id}
            className="tg-story"
            data-unseen={unseen || undefined}
            onClick={() => onOpen(s.chat_id)}
          >
            <Avatar id={chat.id} title={chatTitle(chat)} photo={chat.photo} size={40} />
            <span>{chatTitle(chat).split(' ')[0]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Watching a chat's stories: photos for 6 seconds, videos to their end. */
export function StoryViewer({ chatId, onClose }: { chatId: number; onClose: () => void }) {
  useTelegram();
  const active = storiesOf(chatId);
  const ids = ((active?.stories || []) as Td[]).map((s) => s.story_id as number);
  const firstUnseen = ids.findIndex((id) => id > (active?.max_read_story_id || 0));
  const [index, setIndex] = useState(Math.max(0, firstUnseen));
  const [story, setStory] = useState<Td | null>(null);
  const [progress, setProgress] = useState(0);
  const bridge = telegramBridge()!;
  const id = ids[index];
  useEffect(() => {
    if (!id) return;
    let live = true;
    setStory(null);
    setProgress(0);
    void bridge
      .invoke<Td>({
        '@type': 'getStory',
        story_poster_chat_id: chatId,
        story_id: id,
        only_local: false,
      })
      .then((s) => live && setStory(s))
      .catch(() => live && next());
    void bridge
      .invoke({ '@type': 'openStory', story_poster_chat_id: chatId, story_id: id })
      .catch(() => {});
    return () => {
      live = false;
      void bridge
        .invoke({ '@type': 'closeStory', story_poster_chat_id: chatId, story_id: id })
        .catch(() => {});
    };
  }, [chatId, id]);
  const next = () => (index + 1 < ids.length ? setIndex(index + 1) : onClose());
  const previous = () => setIndex(Math.max(0, index - 1));
  const content = story?.content;
  const photo = content?.['@type'] === 'storyContentPhoto' ? content.photo : null;
  const video = content?.['@type'] === 'storyContentVideo' ? content.video : null;
  const sizes = (photo?.sizes || []) as { photo: TdFile }[];
  const photoUrl = picture(sizes[sizes.length - 1]?.photo, 32);
  const videoUrl = picture(video?.video, 32);
  // Photos advance on a timer once shown.
  useEffect(() => {
    if (!photoUrl) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const p = (Date.now() - started) / 6000;
      setProgress(Math.min(1, p));
      if (p >= 1) next();
    }, 50);
    return () => clearInterval(timer);
  }, [photoUrl, index]);
  const chat = chatOf(chatId);
  return (
    <div
      className="tg-story-viewer"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowRight') next();
        if (e.key === 'ArrowLeft') previous();
      }}
      tabIndex={-1}
      ref={(el) => el?.focus()}
    >
      <div className="tg-story-progress">
        {ids.map((s, i) => (
          <span key={s}>
            <span style={{ width: `${i < index ? 100 : i === index ? progress * 100 : 0}%` }} />
          </span>
        ))}
      </div>
      <div className="tg-story-head">
        {chat && <Avatar id={chat.id} title={chatTitle(chat)} photo={chat.photo} size={30} />}
        <span>{chat ? chatTitle(chat) : ''}</span>
        <small>{story ? listDate(story.date) : ''}</small>
        <span className="tg-tabs-space" />
        <button className="cf-button" aria-label="Close stories" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="tg-story-media">
        {videoUrl ? (
          <video
            src={videoUrl}
            autoPlay
            playsInline
            onTimeUpdate={(e) =>
              setProgress(e.currentTarget.currentTime / (e.currentTarget.duration || 1))
            }
            onEnded={next}
          />
        ) : photoUrl ? (
          <img src={photoUrl} alt="" draggable={false} />
        ) : (
          <Loader2 size={28} className="tg-spin" />
        )}
        <button className="tg-story-nav left" aria-label="Previous story" onClick={previous}>
          <ChevronLeft size={28} />
        </button>
        <button className="tg-story-nav right" aria-label="Next story" onClick={next}>
          <ChevronRight size={28} />
        </button>
      </div>
      {story?.caption?.text && <p className="tg-story-caption">{story.caption.text}</p>}
    </div>
  );
}

/** A call coming in: Terra can decline it; Telegram's apps answer it. */
export function CallBanner({ onError }: { onError: (e: string) => void }) {
  const { call } = useTelegram();
  if (!call || call.is_outgoing || call.state?.['@type'] !== 'callStatePending') return null;
  const who = userName(userOf(call.user_id)) || 'Someone';
  return (
    <div className="tg-call-banner" onPointerDown={(e) => e.stopPropagation()}>
      <Phone size={18} />
      <span>
        <strong>
          {who} is {call.is_video ? 'video ' : ''}calling
        </strong>
        <small>Answer in Telegram on your phone or computer</small>
      </span>
      <button
        className="tg-button danger"
        onClick={() =>
          void telegramBridge()!
            .invoke({
              '@type': 'discardCall',
              call_id: call.id,
              is_disconnected: false,
              invite_link: '',
              duration: 0,
              is_video: !!call.is_video,
              connection_id: 0,
            })
            .catch((e) => onError(message(e)))
        }
      >
        <PhoneOff size={15} /> Decline
      </button>
    </div>
  );
}
