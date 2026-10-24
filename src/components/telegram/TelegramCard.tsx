// A Telegram frame (type 'file', kind 'telegram'): Terra's unofficial Telegram
// client on the board. The board keeps only that the frame is there; sign-in,
// chats and files stay in electron/telegram.cjs on this PC.
import { useEffect, useState, type FormEvent, type PointerEvent, type ReactNode } from 'react';
import {
  Download,
  Globe,
  KeyRound,
  LogOut,
  MessageCircle,
  MoreHorizontal,
  Phone,
  QrCode as QrIcon,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Camera, CanvasObject } from '../../model';
import { localToWorld } from '../../canvas/transform';
import type { MenuItem } from '../Dialogs';
import { useExtensions } from '../../extensions';
import { QrCode } from './qr';
import {
  refreshTelegram,
  setTelegramStatus,
  startTelegram,
  telegramBridge,
  useTelegram,
} from './telegram-store';
import { TelegramChats } from './TelegramChats';
import type { Td } from './td';
import './telegram.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const telegramHeader = 48;

export interface TelegramFrameActions {
  onError: (message: string) => void;
  openMenu: (menu: { x: number; y: number; items: (MenuItem | null)[] } | null) => void;
  /** Adds downloaded Telegram files to the board beside the frame. */
  addFiles: (items: { path: string; name: string }[]) => void;
  /** Adds text from a message to the board beside the frame. */
  addText: (text: string) => void;
  openLink: (url: string) => void;
  /** Turns the frame into a browser frame with Telegram Web instead. */
  useWeb?: () => void;
}

export function TelegramCard({
  object: o,
  camera,
  active,
  host,
  select,
  forward,
  actions,
}: {
  object: CanvasObject;
  camera: Camera;
  active: boolean;
  host: HTMLDivElement | null;
  select: (id: string) => void;
  forward: (event: PointerEvent) => void;
  actions: TelegramFrameActions;
}) {
  const bridge = telegramBridge();
  const { status, auth, connection, chats } = useTelegram();
  useEffect(() => {
    startTelegram().catch((error) => actions.onError(message(error)));
  }, []);
  const authType = auth?.['@type'] as string | undefined;
  const ready = authType === 'authorizationStateReady';
  const tiny = o.width * camera.zoom < 220 || o.height * camera.zoom < 160;

  let unread = 0;
  if (ready && tiny)
    for (const chat of chats.values())
      if (chat.positions?.some((p) => p.list?.['@type'] === 'chatListMain') && !muted(chat))
        unread += chat.unread_count;

  let content: ReactNode;
  if (!bridge)
    content = <Message icon>Telegram chats work in the Terra Board desktop app.</Message>;
  else if (!status) content = <Message>Starting…</Message>;
  else if (!status.supported)
    content = <Message icon>Telegram chats aren’t available on this system yet.</Message>;
  else if (tiny)
    content = <div className="cf-message cf-summary">{ready ? unread || '✓' : '…'}</div>;
  else if (!status.installed)
    content = <Install onError={actions.onError} onWeb={actions.useWeb} />;
  else if (!status.credentials)
    content = <Credentials canRemember={status.canRemember} onLink={actions.openLink} />;
  else if (ready) content = <TelegramChats object={o} camera={camera} actions={actions} />;
  else if (!authType || authType === 'authorizationStateWaitTdlibParameters')
    content = <Message>{status.error || 'Connecting to Telegram…'}</Message>;
  else if (
    authType === 'authorizationStateLoggingOut' ||
    authType === 'authorizationStateClosing' ||
    authType === 'authorizationStateClosed'
  )
    content = <Message>Signing out…</Message>;
  else content = <Login auth={auth!} onLink={actions.openLink} />;

  const menu = (x: number, y: number) =>
    actions.openMenu({
      x,
      y,
      items: [
        ready
          ? {
              label: 'Sign out of Telegram',
              icon: <LogOut />,
              action: () =>
                void bridge
                  ?.logOut()
                  .then(setTelegramStatus)
                  .catch((e) => actions.onError(message(e))),
            }
          : null,
        status?.ownCredentials
          ? {
              label: 'Sign out and remove the API ID',
              icon: <KeyRound />,
              danger: true,
              action: () =>
                void bridge
                  ?.forget()
                  .then(setTelegramStatus)
                  .catch((e) => actions.onError(message(e))),
            }
          : null,
        !ready && actions.useWeb
          ? { label: 'Use Telegram Web instead', icon: <Globe />, action: actions.useWeb }
          : null,
        {
          label: 'About this Telegram client',
          icon: <ShieldCheck />,
          action: () => actions.openLink('https://core.telegram.org/api/terms'),
        },
      ],
    });

  const origin = localToWorld(o, { x: 0, y: 0 });
  return (
    <section
      className="canvas-folder canvas-telegram"
      data-file-id={o.id}
      data-selected={active || undefined}
      aria-label="Telegram"
      style={{
        left: origin.x * camera.zoom + camera.x,
        top: origin.y * camera.zoom + camera.y,
        width: o.width,
        height: o.height,
        transform: `scale(${camera.zoom}) rotate(${o.rotation || 0}deg)`,
      }}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest('.tg-body')) return;
        event.preventDefault();
        select(o.id);
        host?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
    >
      <header
        className="cf-header"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
          forward(event);
        }}
      >
        <span className="cf-title-icon">
          <MessageCircle size={18} />
        </span>
        <span className="cf-title">
          Telegram
          {ready && connection && connection !== 'connectionStateReady' && (
            <span className="cf-crumb"> · {connectionLabel(connection)}</span>
          )}
        </span>
        {bridge && status?.installed && (
          <button
            className="cf-button"
            aria-label="Telegram menu"
            title="Telegram menu"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              menu(r.left, r.bottom + 4);
            }}
          >
            <MoreHorizontal size={18} />
          </button>
        )}
      </header>
      <div className="tg-body" style={{ height: o.height - telegramHeader }}>
        {content}
      </div>
    </section>
  );
}

