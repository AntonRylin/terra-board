// A stand-in for TDLib's JSON interface, for scripts/desktop-telegram.mjs:
// a signed-in account with a few chats, so the Telegram frame can be checked
// without a real Telegram account. Electron's main process loads it in place
// of koffi only when running from source with TERRA_TELEGRAM_FAKE set
// (electron/main.cjs); packaged apps never do. Pictures come from
// TERRA_TELEGRAM_FAKE_MEDIA (avatar-<n>.png, photo-<n>.png, brief.pdf).
const fs = require('node:fs');
const path = require('node:path');

const source = process.env.TERRA_TELEGRAM_FAKE_MEDIA || '';
// Copied into TDLib's files folder once the frame sets it, as real downloads are.
let media = source;
let profiles = source;
const now = Math.floor(Date.now() / 1000);
const queue = [];
let clientId = 0;
let auth = 'authorizationStateWaitTdlibParameters';
let nextMessage = 1000;
const files = new Map();
const histories = new Map();
const sent = [];

const emit = (event) => queue.push(JSON.stringify({ ...event, '@client_id': clientId }));
const reply = (query, result) => emit({ ...result, '@extra': query['@extra'] });
const fail = (query, code, message) =>
  emit({ '@type': 'error', code, message, '@extra': query['@extra'] });
const setAuth = (type, extra = {}) => {
  auth = type;
  emit({ '@type': 'updateAuthorizationState', authorization_state: { '@type': type, ...extra } });
};

function file(id, name, { downloaded = true, size } = {}) {
  // Profile photos sit beside TDLib's database, as real TDLib keeps them.
  const local = name ? path.join(name.startsWith('avatar-') ? profiles : media, name) : '';
  const exists = local && fs.existsSync(local);
  const f = {
    '@type': 'file',
    id,
    size: size ?? (exists ? fs.statSync(local).size : 48000),
    expected_size: size ?? (exists ? fs.statSync(local).size : 48000),
    local: {
      '@type': 'localFile',
      path: downloaded && exists ? local : '',
      can_be_downloaded: true,
      can_be_deleted: true,
      is_downloading_active: false,
      is_downloading_completed: downloaded && !!exists,
      download_offset: 0,
      downloaded_prefix_size: 0,
      downloaded_size: downloaded && exists ? fs.statSync(local).size : 0,
    },
    remote: {
      '@type': 'remoteFile',
      id: `r${id}`,
      unique_id: `u${id}`,
      is_uploading_active: false,
      is_uploading_completed: true,
      uploaded_size: 0,
    },
    _name: name,
  };
  files.set(id, f);
  return f;
}
const pub = (f) => {
  const { _name, ...rest } = f;
  return rest;
};

const me = 100;
const makeUsers = () =>
  [
    { id: me, first_name: 'You', last_name: '' },
    { id: 101, first_name: 'Maria', last_name: 'Lopez', photo: 1 },
    { id: 102, first_name: 'Alex', last_name: 'Kim', photo: 2 },
    { id: 103, first_name: 'Sam', last_name: 'Ortega', photo: 3 },
    { id: 104, first_name: 'Dana', last_name: 'Wu' },
    { id: 105, first_name: 'Weather Bot', last_name: '', bot: true },
  ].map((u) => ({
    '@type': 'user',
    id: u.id,
    first_name: u.first_name,
    last_name: u.last_name,
    phone_number: '',
    status: { '@type': u.id === 101 ? 'userStatusOnline' : 'userStatusRecently' },
    type: u.bot ? { '@type': 'userTypeBot' } : { '@type': 'userTypeRegular' },
    ...(u.photo && {
      profile_photo: {
        '@type': 'profilePhoto',
        id: String(u.photo),
        small: pub(file(10 + u.photo, `avatar-${u.photo}.png`)),
        big: pub(file(20 + u.photo, `avatar-${u.photo}.png`)),
      },
    }),
  }));
let users = [];

const text = (value, entities = []) => ({ '@type': 'formattedText', text: value, entities });
const private_ = (userId) => ({ '@type': 'chatTypePrivate', user_id: userId });
const chats = [
  {
    id: 100,
    title: 'You',
    type: private_(100),
    order: '2000',
    pinned: true,
    unread: 0,
  },
  {
    id: 105,
    title: 'Weather Bot',
    type: private_(105),
    order: '450',
    unread: 0,
  },
  {
    id: 1,
    title: 'Design team',
    type: { '@type': 'chatTypeBasicGroup', basic_group_id: 7 },
    order: '900',
    photo: 4,
    unread: 3,
  },
  {
    id: 101,
    title: 'Maria Lopez',
    type: private_(101),
    order: '800',
    photo: 1,
    unread: 0,
    pinned: true,
  },
  {
    id: -1003,
    title: 'Terra news',
    type: { '@type': 'chatTypeSupergroup', supergroup_id: 3, is_channel: true },
    order: '700',
    photo: 5,
    unread: 1,
  },
  { id: 102, title: 'Alex Kim', type: private_(102), order: '600', photo: 2, unread: 2 },
  {
    id: 2,
    title: 'Family',
    type: { '@type': 'chatTypeBasicGroup', basic_group_id: 8 },
    order: '500',
    unread: 12,
    muted: true,
  },
  { id: 104, title: 'Dana Wu', type: private_(104), order: '400', unread: 0 },
];

