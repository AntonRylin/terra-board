// Telegram frames (type 'file', kind 'telegram'): Terra's own, unofficial
// Telegram client, built on TDLib (Telegram's client library) from the Telegram
// extension. This process runs TDLib; frames draw chats from what it sends.
//
// Privacy: everything stays on this computer, in <Library>/telegram, outside
// boards and cloud sync. The API ID and hash and TDLib's database key are
// encrypted with the system's key store (DPAPI on Windows, via safeStorage);
// the database itself is encrypted by TDLib with that key. Boards keep only
// that a Telegram frame is there, never a chat, message or file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { webmToOgg } = require('./opus-ogg.cjs');

// TDLib's shared library in the extension folder, by platform.
const LIBRARY = { win32: 'tdjson.dll', linux: 'libtdjson.so', darwin: 'libtdjson.dylib' };
// The Visual C++ runtime the Windows build needs, shipped beside it. Loaded
// first by full path, so Windows finds them when it loads tdjson.dll.
const RUNTIME = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];

// What frames may ask TDLib directly. Everything else goes through the named
// operations below, which check their input (files to send, credentials).
const REQUESTS = new Set([
  'getChats',
  'loadChats',
  'getChat',
  'getChatHistory',
  'getMessage',
  'getMessages',
  'openChat',
  'closeChat',
  'viewMessages',
  'getUser',
  'getMe',
  'getBasicGroup',
  'getSupergroup',
  'searchChats',
  'searchChatsOnServer',
  'searchPublicChats',
  'getChatSponsoredMessages',
  'clickChatSponsoredMessage',
  'downloadFile',
  'cancelDownloadFile',
  'getFile',
  'editMessageText',
  'deleteMessages',
  'readAllChatMentions',
  'toggleChatIsMarkedAsUnread',
  'getMessageLink',
  'getInternalLink',
  'requestQrCodeAuthentication',
  'setAuthenticationPhoneNumber',
  'checkAuthenticationCode',
  'checkAuthenticationPassword',
  'checkAuthenticationEmailCode',
  'setAuthenticationEmailAddress',
  'resendAuthenticationCode',
  'getCountryCode',
  'setChatDraftMessage',
  'openMessageContent',
]);
// Message contents a frame may send. Files must have been prepared with
// stage(), so a frame can only send what someone dropped or picked.
const SEND_CONTENTS = new Set([
  'inputMessageText',
  'inputMessageDocument',
  'inputMessagePhoto',
  'inputMessageVideo',
  'inputMessageAudio',
  'inputMessageAnimation',
  'inputMessageVoiceNote',
]);
const FILE_FIELDS = {
  inputMessageDocument: 'document',
  inputMessagePhoto: 'photo',
  inputMessageVideo: 'video',
  inputMessageAudio: 'audio',
  inputMessageAnimation: 'animation',
};
// Updates frames need, besides the chats and users this process keeps.
const FORWARDED = new Set([
  'updateNewMessage',
  'updateMessageSendAcknowledged',
  'updateMessageSendSucceeded',
  'updateMessageSendFailed',
  'updateMessageContent',
  'updateMessageEdited',
  'updateMessageIsPinned',
  'updateMessageInteractionInfo',
  'updateMessageContentOpened',
  'updateMessageMentionRead',
  'updateDeleteMessages',
  'updateFile',
]);
// A sent file larger than Telegram takes (2 GB; Premium allows 4 GB).
const MAX_FILE = 4 * 1024 ** 3;

// Text kept encrypted in a file with the system's key store. Without one, the
// value lives in memory only (Linux without a keyring).
function secretFile(file, safeStorage) {
  const available = () => {
    try {
      return !!safeStorage?.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    available,
    read() {
      if (!available() || !fs.existsSync(file)) return null;
      try {
        return safeStorage.decryptString(fs.readFileSync(file));
      } catch {
        // Encrypted by another Windows user or computer (a copied Library).
        return undefined;
      }
    },
    write(text) {
      if (!available()) return false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, safeStorage.encryptString(text));
      fs.renameSync(temp, file);
      return true;
    },
    clear() {
      fs.rmSync(file, { force: true });
    },
  };
}