const muted = (chat: { notification_settings?: { mute_for: number } }) =>
  (chat.notification_settings?.mute_for ?? 0) > 0;
const connectionLabel = (state: string) =>
  ({
    connectionStateWaitingForNetwork: 'waiting for network',
    connectionStateConnectingToProxy: 'connecting',
    connectionStateConnecting: 'connecting',
    connectionStateUpdating: 'updating',
  })[state] || '';

function Message({ children, icon }: { children: ReactNode; icon?: boolean }) {
  return (
    <div className="cf-message">
      {icon && <MessageCircle size={36} strokeWidth={1.5} />}
      <p>{children}</p>
    </div>
  );
}

// Telegram is an extension: TDLib downloads only for people who want it.
function Install({ onError, onWeb }: { onError: (message: string) => void; onWeb?: () => void }) {
  const list = useExtensions();
  const entry = list?.find((e) => e.id === 'telegram');
  useEffect(() => {
    if (entry?.state === 'installed') void refreshTelegram().catch(() => {});
  }, [entry?.state]);
  const size = entry ? `${Math.round(entry.downloadBytes / 1048576)} MB` : '';
  const progress = entry?.progress;
  const percent =
    progress && progress.total ? Math.round((progress.received * 100) / progress.total) : 0;
  return (
    <div className="cf-message tg-setup">
      <MessageCircle size={40} strokeWidth={1.4} />
      <h3>Telegram on your board</h3>
      <p>
        Chat, send board pictures and files, and drag photos from chats onto the board. Terra’s
        Telegram client is an extension: install it once on this PC.
      </p>
      {!entry ? (
        <p className="tg-note">This build of Terra Board has no Telegram extension.</p>
      ) : entry.state === 'installing' ? (
        <>
          <div className="tg-progress" role="progressbar" aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </div>
          <button
            className="tg-button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void window.canvas?.extensions.cancel('telegram')}
          >
            <X size={15} /> Cancel
          </button>
        </>
      ) : (
        <button
          className="tg-button primary"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() =>
            void window.canvas?.extensions.install('telegram').catch((e) => onError(message(e)))
          }
        >
          <Download size={15} /> Install Telegram ({size})
        </button>
      )}
      {entry?.error && <p className="tg-error">{entry.error}</p>}
      <p className="tg-note">You can remove it again in Settings → Extensions.</p>
      {onWeb && (
        <div className="tg-alternative">
          <p>
            Or use <strong>Telegram Web</strong> in a browser frame: nothing to install, Telegram’s
            own web app. Terra keeps no pictures of it.
          </p>
          <button className="tg-button" onPointerDown={(e) => e.stopPropagation()} onClick={onWeb}>
            <Globe size={15} /> Use Telegram Web
          </button>
        </div>
      )}
    </div>
  );
}