function message(chatId, senderId, minutesAgo, content, extra = {}) {
  return {
    '@type': 'message',
    id: nextMessage++,
    sender_id:
      senderId > 0
        ? { '@type': 'messageSenderUser', user_id: senderId }
        : { '@type': 'messageSenderChat', chat_id: chatId },
    chat_id: chatId,
    is_outgoing: senderId === me,
    is_pinned: false,
    is_channel_post: senderId < 0,
    can_be_deleted_only_for_self: true,
    can_be_deleted_for_all_users: senderId === me,
    date: now - minutesAgo * 60,
    edit_date: 0,
    content,
    ...extra,
  };
}
const photo = (id, name, w, h, caption = '') => ({
  '@type': 'messagePhoto',
  photo: {
    '@type': 'photo',
    has_stickers: false,
    sizes: [
      {
        '@type': 'photoSize',
        type: 'x',
        photo: pub(file(id, name)),
        width: w,
        height: h,
        progressive_sizes: [],
      },
    ],
  },
  caption: text(caption),
  show_caption_above_media: false,
  has_spoiler: false,
  is_secret: false,
});

function seed() {
  const add = (m) => {
    if (!histories.has(m.chat_id)) histories.set(m.chat_id, []);
    histories.get(m.chat_id).push(m);
  };
  add(
    message(100, me, 400, {
      '@type': 'messageText',
      text: text('Ideas for the board: folders, Telegram'),
    }),
  );
  add(
    message(1, 104, 200, {
      '@type': 'messagePoll',
      poll: {
        '@type': 'poll',
        id: '77',
        question: text('Team lunch day?'),
        options: ['Tuesday', 'Wednesday', 'Friday'].map((o, i) => ({
          '@type': 'pollOption',
          id: String(i),
          text: text(o),
          voter_count: i === 0 ? 2 : 1,
          vote_percentage: i === 0 ? 50 : 25,
          is_chosen: false,
          is_being_chosen: false,
        })),
        total_voter_count: 4,
        is_anonymous: false,
        allows_multiple_answers: false,
        type: { '@type': 'pollTypeRegular', allow_adding_options: false },
        is_closed: false,
      },
    }),
  );
  add(
    message(
      105,
      105,
      20,
      { '@type': 'messageText', text: text('Vienna: 14°C, light rain.') },
      {
        reply_markup: {
          '@type': 'replyMarkupInlineKeyboard',
          rows: [
            [
              {
                '@type': 'inlineKeyboardButton',
                text: 'Refresh',
                type: { '@type': 'inlineKeyboardButtonTypeCallback', data: 'cmVmcmVzaA==' },
              },
              {
                '@type': 'inlineKeyboardButton',
                text: 'Forecast',
                type: {
                  '@type': 'inlineKeyboardButtonTypeUrl',
                  url: 'https://example.com/forecast',
                },
              },
            ],
          ],
        },
      },
    ),
  );
  add(
    message(
      105,
      105,
      19,
      { '@type': 'messageText', text: text('Choose a day:') },
      {
        reply_markup: {
          '@type': 'replyMarkupShowKeyboard',
          rows: [
            [
              {
                '@type': 'keyboardButton',
                text: 'Today',
                type: { '@type': 'keyboardButtonTypeText' },
              },
              {
                '@type': 'keyboardButton',
                text: 'Tomorrow',
                type: { '@type': 'keyboardButtonTypeText' },
              },
            ],
          ],
          is_persistent: true,
          resize_keyboard: true,
          one_time: false,
        },
      },
    ),
  );
  add(
    message(1, 103, 300, {
      '@type': 'messageText',
      text: text('Morning! The new board layout is up.'),
    }),
  );
  add(
    message(1, me, 290, {
      '@type': 'messageText',
      text: text('Nice, I’ll pin it to the project board.'),
    }),
  );
  add(message(1, 101, 120, photo(31, 'photo-1.png', 1200, 800, 'Moodboard for the landing page')));
  add(
    message(1, 102, 60, {
      '@type': 'messageDocument',
      document: {
        '@type': 'document',
        file_name: 'Brief.pdf',
        mime_type: 'application/pdf',
        document: pub(file(41, 'brief.pdf', { downloaded: false })),
      },
      caption: text(''),
    }),
  );
  add(
    message(1, 103, 12, {
      '@type': 'messageText',
      text: text('Details are on https://example.com/brief — comments welcome', [
        { '@type': 'textEntity', offset: 15, length: 25, type: { '@type': 'textEntityTypeUrl' } },
      ]),
    }),
  );
  add(
    message(101, 101, 1500, { '@type': 'messageText', text: text('Are we still on for Friday?') }),
  );
  add(message(101, me, 1490, { '@type': 'messageText', text: text('Yes! 3pm works.') }));
  add(message(101, 101, 30, photo(32, 'photo-2.png', 900, 1200)));
  add(message(101, 101, 29, { '@type': 'messageText', text: text('Look what I found 😄') }));
  add(
    message(
      -1003,
      -1,
      200,
      photo(
        33,
        'photo-3.png',
        1280,
        720,
        'Terra Board 0.1.38 is out: folder frames, desktops and app frames.',
      ),
    ),
  );
  add(message(102, 102, 8, { '@type': 'messageText', text: text('Can you send me the sketch?') }));
  add(
    message(102, 102, 7, {
      '@type': 'messageVoiceNote',
      voice_note: {
        '@type': 'voiceNote',
        duration: 14,
        waveform: '',
        mime_type: 'audio/ogg',
        voice: pub(file(51, '', { downloaded: false, size: 22000 })),
      },
      caption: text(''),
      is_listened: false,
    }),
  );
  add(message(2, 104, 45, { '@type': 'messageText', text: text('Dinner on Sunday?') }));
  add(message(104, me, 3000, { '@type': 'messageText', text: text('Thanks for yesterday!') }));
}