// An API ID and hash as people paste them; throws a message for the form.
function credentialsValue(input) {
  const id = String(input?.apiId ?? '').trim();
  const hash = String(input?.apiHash ?? '')
    .trim()
    .toLowerCase();
  if (!/^\d{1,10}$/.test(id) || Number(id) < 1 || Number(id) > 2147483647)
    throw Error('The API ID is the number shown on my.telegram.org.');
  if (!/^[a-f0-9]{32}$/.test(hash))
    throw Error('The API hash is the 32 letters and digits shown on my.telegram.org.');
  return { apiId: Number(id), apiHash: hash };
}

// The chats and people a frame needs to draw the chat list, kept up to date
// from TDLib's updates so that a reloaded frame gets them again at once.
function createState() {
  const chats = new Map();
  const users = new Map();
  const state = { auth: null, connection: null, myId: 0, chats, users };
  // Returns what changed: { chat } / { user } / { auth } / { connection } or null.
  state.apply = (update) => {
    const chat = (id, change) => {
      const current = chats.get(id);
      if (!current) return null;
      const next = { ...current, ...change(current) };
      chats.set(id, next);
      return { chat: next };
    };
    switch (update['@type']) {
      case 'updateAuthorizationState':
        state.auth = update.authorization_state;
        if (state.auth?.['@type'] === 'authorizationStateClosed') {
          chats.clear();
          users.clear();
          state.myId = 0;
        }
        return { auth: state.auth };
      case 'updateConnectionState':
        state.connection = update.state?.['@type'] || null;
        return { connection: state.connection };
      case 'updateOption':
        if (update.name === 'my_id') {
          state.myId = Number(update.value?.value) || 0;
          return { myId: state.myId };
        }
        return null;
      case 'updateNewChat':
        chats.set(update.chat.id, update.chat);
        return { chat: update.chat };
      case 'updateUser':
        users.set(update.user.id, update.user);
        return { user: update.user };
      case 'updateUserStatus': {
        const user = users.get(update.user_id);
        if (!user) return null;
        const next = { ...user, status: update.status };
        users.set(user.id, next);
        return { user: next };
      }
      case 'updateChatTitle':
        return chat(update.chat_id, () => ({ title: update.title }));
      case 'updateChatPhoto':
        return chat(update.chat_id, () => ({ photo: update.photo }));
      case 'updateChatLastMessage':
        return chat(update.chat_id, (c) => ({
          last_message: update.last_message,
          positions: mergePositions(c.positions, update.positions, true),
        }));
      case 'updateChatPosition':
        return chat(update.chat_id, (c) => ({
          positions: mergePositions(c.positions, [update.position]),
        }));
      case 'updateChatAddedToList':
      case 'updateChatRemovedFromList':
        return null;
      case 'updateChatReadInbox':
        return chat(update.chat_id, () => ({
          last_read_inbox_message_id: update.last_read_inbox_message_id,
          unread_count: update.unread_count,
        }));
      case 'updateChatReadOutbox':
        return chat(update.chat_id, () => ({
          last_read_outbox_message_id: update.last_read_outbox_message_id,
        }));
      case 'updateChatUnreadMentionCount':
        return chat(update.chat_id, () => ({ unread_mention_count: update.unread_mention_count }));
      case 'updateMessageMentionRead':
        return chat(update.chat_id, () => ({ unread_mention_count: update.unread_mention_count }));
      case 'updateChatIsMarkedAsUnread':
        return chat(update.chat_id, () => ({ is_marked_as_unread: update.is_marked_as_unread }));
      case 'updateChatNotificationSettings':
        return chat(update.chat_id, () => ({
          notification_settings: update.notification_settings,
        }));
      case 'updateChatDraftMessage':
        return chat(update.chat_id, (c) => ({
          draft_message: update.draft_message,
          positions: mergePositions(c.positions, update.positions, true),
        }));
      case 'updateChatPermissions':
        return chat(update.chat_id, () => ({ permissions: update.permissions }));
      default:
        return null;
    }
  };
  state.snapshot = () => ({
    auth: state.auth,
    connection: state.connection,
    myId: state.myId,
    chats: [...chats.values()],
    users: [...users.values()],
  });
  return state;
}