// An API ID and hash identify a Telegram app. Each person can use their own
// (my.telegram.org); a release can also carry Terra's.
function Credentials({
  canRemember,
  onLink,
}: {
  canRemember: boolean;
  onLink: (url: string) => void;
}) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const bridge = telegramBridge();
    if (!bridge) return;
    setBusy(true);
    setError('');
    try {
      setTelegramStatus(await bridge.setCredentials({ apiId, apiHash }));
    } catch (e) {
      setError(message(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="tg-setup tg-form" onSubmit={submit} onPointerDown={(e) => e.stopPropagation()}>
      <KeyRound size={34} strokeWidth={1.5} />
      <h3>Connect Terra to Telegram</h3>
      <p>
        Telegram apps need an API ID and hash. Get yours at{' '}
        <a
          href="https://my.telegram.org/apps"
          onClick={(e) => {
            e.preventDefault();
            onLink('https://my.telegram.org/apps');
          }}
        >
          my.telegram.org
        </a>{' '}
        → API development tools, then paste them here.
      </p>
      <label>
        API ID
        <input
          value={apiId}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiId(e.target.value)}
          placeholder="1234567"
        />
      </label>
      <label>
        API hash
        <input
          value={apiHash}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setApiHash(e.target.value)}
          placeholder="32 letters and digits"
        />
      </label>
      {error && <p className="tg-error">{error}</p>}
      <button className="tg-button primary" disabled={busy || !apiId || !apiHash}>
        Continue
      </button>
      <p className="tg-note">
        <ShieldCheck size={13} />{' '}
        {canRemember
          ? 'Kept only on this PC, encrypted by Windows. Never added to boards or synced.'
          : 'Kept only while Terra is open: this system has no key store to encrypt it.'}
      </p>
    </form>
  );
}

const clean = (error: unknown) =>
  message(error)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    .replace(/^PHONE_CODE_INVALID$/, 'That code isn’t right. Check it and try again.')
    .replace(/^PASSWORD_HASH_INVALID$/, 'That password isn’t right.')
    .replace(/^PHONE_NUMBER_INVALID$/, 'That phone number isn’t right. Include the country code.')
    .replace(
      /^API_ID_INVALID$/,
      'Telegram didn’t accept this API ID and hash. Check them on my.telegram.org.',
    )
    .replace(/^PHONE_CODE_EXPIRED$/, 'The code expired. Ask for a new one.');

// Survives the sign-in starting over when switching from a QR code.
let preferredMethod: 'qr' | 'phone' = 'qr';