function chatObject(c) {
  const history = histories.get(c.id) || [];
  return {
    '@type': 'chat',
    id: c.id,
    type: c.type,
    title: c.title,
    ...(c.photo && {
      photo: {
        '@type': 'chatPhotoInfo',
        small: pub(file(60 + c.photo, `avatar-${c.photo}.png`)),
        big: pub(file(70 + c.photo, `avatar-${c.photo}.png`)),
        has_animation: false,
        is_personal: false,
      },
    }),
    last_message: history[history.length - 1],
    positions: [],
    unread_count: c.unread,
    unread_mention_count: 0,
    last_read_inbox_message_id: c.unread
      ? (history[history.length - 1 - c.unread]?.id ?? 0)
      : (history[history.length - 1]?.id ?? 0),
    last_read_outbox_message_id: history[history.length - 1]?.id ?? 0,
    is_marked_as_unread: false,
    notification_settings: {
      '@type': 'chatNotificationSettings',
      mute_for: c.muted ? 2147483647 : 0,
    },
    permissions: { '@type': 'chatPermissions', can_send_basic_messages: true },
    // The bot's keyboard comes from its newest message that set one.
    reply_markup_message_id:
      history.filter((m) => m.reply_markup?.['@type'] === 'replyMarkupShowKeyboard').pop()?.id || 0,
  };
}

function ready() {
  users = makeUsers();
  emit({
    '@type': 'updateOption',
    name: 'my_id',
    value: { '@type': 'optionValueInteger', value: String(me) },
  });
  for (const u of users) emit({ '@type': 'updateUser', user: u });
  for (const c of chats) emit({ '@type': 'updateNewChat', chat: chatObject(c) });
  emit({ '@type': 'updateConnectionState', state: { '@type': 'connectionStateReady' } });
  emit({
    '@type': 'updateChatFolders',
    chat_folders: [{ '@type': 'chatFolderInfo', id: 1, name: { text: { text: 'Work' } } }],
    main_chat_list_position: 0,
  });
  setAuth('authorizationStateReady');
}

// Chat lists: where each chat is (main, archive, the Work folder).
const listed = new Map(); // chat id -> { main, archive }
const position = (chatId, list, order, pinned = false) =>
  emit({
    '@type': 'updateChatPosition',
    chat_id: chatId,
    position: { '@type': 'chatPosition', list, order: String(order), is_pinned: pinned },
  });
const findMessage = (chatId, id) => (histories.get(chatId) || []).find((m) => m.id === id);