const listKey = (list) =>
  list?.['@type'] === 'chatListFolder'
    ? `folder:${list.chat_folder_id}`
    : list?.['@type'] || 'chatListMain';
// A chat's places in chat lists after an update. `replace` updates carry every
// position at once; an order of '0' takes the chat out of that list.
function mergePositions(current = [], changes = [], replace = false) {
  const byList = new Map(replace ? [] : current.map((p) => [listKey(p.list), p]));
  for (const p of changes) byList.set(listKey(p.list), p);
  return [...byList.values()].filter((p) => p.order && p.order !== '0');
}

function createTelegram({
  dir,
  location,
  safeStorage,
  load = () => require('koffi'),
  send: deliver = () => {},
  builtIn = () => null,
  appVersion = '0',
  language = 'en',
  readAsset = null,
  platform = process.platform,
}) {
  const credentialStore = secretFile(path.join(dir, 'credentials.bin'), safeStorage);
  const keyStore = secretFile(path.join(dir, 'database-key.bin'), safeStorage);
  const dbDir = path.join(dir, 'database');
  const filesDir = path.join(dir, 'files');
  const outgoingDir = path.join(dir, 'outgoing');
  let memoryCredentials = null;
  let td = null;
  let client = 0;
  let running = false;
  let closing = null;
  let restart = false;
  let wipeOnClose = false;
  let lastError = '';
  let requestId = 0;
  const pending = new Map();
  const staged = new Set();
  let state = createState();
  // Changes waiting to go to the frames, sent at most every 40 ms.
  let batch = null;
  const flush = () => {
    const b = batch;
    batch = null;
    if (!b) return;
    deliver({
      ...(b.auth !== undefined && { auth: b.auth }),
      ...(b.connection !== undefined && { connection: b.connection }),
      ...(b.myId !== undefined && { myId: b.myId }),
      ...(b.status && { status: status() }),
      chats: [...b.chats.values()],
      users: [...b.users.values()],
      events: [...b.events, ...b.files.values()],
    });
  };
  const queue = () => {
    if (!batch) {
      batch = { chats: new Map(), users: new Map(), events: [], files: new Map() };
      setTimeout(flush, 40);
    }
    return batch;
  };
  const changed = () => {
    queue().status = true;
  };

  const credentials = () => {
    if (memoryCredentials) return memoryCredentials;
    const saved = credentialStore.read();
    if (saved)
      try {
        return credentialsValue(JSON.parse(saved));
      } catch {
        /* Damaged: ask again. */
      }
    const given = builtIn();
    if (given)
      try {
        return credentialsValue(given);
      } catch {
        /* A broken build setting: ask. */
      }
    return null;
  };
  const libraryFile = () => {
    const folder = location();
    const file = folder && LIBRARY[platform] && path.join(folder, LIBRARY[platform]);
    return file && fs.existsSync(file) ? file : null;
  };

  function status() {
    const own = !!memoryCredentials || credentialStore.read() != null;
    return {
      supported: !!LIBRARY[platform],
      installed: !!libraryFile(),
      credentials: !!credentials(),
      // Credentials someone entered here (not built into the app) can be removed.
      ownCredentials: own,
      canRemember: credentialStore.available(),
      running: !!client,
      error: lastError,
    };
  }

  function library() {
    if (td) return td;
    const file = libraryFile();
    if (!file) throw Error('Install the Telegram extension in Settings → Extensions first.');
    const koffi = load();
    const runtime = [];
    if (platform === 'win32')
      for (const name of RUNTIME) {
        const dll = path.join(path.dirname(file), name);
        if (fs.existsSync(dll)) runtime.push(koffi.load(dll));
      }
    const lib = koffi.load(file);
    td = {
      lib,
      runtime,
      create: lib.func('int td_create_client_id()'),
      send: lib.func('void td_send(int client_id, const char* request)'),
      receive: lib.func('const char* td_receive(double timeout)'),
      execute: lib.func('const char* td_execute(const char* request)'),
    };
    // Errors only; TDLib's log would otherwise hold chat details.
    td.execute(JSON.stringify({ '@type': 'setLogVerbosityLevel', new_verbosity_level: 1 }));
    return td;
  }

  // TDLib answers on a worker thread (td_receive waits up to a second), so the
  // app never waits for it.
  function loop() {
    if (running || !td) return;
    running = true;
    const next = () => {
      if (!client && !closing) {
        running = false;
        return;
      }
      td.receive.async(1.0, (error, text) => {
        if (error) {
          running = false;
          lastError = String(error.message || error);
          changed();
          return;
        }
        if (text)
          try {
            handle(JSON.parse(text));
          } catch (e) {
            lastError = String(e.message || e);
          }
        next();
      });
    };
    next();
  }

  function request(query) {
    if (!client || !td) return Promise.reject(Error('Telegram isn’t running.'));
    const extra = String(++requestId);
    return new Promise((resolve, reject) => {
      pending.set(extra, { resolve, reject });
      td.send(client, JSON.stringify({ ...query, '@extra': extra }));
    });
  }

  function handle(event) {
    if (event['@client_id'] !== undefined && event['@client_id'] !== client) return;
    const extra = event['@extra'];
    if (extra !== undefined && pending.has(extra)) {
      const { resolve, reject } = pending.get(extra);
      pending.delete(extra);
      delete event['@extra'];
      delete event['@client_id'];
      if (event['@type'] === 'error') {
        const error = Error(event.message || 'Telegram refused this.');
        error.code = event.code;
        reject(error);
      } else resolve(event);
      return;
    }
    delete event['@client_id'];
    const type = event['@type'];
    if (type === 'updateAuthorizationState') onAuthorization(event.authorization_state);
    const change = state.apply(event);
    if (change) {
      const b = queue();
      if (change.chat) b.chats.set(change.chat.id, change.chat);
      if (change.user) b.users.set(change.user.id, change.user);
      if ('auth' in change) b.auth = change.auth;
      if ('connection' in change) b.connection = change.connection;
      if ('myId' in change) b.myId = change.myId;
    }
    if (type === 'updateFile') queue().files.set(event.file.id, event);
    else if (FORWARDED.has(type)) queue().events.push(event);
    // Sent files leave the outgoing folder once Telegram has them.
    if (type === 'updateMessageSendSucceeded' || type === 'updateMessageSendFailed')
      setTimeout(sweepOutgoing, 60000);
  }

  function onAuthorization(auth) {
    const type = auth?.['@type'];
    if (type === 'authorizationStateWaitTdlibParameters') void parameters();
    if (type === 'authorizationStateReady') lastError = '';
    if (type === 'authorizationStateClosed') {
      client = 0;
      for (const { reject } of pending.values()) reject(Error('Telegram closed.'));
      pending.clear();
      if (wipeOnClose) {
        wipeOnClose = false;
        wipe();
      }
      const resolve = closing;
      closing = null;
      resolve?.();
      changed();
      if (restart) {
        restart = false;
        setTimeout(() => {
          try {
            start();
          } catch (e) {
            lastError = String(e.message || e);
            changed();
          }
        }, 0);
      }
    }
  }

  // The database key: random, kept encrypted by the system. A key this user
  // can't decrypt (a Library copied from another computer) starts over.
  function databaseKey() {
    if (!keyStore.available()) return '';
    const saved = keyStore.read();
    if (saved) return saved;
    if (saved === undefined || fs.existsSync(dbDir)) wipe();
    const key = randomBytes(32).toString('base64');
    keyStore.write(key);
    return key;
  }

  async function parameters() {
    const given = credentials();
    if (!given) {
      lastError = 'Add an API ID and hash first.';
      changed();
      return;
    }
    try {
      await request({
        '@type': 'setTdlibParameters',
        use_test_dc: false,
        database_directory: dbDir,
        files_directory: filesDir,
        database_encryption_key: databaseKey(),
        use_file_database: true,
        use_chat_info_database: true,
        use_message_database: true,
        use_secret_chats: false,
        api_id: given.apiId,
        api_hash: given.apiHash,
        system_language_code: language,
        device_model: 'Terra Board',
        system_version: `${os.type()} ${os.release()}`,
        application_version: appVersion,
      });
    } catch (error) {
      lastError = error.message;
      changed();
      // A database this key doesn't open: start over with a new one.
      if (/encrypt|database/i.test(error.message)) {
        wipeOnClose = true;
        restart = true;
        td.send(client, JSON.stringify({ '@type': 'close' }));
      }
    }
  }

  function wipe() {
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(filesDir, { recursive: true, force: true });
    fs.rmSync(outgoingDir, { recursive: true, force: true });
    keyStore.clear();
  }

  function start() {
    if (client) return status();
    if (!credentials()) throw Error('Add an API ID and hash first.');
    library();
    fs.mkdirSync(dir, { recursive: true });
    state = createState();
    client = td.create();
    lastError = '';
    loop();
    // A first request wakes the client; its updates then start arriving.
    td.send(client, JSON.stringify({ '@type': 'getOption', name: 'version' }));
    changed();
    return status();
  }

  // Closes TDLib so that its database is written out (quitting, removing the
  // extension). Waits at most `timeout` ms.
  function stop(timeout = 3000) {
    restart = false;
    if (!client || !td) return Promise.resolve();
    const done = new Promise((resolve) => {
      closing = resolve;
      td.send(client, JSON.stringify({ '@type': 'close' }));
    });
    return waitAtMost(done, timeout);
  }
  // Lets go of TDLib's library so its folder can be removed.
  async function unload() {
    await stop();
    if (!td || client) return;
    try {
      td.lib.unload?.();
      for (const lib of td.runtime) lib.unload?.();
    } catch {
      /* Removed when the app restarts. */
    }
    td = null;
  }

  async function invoke(query) {
    if (!query || typeof query !== 'object' || typeof query['@type'] !== 'string')
      throw Error('Invalid Telegram request');
    const type = query['@type'];
    if (type === 'sendMessage') return sendMessage(query);
    if (!REQUESTS.has(type)) throw Error(`Terra doesn’t send ${type} to Telegram.`);
    if (!client) start();
    return request(query);
  }

  // Rebuilt from the fields Terra uses, so a request can carry no other file
  // (thumbnails, covers) than the one checked here.
  function sendMessage(query) {
    const content = query.input_message_content;
    const kind = content?.['@type'];
    if (!SEND_CONTENTS.has(kind)) throw Error('Terra can send text and files only.');
    const text = formatted(kind === 'inputMessageText' ? content.text : content.caption);
    let input;
    if (kind === 'inputMessageText') {
      if (!text.text.trim()) throw Error('Write a message first.');
      input = { '@type': kind, text, clear_draft: true };
    } else if (kind === 'inputMessageVoiceNote') {
      // A recording made by voice(): its file, length and loudness bars.
      const file = content.voice_note;
      const local = file?.['@type'] === 'inputFileLocal' ? path.resolve(String(file.path)) : null;
      if (!local || !staged.has(local)) throw Error('Record the voice message again.');
      const waveform = typeof content.waveform === 'string' ? content.waveform : '';
      if (waveform.length > 200 || !/^[A-Za-z0-9+/]*={0,2}$/.test(waveform))
        throw Error('Invalid voice message');
      input = {
        '@type': kind,
        voice_note: { '@type': 'inputFileLocal', path: local },
        duration: Math.max(1, Math.min(3600, Math.round(Number(content.duration) || 1))),
        waveform,
        caption: text,
      };
    } else {
      const field = FILE_FIELDS[kind];
      const file = content[field]?.[field];
      const local = file?.['@type'] === 'inputFileLocal' ? path.resolve(String(file.path)) : null;
      if (!local || !staged.has(local)) throw Error('Drop or choose the file again.');
      const inner = `input${field[0].toUpperCase()}${field.slice(1)}`;
      input = {
        '@type': kind,
        [field]: { '@type': inner, [field]: { '@type': 'inputFileLocal', path: local } },
        caption: text,
      };
    }
    const chatId = Number(query.chat_id);
    const replyTo = Number(query.reply_to?.message_id);
    if (!Number.isSafeInteger(chatId)) throw Error('Invalid chat');
    return request({
      '@type': 'sendMessage',
      chat_id: chatId,
      ...(Number.isSafeInteger(replyTo) &&
        replyTo > 0 && {
          reply_to: { '@type': 'inputMessageReplyToMessage', message_id: replyTo },
        }),
      input_message_content: input,
    });
  }

  // Files someone dropped on a frame or picked, made ready to send: board
  // pictures and documents are copied out under their own names; files on
  // this computer are sent from where they are.
  async function stage(sources) {
    if (!Array.isArray(sources) || !sources.length || sources.length > 100)
      throw Error('Invalid files');
    const result = [];
    for (const source of sources) {
      if (source && typeof source.path === 'string') {
        const file = path.resolve(source.path);
        const info = await fs.promises.stat(file);
        if (!info.isFile()) throw Error(`${path.basename(file)} is a folder; send files.`);
        if (info.size > MAX_FILE) throw Error(`${path.basename(file)} is too large for Telegram.`);
        staged.add(file);
        result.push({ path: file, name: path.basename(file), size: info.size });
      } else if (source && typeof source.assetId === 'string' && readAsset) {
        if (!/^[a-f0-9]{64}$/.test(source.assetId)) throw Error('Invalid file');
        const asset = await readAsset({ id: source.assetId, variant: 'original' });
        const name = fileName(source.name || asset.name, asset.mime);
        const folder = path.join(outgoingDir, randomUUID());
        await fs.promises.mkdir(folder, { recursive: true });
        const file = path.join(folder, name);
        await fs.promises.copyFile(asset.file, file);
        staged.add(file);
        result.push({ path: file, name, size: (await fs.promises.stat(file)).size });
      } else throw Error('Invalid file');
    }
    return result;
  }

  // A voice message recorded in a frame (Opus in WebM, as Chromium records)
  // saved as Ogg Opus, the way Telegram's apps send them.
  async function voice(input) {
    const bytes = input instanceof Uint8Array ? input : null;
    if (!bytes || !bytes.length || bytes.length > 64 * 1024 * 1024)
      throw Error('The recording is empty or too long.');
    const { bytes: ogg, seconds } = webmToOgg(bytes);
    const folder = path.join(outgoingDir, randomUUID());
    await fs.promises.mkdir(folder, { recursive: true });
    const file = path.join(folder, 'Voice message.ogg');
    await fs.promises.writeFile(file, ogg);
    staged.add(file);
    return { path: file, seconds };
  }

  // Copies made for sending stay until Telegram has uploaded them; anything
  // older than a day goes at start or after a send.
  function sweepOutgoing() {
    let names = [];
    try {
      names = fs.readdirSync(outgoingDir);
    } catch {
      return;
    }
    const day = Date.now() - 24 * 3600 * 1000;
    for (const name of names) {
      const folder = path.join(outgoingDir, name);
      try {
        if (fs.statSync(folder).mtimeMs < day) {
          for (const file of fs.readdirSync(folder)) staged.delete(path.join(folder, file));
          fs.rmSync(folder, { recursive: true, force: true });
        }
      } catch {
        /* Still in use; next time. */
      }
    }
  }

  // A downloaded file's path, only inside Telegram's own folders.
  async function localFile(id) {
    const fileId = Number(id);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw Error('Invalid file');
    const file = await request({ '@type': 'getFile', file_id: fileId });
    const local = file.local?.is_downloading_completed ? path.resolve(file.local.path) : '';
    if (!local || !ownFile(local)) throw Error('This file isn’t downloaded yet.');
    return local;
  }
  // Downloads a file (if needed) and returns where it is, for the board or a drag.
  async function download(id) {
    const fileId = Number(id);
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw Error('Invalid file');
    if (!client) start();
    await request({ '@type': 'downloadFile', file_id: fileId, priority: 32, synchronous: true });
    return localFile(fileId);
  }

  async function setCredentials(input) {
    const value = credentialsValue(input);
    if (client && state.auth?.['@type'] === 'authorizationStateReady')
      throw Error('Sign out of Telegram before changing the API ID.');
    if (!credentialStore.write(JSON.stringify(value))) memoryCredentials = value;
    else memoryCredentials = null;
    lastError = '';
    // Start again with the new credentials.
    if (client) {
      restart = true;
      wipeOnClose = true;
      td.send(client, JSON.stringify({ '@type': 'close' }));
    } else start();
    changed();
    return status();
  }

  // Signs out on Telegram's side and deletes everything kept here.
  async function logOut() {
    if (!client) {
      wipe();
      changed();
      return status();
    }
    restart = true;
    wipeOnClose = true;
    try {
      await request({ '@type': 'logOut' });
    } catch {
      td.send(client, JSON.stringify({ '@type': 'close' }));
    }
    return status();
  }

  // Also forgets the API ID and hash entered here.
  async function forget() {
    memoryCredentials = null;
    credentialStore.clear();
    if (client) {
      restart = false;
      wipeOnClose = true;
      const done = new Promise((resolve) => (closing = resolve));
      try {
        await request({ '@type': 'logOut' });
      } catch {
        td.send(client, JSON.stringify({ '@type': 'close' }));
      }
      await waitAtMost(done, 5000);
    } else wipe();
    changed();
    return status();
  }

  // Telegram's own files: downloads, copies made for sending, and the
  // pictures TDLib keeps beside its database (profile photos, thumbnails,
  // stickers), never the database itself.
  const pictureDirs = ['profile_photos', 'thumbnails', 'stickers', 'wallpapers'].map((d) =>
    path.join(dbDir, d),
  );
  function ownFile(local) {
    return (
      within(filesDir, local) ||
      within(outgoingDir, local) ||
      pictureDirs.some((dir) => within(dir, local)) ||
      staged.has(local)
    );
  }
  // A file a frame shows as downloaded, if it is one of Telegram's own.
  function draggable(file) {
    if (typeof file !== 'string' || !file) return null;
    const local = path.resolve(file);
    if (!ownFile(local)) return null;
    return fs.existsSync(local) ? local : null;
  }

  sweepOutgoing();
  return {
    draggable,
    status,
    snapshot: () => ({ ...state.snapshot(), status: status() }),
    start,
    stop,
    unload,
    invoke,
    stage,
    voice,
    download,
    localFile,
    setCredentials,
    logOut,
    forget,
    paths: { dir, dbDir, filesDir, outgoingDir },
  };
}