function Login({ auth, onLink }: { auth: Td; onLink: (url: string) => void }) {
  const bridge = telegramBridge()!;
  const type = auth['@type'] as string;
  const [method, choose] = useState<'qr' | 'phone'>(preferredMethod);
  const setMethod = (next: 'qr' | 'phone') => {
    preferredMethod = next;
    // A QR sign-in already waiting can't switch to a phone number; start over.
    if (next === 'phone' && type === 'authorizationStateWaitOtherDeviceConfirmation')
      void bridge
        .logOut()
        .then(setTelegramStatus)
        .catch(() => {});
    choose(next);
  };
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (query: Td) => {
    setBusy(true);
    setError('');
    try {
      await bridge.invoke(query);
      setValue('');
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };
  // Signing in with a QR code from the phone needs no typing: ask for one.
  useEffect(() => {
    if (type === 'authorizationStateWaitPhoneNumber' && method === 'qr')
      void run({ '@type': 'requestQrCodeAuthentication', other_user_ids: [] });
  }, [type, method]);
  useEffect(() => setValue(''), [type]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;
    if (type === 'authorizationStateWaitCode')
      void run({ '@type': 'checkAuthenticationCode', code: text });
    else if (type === 'authorizationStateWaitPassword')
      void run({ '@type': 'checkAuthenticationPassword', password: value });
    else if (type === 'authorizationStateWaitEmailAddress')
      void run({ '@type': 'setAuthenticationEmailAddress', email_address: text });
    else if (type === 'authorizationStateWaitEmailCode')
      void run({
        '@type': 'checkAuthenticationEmailCode',
        code: { '@type': 'emailAddressAuthenticationCode', code: text },
      });
    else void run({ '@type': 'setAuthenticationPhoneNumber', phone_number: text });
  };
  const intro = (
    <p className="tg-note">
      <ShieldCheck size={13} /> An unofficial Telegram client in Terra Board, using the{' '}
      <a
        href="https://core.telegram.org/api"
        onClick={(e) => {
          e.preventDefault();
          onLink('https://core.telegram.org/api');
        }}
      >
        Telegram API
      </a>
      . Your sign-in and chats stay on this PC.
    </p>
  );
  const field = (label: string, input: ReactNode, button: string) => (
    <form className="tg-setup tg-form" onSubmit={submit} onPointerDown={(e) => e.stopPropagation()}>
      <MessageCircle size={34} strokeWidth={1.5} />
      <h3>{label}</h3>
      {input}
      {error && <p className="tg-error">{error}</p>}
      <button className="tg-button primary" disabled={busy || !value.trim()}>
        {button}
      </button>
      {intro}
    </form>
  );

  if (type === 'authorizationStateWaitCode') {
    const info = auth.code_info || {};
    const where =
      info.type?.['@type'] === 'authenticationCodeTypeTelegramMessage'
        ? 'in your Telegram app on another device'
        : info.type?.['@type'] === 'authenticationCodeTypeSms'
          ? `by SMS to ${info.phone_number}`
          : info.type?.['@type'] === 'authenticationCodeTypeCall'
            ? `by a call to ${info.phone_number}`
            : `to ${info.phone_number}`;
    return field(
      'Enter the code',
      <>
        <p>Telegram sent a code {where}.</p>
        <input
          autoFocus
          value={value}
          inputMode="numeric"
          autoComplete="one-time-code"
          onChange={(e) => setValue(e.target.value)}
          placeholder="Code"
        />
        {info.next_type && (
          <button
            type="button"
            className="tg-link"
            onClick={() => void run({ '@type': 'resendAuthenticationCode', reason: null })}
          >
            Send the code another way
          </button>
        )}
      </>,
      'Sign in',
    );
  }
  if (type === 'authorizationStateWaitPassword')
    return field(
      'Two-step verification',
      <>
        <p>
          Enter your Telegram cloud password
          {auth.password_hint ? ` (hint: ${auth.password_hint})` : ''}.
        </p>
        <input
          autoFocus
          type="password"
          value={value}
          autoComplete="current-password"
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
        />
      </>,
      'Sign in',
    );
  if (type === 'authorizationStateWaitEmailAddress')
    return field(
      'Add an email address',
      <input
        autoFocus
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Email"
      />,
      'Continue',
    );
  if (type === 'authorizationStateWaitEmailCode')
    return field(
      'Enter the email code',
      <input
        autoFocus
        value={value}
        inputMode="numeric"
        onChange={(e) => setValue(e.target.value)}
        placeholder="Code"
      />,
      'Continue',
    );
  if (type === 'authorizationStateWaitRegistration')
    return (
      <div className="cf-message tg-setup">
        <MessageCircle size={34} strokeWidth={1.5} />
        <p>
          This phone number has no Telegram account yet. Sign up in a Telegram app first, then sign
          in here.
        </p>
        <button
          className="tg-button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void bridge.logOut().then(setTelegramStatus)}
        >
          Start over
        </button>
      </div>
    );
  if (method === 'qr' && type === 'authorizationStateWaitOtherDeviceConfirmation')
    return (
      <div className="tg-setup tg-qr-panel" onPointerDown={(e) => e.stopPropagation()}>
        <QrCode text={auth.link} size={200} />
        <h3>Scan with Telegram on your phone</h3>
        <ol>
          <li>Open Telegram on your phone</li>
          <li>Settings → Devices → Link Desktop Device</li>
          <li>Point the phone at this code</li>
        </ol>
        <button className="tg-link" onClick={() => setMethod('phone')}>
          <Phone size={13} /> Sign in with a phone number instead
        </button>
        {intro}
      </div>
    );
  if (method === 'qr')
    return (
      <div className="cf-message">
        <p>{error || 'Getting a sign-in code…'}</p>
        {error && (
          <button className="tg-link" onClick={() => setMethod('phone')}>
            <Phone size={13} /> Sign in with a phone number instead
          </button>
        )}
      </div>
    );
  return field(
    'Sign in to Telegram',
    <>
      <p>Your phone number, with the country code.</p>
      <input
        autoFocus
        type="tel"
        value={value}
        autoComplete="tel"
        onChange={(e) => setValue(e.target.value)}
        placeholder="+1 555 123 4567"
      />
      <button type="button" className="tg-link" onClick={() => setMethod('qr')}>
        <QrIcon size={13} /> Sign in with a QR code instead
      </button>
    </>,
    'Next',
  );
}