const loadedLists = new Set();
const scheduled = new Map();
// Stickers from the Terra set: pictures from the media folder.
const stickerOf = (id) => ({
  '@type': 'sticker',
  id: String(id),
  set_id: '5001',
  width: 512,
  height: 512,
  emoji: id === 81 ? '👍' : '🎨',
  format: { '@type': 'stickerFormatWebp' },
  full_type: { '@type': 'stickerFullTypeRegular' },
  sticker: pub(files.get(id) || file(id, id === 81 ? 'avatar-2.png' : 'avatar-3.png')),
});
function handle(query) {
  const type = query['@type'];
  switch (type) {
    case 'getOption':
      reply(query, { '@type': 'optionValueString', value: '1.8.67' });
      if (auth === 'authorizationStateWaitTdlibParameters') setAuth(auth);
      return;
    case 'setTdlibParameters':
      media = path.join(query.files_directory, 'photos');
      fs.mkdirSync(media, { recursive: true });
      profiles = path.join(query.database_directory, 'profile_photos');
      fs.mkdirSync(profiles, { recursive: true });
      for (const name of source ? fs.readdirSync(source) : [])
        fs.copyFileSync(
          path.join(source, name),
          path.join(name.startsWith('avatar-') ? profiles : media, name),
        );
      reply(query, { '@type': 'ok' });
      seed();
      setAuth('authorizationStateWaitPhoneNumber');
      return;
    case 'requestQrCodeAuthentication':
      reply(query, { '@type': 'ok' });
      setAuth('authorizationStateWaitOtherDeviceConfirmation', {
        link: 'tg://login?token=VGVycmEgQm9hcmQgdGVzdCBsb2dpbiB0b2tlbg',
      });
      // "Scanned" a moment later (TERRA_TELEGRAM_FAKE_SCAN ms, default 4 s).
      setTimeout(ready, Number(process.env.TERRA_TELEGRAM_FAKE_SCAN || 4000));
      return;
    case 'setAuthenticationPhoneNumber':
      reply(query, { '@type': 'ok' });
      setAuth('authorizationStateWaitCode', {
        code_info: {
          '@type': 'authenticationCodeInfo',
          phone_number: query.phone_number,
          type: { '@type': 'authenticationCodeTypeTelegramMessage', length: 5 },
          timeout: 60,
        },
      });
      return;
    case 'checkAuthenticationCode':
      reply(query, { '@type': 'ok' });
      ready();
      return;
    case 'loadChats': {
      const list = query.chat_list || { '@type': 'chatListMain' };
      const key = list['@type'] + (list.chat_folder_id || '');
      if (loadedLists.has(key)) return fail(query, 404, 'Not Found');
      loadedLists.add(key);
      if (list['@type'] === 'chatListMain')
        for (const c of chats) position(c.id, list, c.order, !!c.pinned);
      if (list['@type'] === 'chatListFolder')
        for (const c of chats.filter((c) => c.id === 1 || c.id === -1003))
          position(c.id, list, c.order);
      return reply(query, { '@type': 'ok' });
    }
    case 'toggleChatIsPinned': {
      const c = chats.find((c) => c.id === query.chat_id);
      position(query.chat_id, query.chat_list, c?.order || 1, query.is_pinned);
      if (c) c.pinned = query.is_pinned;
      return reply(query, { '@type': 'ok' });
    }
    case 'addChatToList': {
      const c = chats.find((c) => c.id === query.chat_id);
      const toArchive = query.chat_list['@type'] === 'chatListArchive';
      position(query.chat_id, { '@type': toArchive ? 'chatListMain' : 'chatListArchive' }, 0);
      position(query.chat_id, query.chat_list, c?.order || 1);
      return reply(query, { '@type': 'ok' });
    }
    case 'setChatNotificationSettings':
      emit({
        '@type': 'updateChatNotificationSettings',
        chat_id: query.chat_id,
        notification_settings: query.notification_settings,
      });
      return reply(query, { '@type': 'ok' });
    case 'getMessage': {
      const m = findMessage(query.chat_id, query.message_id);
      return m ? reply(query, m) : fail(query, 404, 'Message not found');
    }
    case 'setPollAnswer': {
      const m = findMessage(query.chat_id, query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      const poll = m.content.poll;
      poll.options = poll.options.map((o, i) => ({
        ...o,
        is_chosen: query.option_ids.includes(i),
        voter_count: o.voter_count + (query.option_ids.includes(i) ? 1 : 0),
      }));
      poll.total_voter_count += query.option_ids.length ? 1 : 0;
      poll.options = poll.options.map((o) => ({
        ...o,
        vote_percentage: Math.round((o.voter_count * 100) / poll.total_voter_count),
      }));
      emit({
        '@type': 'updateMessageContent',
        chat_id: m.chat_id,
        message_id: m.id,
        new_content: m.content,
      });
      return reply(query, { '@type': 'ok' });
    }
    case 'searchChatMessages': {
      const q = String(query.query || '').toLowerCase();
      const found = (histories.get(query.chat_id) || [])
        .filter((m) => JSON.stringify(m.content).toLowerCase().includes(q))
        .reverse();
      return reply(query, {
        '@type': 'foundChatMessages',
        total_count: found.length,
        messages: found,
        next_from_message_id: 0,
      });
    }
    case 'getInstalledStickerSets':
      return reply(query, {
        '@type': 'stickerSets',
        total_count: 1,
        sets: [
          {
            '@type': 'stickerSetInfo',
            id: '5001',
            title: 'Terra',
            name: 'terra',
            covers: [],
            size: 2,
          },
        ],
      });
    case 'getStickerSet':
      return reply(query, {
        '@type': 'stickerSet',
        id: '5001',
        title: 'Terra',
        name: 'terra',
        stickers: [stickerOf(81), stickerOf(82)],
      });
    case 'getRecentStickers':
      return reply(query, { '@type': 'stickers', stickers: [] });
    case 'getSavedAnimations':
      return reply(query, {
        '@type': 'animations',
        animations: [
          {
            '@type': 'animation',
            duration: 2,
            width: 320,
            height: 200,
            file_name: 'gif.mp4',
            mime_type: 'video/mp4',
            thumbnail: {
              '@type': 'thumbnail',
              format: { '@type': 'thumbnailFormatJpeg' },
              width: 320,
              height: 200,
              file: pub(file(91, 'photo-1.png')),
            },
            animation: pub(file(92, '', { downloaded: false, size: 90000 })),
          },
        ],
      });
    case 'getChatScheduledMessages':
      return reply(query, {
        '@type': 'messages',
        total_count: 0,
        messages: (scheduled.get(query.chat_id) || []).slice().reverse(),
      });
    case 'editMessageSchedulingState': {
      const list = scheduled.get(query.chat_id) || [];
      const m = list.find((x) => x.id === query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      scheduled.set(
        query.chat_id,
        list.filter((x) => x !== m),
      );
      emit({
        '@type': 'updateDeleteMessages',
        chat_id: query.chat_id,
        message_ids: [m.id],
        is_permanent: true,
        from_cache: false,
      });
      const now = {
        ...m,
        id: nextMessage++,
        scheduling_state: undefined,
        date: Math.floor(Date.now() / 1000),
      };
      histories.get(query.chat_id)?.push(now);
      emit({ '@type': 'updateNewMessage', message: now });
      return reply(query, { '@type': 'ok' });
    }
    case 'getCallbackQueryAnswer':
      return reply(query, {
        '@type': 'callbackQueryAnswer',
        text: 'Updated: 15°C',
        show_alert: false,
        url: '',
      });
    case 'getContacts':
      return reply(query, { '@type': 'users', total_count: 4, user_ids: [101, 102, 103, 104] });
    case 'createNewBasicGroupChat': {
      const c = {
        id: 9,
        title: query.title,
        type: { '@type': 'chatTypeBasicGroup', basic_group_id: 9 },
        order: '1200',
        unread: 0,
      };
      chats.push(c);
      histories.set(9, [
        message(9, me, 0, {
          '@type': 'messageBasicGroupChatCreate',
          title: query.title,
          member_user_ids: query.user_ids,
        }),
      ]);
      emit({ '@type': 'updateNewChat', chat: chatObject(c) });
      position(9, { '@type': 'chatListMain' }, 1200);
      return reply(query, {
        '@type': 'createdBasicGroupChat',
        chat_id: 9,
        failed_to_add_members: { '@type': 'failedToAddMembers', failed_to_add_members: [] },
      });
    }
    case 'loadActiveStories':
      emit({
        '@type': 'updateChatActiveStories',
        active_stories: {
          '@type': 'chatActiveStories',
          chat_id: 101,
          list: { '@type': 'storyListMain' },
          order: 10,
          max_read_story_id: 0,
          stories: [
            { '@type': 'storyInfo', story_id: 1, date: now - 3600, is_for_close_friends: false },
            { '@type': 'storyInfo', story_id: 2, date: now - 600, is_for_close_friends: false },
          ],
        },
      });
      return fail(query, 404, 'Not Found');
    case 'getStory':
      return reply(query, {
        '@type': 'story',
        id: query.story_id,
        poster_chat_id: query.story_poster_chat_id,
        date: now - 600,
        content: {
          '@type': 'storyContentPhoto',
          photo: {
            '@type': 'photo',
            sizes: [
              {
                '@type': 'photoSize',
                type: 'x',
                photo: pub(
                  file(95 + query.story_id, query.story_id === 1 ? 'photo-2.png' : 'photo-3.png'),
                ),
                width: 900,
                height: 1200,
              },
            ],
          },
        },
        caption: text(query.story_id === 1 ? 'Morning in Vienna' : 'Board day'),
      });
    case 'discardCall':
      emit({
        '@type': 'updateCall',
        call: {
          '@type': 'call',
          id: query.call_id,
          user_id: 101,
          is_outgoing: false,
          is_video: false,
          state: {
            '@type': 'callStateDiscarded',
            reason: { '@type': 'callDiscardReasonDeclined' },
          },
        },
      });
      return reply(query, { '@type': 'ok' });
    case 'getMessageProperties': {
      const m = findMessage(query.chat_id, query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      return reply(query, {
        '@type': 'messageProperties',
        can_be_edited: m.is_outgoing && m.content['@type'] === 'messageText',
        can_be_forwarded: true,
        can_be_pinned: true,
        can_be_replied: true,
        can_get_link: query.chat_id === -1003,
        can_be_deleted_only_for_self: true,
        can_be_deleted_for_all_users: m.is_outgoing,
      });
    }
    case 'getMessageAvailableReactions':
      return reply(query, {
        '@type': 'availableReactions',
        top_reactions: ['👍', '❤', '🔥', '🎉', '😁', '😢'].map((emoji) => ({
          '@type': 'availableReaction',
          type: { '@type': 'reactionTypeEmoji', emoji },
          needs_premium: false,
        })),
        recent_reactions: [],
        popular_reactions: [],
        allow_custom_emoji: false,
        are_tags: false,
      });
    case 'addMessageReaction':
    case 'removeMessageReaction': {
      const m = findMessage(query.chat_id, query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      const emoji = query.reaction_type.emoji;
      const reactions = (m.interaction_info?.reactions?.reactions || []).filter(
        (r) => r.type.emoji !== emoji,
      );
      if (type === 'addMessageReaction')
        reactions.push({
          '@type': 'messageReaction',
          type: { '@type': 'reactionTypeEmoji', emoji },
          total_count: 1,
          is_chosen: true,
          recent_sender_ids: [],
        });
      m.interaction_info = {
        '@type': 'messageInteractionInfo',
        view_count: 0,
        forward_count: 0,
        reactions: { '@type': 'messageReactions', reactions, are_tags: false, paid_reactors: [] },
      };
      emit({
        '@type': 'updateMessageInteractionInfo',
        chat_id: m.chat_id,
        message_id: m.id,
        interaction_info: m.interaction_info,
      });
      return reply(query, { '@type': 'ok' });
    }
    case 'editMessageText': {
      const m = findMessage(query.chat_id, query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      m.content = { '@type': 'messageText', text: query.input_message_content.text };
      m.edit_date = Math.floor(Date.now() / 1000);
      emit({
        '@type': 'updateMessageContent',
        chat_id: m.chat_id,
        message_id: m.id,
        new_content: m.content,
      });
      emit({
        '@type': 'updateMessageEdited',
        chat_id: m.chat_id,
        message_id: m.id,
        edit_date: m.edit_date,
      });
      return reply(query, m);
    }
    case 'pinChatMessage':
    case 'unpinChatMessage': {
      const m = findMessage(query.chat_id, query.message_id);
      if (!m) return fail(query, 404, 'Message not found');
      m.is_pinned = type === 'pinChatMessage';
      emit({
        '@type': 'updateMessageIsPinned',
        chat_id: m.chat_id,
        message_id: m.id,
        is_pinned: m.is_pinned,
      });
      return reply(query, { '@type': 'ok' });
    }
    case 'getChatPinnedMessage': {
      const m = (histories.get(query.chat_id) || []).filter((m) => m.is_pinned).pop();
      return m ? reply(query, m) : fail(query, 404, 'Not Found');
    }
    case 'deleteMessages': {
      const history = histories.get(query.chat_id) || [];
      histories.set(
        query.chat_id,
        history.filter((m) => !query.message_ids.includes(m.id)),
      );
      emit({
        '@type': 'updateDeleteMessages',
        chat_id: query.chat_id,
        message_ids: query.message_ids,
        is_permanent: true,
        from_cache: false,
      });
      return reply(query, { '@type': 'ok' });
    }
    case 'forwardMessages': {
      const source = findMessage(query.from_chat_id, query.message_ids[0]);
      if (!source) return fail(query, 404, 'Message not found');
      const copy = {
        ...message(query.chat_id, me, 0, source.content),
        forward_info: { '@type': 'messageForwardInfo', date: source.date },
      };
      if (!histories.has(query.chat_id)) histories.set(query.chat_id, []);
      histories.get(query.chat_id).push(copy);
      emit({ '@type': 'updateNewMessage', message: copy });
      emit({
        '@type': 'updateChatLastMessage',
        chat_id: query.chat_id,
        last_message: copy,
        positions: [
          {
            '@type': 'chatPosition',
            list: { '@type': 'chatListMain' },
            order: '1000',
            is_pinned: false,
          },
        ],
      });
      return reply(query, { '@type': 'messages', total_count: 1, messages: [copy] });
    }
    case 'getChatHistory': {
      const history = histories.get(query.chat_id) || [];
      const from = query.from_message_id || Infinity;
      const older = history
        .filter((m) => m.id < from)
        .reverse()
        .slice(0, query.limit || 50);
      return reply(query, { '@type': 'messages', total_count: older.length, messages: older });
    }
    case 'openChat':
    case 'closeChat':
    case 'clickChatSponsoredMessage':
      return reply(query, { '@type': 'ok' });
    case 'viewMessages': {
      const chat = chats.find((c) => c.id === query.chat_id);
      if (chat && chat.unread && !String(query.message_ids?.[0]).startsWith('9')) {
        chat.unread = 0;
        const history = histories.get(chat.id) || [];
        emit({
          '@type': 'updateChatReadInbox',
          chat_id: chat.id,
          last_read_inbox_message_id: history[history.length - 1]?.id || 0,
          unread_count: 0,
        });
      }
      return reply(query, { '@type': 'ok' });
    }
    case 'getChatSponsoredMessages':
      return reply(query, {
        '@type': 'sponsoredMessages',
        messages_between: 0,
        messages:
          query.chat_id === -1003
            ? [
                {
                  '@type': 'sponsoredMessage',
                  message_id: 9001,
                  is_recommended: false,
                  can_be_reported: true,
                  content: {
                    '@type': 'messageText',
                    text: text(
                      'An example of Telegram’s sponsored messages, which clients must show in channels.',
                    ),
                  },
                  sponsor: {
                    '@type': 'advertisementSponsor',
                    url: 'https://example.com/',
                    info: '',
                  },
                  title: 'Sponsored example',
                  button_text: 'Open',
                  accent_color_id: 0,
                  background_custom_emoji_id: '0',
                  additional_info: '',
                },
              ]
            : [],
      });
    case 'getSupergroup':
      return reply(query, {
        '@type': 'supergroup',
        id: query.supergroup_id,
        status: { '@type': 'chatMemberStatusMember' },
        is_channel: true,
      });
    case 'getFile':
    case 'downloadFile': {
      const f = files.get(query.file_id);
      if (!f) return fail(query, 404, 'File not found');
      if (type === 'downloadFile' && !f.local.is_downloading_completed) {
        const source = f._name ? path.join(media, f._name) : '';
        if (source && fs.existsSync(source)) {
          f.local = {
            ...f.local,
            path: source,
            is_downloading_completed: true,
            downloaded_size: f.size,
          };
          emit({ '@type': 'updateFile', file: pub(f) });
        }
      }
      return reply(query, pub(f));
    }
    case 'sendMessage': {
      const content = query.input_message_content;
      // As strict as TDLib 1.8.67: each file sits in its input object.
      const shape = {
        inputMessagePhoto: ['photo', 'inputPhoto'],
        inputMessageDocument: ['document', 'inputDocument'],
        inputMessageVideo: ['video', 'inputVideo'],
        inputMessageVoiceNote: ['voice_note', 'inputVoiceNote'],
        inputMessageSticker: ['sticker', 'inputSticker'],
        inputMessageAnimation: ['animation', 'inputAnimation'],
      }[content?.['@type']];
      if (shape) {
        const [field, inner] = shape;
        const outer = content[field];
        if (
          outer?.['@type'] !== inner ||
          !['inputFileLocal', 'inputFileId', 'inputFileRemote'].includes(outer[field]?.['@type'])
        )
          return fail(query, 400, 'InputFile is not specified');
      }
      if (
        content['@type'] === 'inputMessageSticker' ||
        content['@type'] === 'inputMessageAnimation'
      ) {
        const id = content.sticker?.sticker?.id ?? content.animation?.animation?.id;
        const f = files.get(id);
        const shownCloud =
          content['@type'] === 'inputMessageSticker'
            ? {
                '@type': 'messageSticker',
                sticker: { ...stickerOf(id), sticker: pub(f) },
                is_premium: false,
              }
            : {
                '@type': 'messageAnimation',
                animation: {
                  '@type': 'animation',
                  duration: 2,
                  width: 320,
                  height: 200,
                  file_name: 'gif.mp4',
                  mime_type: 'video/mp4',
                  thumbnail: {
                    '@type': 'thumbnail',
                    format: { '@type': 'thumbnailFormatJpeg' },
                    width: 320,
                    height: 200,
                    file: pub(files.get(91)),
                  },
                  animation: pub(f),
                },
                caption: text(''),
                show_caption_above_media: false,
                has_spoiler: false,
                is_secret: false,
              };
        const sentCloud = message(query.chat_id, me, 0, shownCloud);
        histories.get(query.chat_id)?.push(sentCloud);
        reply(query, sentCloud);
        emit({ '@type': 'updateNewMessage', message: sentCloud });
        return;
      }
      const sendAt = query.options?.scheduling_state?.send_date;
      if (sendAt && content['@type'] === 'inputMessageText') {
        const later = {
          ...message(query.chat_id, me, 0, { '@type': 'messageText', text: content.text }),
          scheduling_state: { '@type': 'messageSchedulingStateSendAtDate', send_date: sendAt },
        };
        if (!scheduled.has(query.chat_id)) scheduled.set(query.chat_id, []);
        scheduled.get(query.chat_id).push(later);
        reply(query, later);
        // TDLib announces scheduled messages too; frames keep them out of the chat.
        emit({ '@type': 'updateNewMessage', message: later });
        return;
      }
      if (content['@type'] === 'inputMessageText' && content.text?.text === 'call me')
        setTimeout(
          () =>
            emit({
              '@type': 'updateCall',
              call: {
                '@type': 'call',
                id: 31,
                user_id: 101,
                is_outgoing: false,
                is_video: false,
                state: { '@type': 'callStatePending', is_created: true, is_received: true },
              },
            }),
          600,
        );
      let shown;
      if (content['@type'] === 'inputMessageText')
        shown = { '@type': 'messageText', text: content.text };
      else if (content['@type'] === 'inputMessageVoiceNote') {
        const note = content.voice_note;
        const local = note.voice_note.path;
        const id = 500 + sent.length;
        files.set(id, {
          ...file(id, ''),
          local: {
            path: local,
            can_be_downloaded: false,
            can_be_deleted: true,
            is_downloading_active: false,
            is_downloading_completed: true,
            downloaded_size: fs.statSync(local).size,
          },
          size: fs.statSync(local).size,
          _name: '',
        });
        shown = {
          '@type': 'messageVoiceNote',
          voice_note: {
            '@type': 'voiceNote',
            duration: note.duration,
            waveform: note.waveform,
            mime_type: 'audio/ogg',
            voice: pub(files.get(id)),
          },
          caption: content.caption,
          is_listened: false,
        };
      } else {
        const field = {
          inputMessagePhoto: 'photo',
          inputMessageDocument: 'document',
          inputMessageVideo: 'video',
        }[content['@type']];
        const local = content[field][field].path;
        const id = 500 + sent.length;
        const upload = () =>
          files.set(id, {
            ...file(id, ''),
            local: {
              path: local,
              can_be_downloaded: false,
              can_be_deleted: true,
              is_downloading_active: false,
              is_downloading_completed: true,
              downloaded_size: fs.statSync(local).size,
            },
            size: fs.statSync(local).size,
            _name: '',
          });
        upload();
        shown =
          field === 'photo'
            ? photo(id, '', 800, 600, content.caption?.text || '')
            : {
                '@type': 'messageDocument',
                document: {
                  '@type': 'document',
                  file_name: path.basename(local),
                  mime_type: '',
                  document: pub(files.get(id)),
                },
                caption: content.caption,
              };
        upload();
        if (field === 'photo') shown.photo.sizes[0].photo = pub(files.get(id));
      }
      const m = message(query.chat_id, me, 0, shown, {
        sending_state: { '@type': 'messageSendingStatePending' },
      });
      sent.push(query);
      if (!histories.has(m.chat_id)) histories.set(m.chat_id, []);
      reply(query, m);
      emit({ '@type': 'updateNewMessage', message: m });
      // Files go up in steps, as TDLib reports uploads.
      const uploading = shown['@type'] === 'messageText' ? null : files.get(500 + sent.length - 1);
      const steps = uploading ? [0.25, 0.6, 1] : [];
      steps.forEach((part, i) =>
        setTimeout(
          () => {
            const size = uploading.size;
            emit({
              '@type': 'updateFile',
              file: pub({
                ...uploading,
                remote: {
                  ...uploading.remote,
                  is_uploading_active: part < 1,
                  is_uploading_completed: part >= 1,
                  uploaded_size: Math.round(size * part),
                },
              }),
            });
          },
          500 * (i + 1),
        ),
      );
      setTimeout(
        () => {
          const done = { ...m, id: nextMessage++, sending_state: undefined };
          histories.get(m.chat_id).push(done);
          emit({ '@type': 'updateMessageSendSucceeded', message: done, old_message_id: m.id });
          const chat = chats.find((c) => c.id === m.chat_id);
          if (chat)
            emit({
              '@type': 'updateChatLastMessage',
              chat_id: chat.id,
              last_message: done,
              positions: [
                {
                  '@type': 'chatPosition',
                  list: { '@type': 'chatListMain' },
                  order: '999',
                  is_pinned: false,
                },
              ],
            });
        },
        uploading ? 2000 : 300,
      );
      return;
    }
    case 'getMe':
      return reply(query, users.find((u) => u.id === me) || { '@type': 'user', id: me });
    case 'logOut':
    case 'close':
      if (query['@extra']) reply(query, { '@type': 'ok' });
      loadedLists.clear();
      histories.clear();
      setAuth('authorizationStateClosed');
      return;
    default:
      return reply(query, { '@type': 'ok' });
  }
}

// What electron/telegram.cjs asks of koffi.
module.exports = {
  load() {
    return {
      func(signature) {
        if (signature.includes('td_create_client_id')) return () => ++clientId;
        if (signature.includes('td_execute')) return () => '{"@type":"ok"}';
        if (signature.includes('td_send')) return (_client, json) => handle(JSON.parse(json));
        const receive = () => queue.shift() ?? null;
        receive.async = (_timeout, callback) =>
          setTimeout(() => callback(null, receive()), queue.length ? 0 : 20);
        return receive;
      },
      unload() {},
    };
  },
  // For the check script: what the frame asked Telegram to send.
  sent,
};