// A message text as TDLib takes it: plain text and its formatting entities.
function formatted(value) {
  const text = typeof value?.text === 'string' ? value.text.slice(0, 4096) : '';
  const entities = Array.isArray(value?.entities)
    ? value.entities
        .filter(
          (e) =>
            e?.['@type'] === 'textEntity' &&
            Number.isSafeInteger(e.offset) &&
            Number.isSafeInteger(e.length) &&
            typeof e.type?.['@type'] === 'string',
        )
        .slice(0, 1000)
    : [];
  return { '@type': 'formattedText', text, entities };
}

// Waits for a promise, at most `ms`, leaving no timer behind.
function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => (timer = setTimeout(resolve, ms))),
  ]).finally(() => clearTimeout(timer));
}

function within(base, file) {
  const relative = path.relative(base, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// A file name for a board picture or document sent to a chat.
const extensions = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
};
function fileName(name, mime) {
  let result = String(name || 'File')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/, '')
    .slice(0, 180);
  if (!result || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(result)) result = 'File';
  const ext = extensions[mime];
  if (ext && !path.extname(result)) result += ext;
  return result;
}

// The renderer's channels: canvas:telegram-<name>.
function registerTelegram({ ipcMain, trusted, telegram, dialog, getWindow, dragIcon }) {
  const handle = (name, task) =>
    ipcMain.handle(`canvas:telegram-${name}`, async (event, args) => {
      trusted(event);
      return task(args, event);
    });
  handle('status', () => telegram.status());
  handle('snapshot', () => telegram.snapshot());
  handle('start', () => telegram.start());
  handle('invoke', (query) => telegram.invoke(query));
  handle('stage', (sources) => telegram.stage(sources));
  handle('voice', (bytes) => telegram.voice(bytes));
  handle('download', (id) => telegram.download(id));
  handle('credentials', (input) => telegram.setCredentials(input));
  handle('log-out', () => telegram.logOut());
  handle('forget', () => telegram.forget());
  handle('pick', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Send files',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return [];
    return telegram.stage(result.filePaths.slice(0, 100).map((file) => ({ path: file })));
  });
  // A downloaded file dragged out as a real file: to the board, Explorer or
  // other apps. Synchronous, as Windows starts the drag only while the button
  // is still down.
  ipcMain.on('canvas:telegram-drag', (event, { path: file, icon } = {}) => {
    try {
      trusted(event);
      const local = telegram.draggable(file);
      if (local) event.sender.startDrag({ file: local, icon: dragIcon(icon) });
    } catch {
      /* Not downloaded: the frame drags it as a Telegram file instead. */
    }
  });
}

// Serves downloaded files to frames as terra-telegram://file/<id>.
function telegramResponse(telegram, assetResponse, mimeOf) {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.replace(/^\/+/, '');
      if (url.hostname !== 'file' || !/^\d+$/.test(id)) throw Error('Invalid file');
      const file = await telegram.localFile(id);
      const response = assetResponse(
        { file, contentType: mimeOf(file) },
        request.headers.get('range'),
      );
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      headers.delete('Access-Control-Allow-Origin');
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      if (process.env.TERRA_TELEGRAM_DEBUG) console.error('telegram file', request.url, e);
      return new Response('Not found', { status: 404 });
    }
  };
}

// The type of a downloaded file, for frames to show it.
const mimes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};
// TDLib names some downloads without an extension (photos, stickers).
function mimeOf(file) {
  const known = mimes[path.extname(file).toLowerCase()];
  if (known) return known;
  try {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
    if (head.subarray(1, 4).toString() === 'PNG') return 'image/png';
    if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP')
      return 'image/webp';
    if (head.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
    if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
    if (head.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  } catch {
    /* Unknown. */
  }
  return 'application/octet-stream';
}

module.exports = {
  mimeOf,
  createTelegram,
  registerTelegram,
  telegramResponse,
  createState,
  mergePositions,
  credentialsValue,
  secretFile,
  fileName,
  LIBRARY,
  RUNTIME,
};
