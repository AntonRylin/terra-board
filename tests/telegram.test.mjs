import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileLinkValue } from '../src/canvas/file-link.ts';
import {
  sortedChats,
  textParts,
  messageSummary,
  packWaveform,
  unpackWaveform,
} from '../src/components/telegram/td.ts';
import { findSecrets, forbiddenFile } from '../scripts/check-secrets.mjs';
const require = createRequire(import.meta.url);
const {
  createTelegram,
  createState,
  mergePositions,
  credentialsValue,
  secretFile,
  fileName,
  mimeOf,
} = require('../electron/telegram.cjs');
const { fileLinkValue: storeFileLinkValue } = require('../electron/store.cjs');
const { privateSite } = require('../electron/browser-frames.cjs');
const { webmToOgg, packetSamples } = require('../electron/opus-ogg.cjs');

const scratch = () => fs.mkdtempSync(path.join(tmpdir(), 'terra-telegram-'));
// A stand-in for Electron's safeStorage that marks what it "encrypted".
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from('ENC:' + Buffer.from(text).toString('base64')),
  decryptString: (bytes) => {
    const raw = bytes.toString();
    if (!raw.startsWith('ENC:')) throw Error('Not ours');
    return Buffer.from(raw.slice(4), 'base64').toString();
  },
});

test('Telegram frames keep nothing but their kind in the board', () => {
  const frame = { path: '', kind: 'telegram', view: 'list' };
  assert.deepEqual(fileLinkValue(frame), { path: '', kind: 'telegram' });
  assert.deepEqual(storeFileLinkValue(frame), { path: '', kind: 'telegram' });
  for (const bad of [
    { path: 'C:\\Users\\chat.db', kind: 'telegram' },
    { root: 'desktop', path: '', kind: 'telegram' },
  ]) {
    assert.throws(() => fileLinkValue(bad));
    assert.throws(() => storeFileLinkValue(bad));
  }
});

test('API IDs and hashes are checked before they are kept', () => {
  assert.deepEqual(
    credentialsValue({ apiId: ' 123456 ', apiHash: 'ABCDEF0123456789abcdef0123456789' }),
    {
      apiId: 123456,
      apiHash: 'abcdef0123456789abcdef0123456789',
    },
  );
  assert.throws(() =>
    credentialsValue({ apiId: 'abc', apiHash: 'abcdef0123456789abcdef0123456789' }),
  );
  assert.throws(() => credentialsValue({ apiId: '1', apiHash: 'short' }));
  assert.throws(() =>
    credentialsValue({ apiId: '0', apiHash: 'abcdef0123456789abcdef0123456789' }),
  );
});

test('secrets are written encrypted and unreadable copies count as missing', () => {
  const dir = scratch();
  const file = path.join(dir, 'secret.bin');
  const store = secretFile(file, fakeSafe());
  assert.equal(store.read(), null);
  assert.equal(store.write('{"apiId":1}'), true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('apiId'), 'the file is not plain text');
  assert.equal(store.read(), '{"apiId":1}');
  // Encrypted by another Windows user or computer.
  fs.writeFileSync(file, 'someone else');
  assert.equal(store.read(), undefined);
  store.clear();
  assert.equal(fs.existsSync(file), false);
  // Without a key store nothing is written to disk.
  const none = secretFile(path.join(dir, 'none.bin'), fakeSafe(false));
  assert.equal(none.write('x'), false);
  assert.equal(fs.existsSync(path.join(dir, 'none.bin')), false);
});

test('the chat list follows TDLib updates', () => {
  const state = createState();
  const main = { '@type': 'chatListMain' };
  state.apply({
    '@type': 'updateNewChat',
    chat: { id: 1, title: 'A', positions: [], unread_count: 0 },
  });
  state.apply({
    '@type': 'updateNewChat',
    chat: { id: 2, title: 'B', positions: [], unread_count: 0 },
  });
  state.apply({
    '@type': 'updateChatPosition',
    chat_id: 1,
    position: { list: main, order: '5', is_pinned: false },
  });
  state.apply({
    '@type': 'updateChatPosition',
    chat_id: 2,
    position: { list: main, order: '9', is_pinned: false },
  });
  state.apply({
    '@type': 'updateChatReadInbox',
    chat_id: 1,
    last_read_inbox_message_id: 7,
    unread_count: 3,
  });
  const changed = state.apply({ '@type': 'updateChatTitle', chat_id: 1, title: 'Renamed' });
  assert.equal(changed.chat.title, 'Renamed');
  assert.equal(state.chats.get(1).unread_count, 3);
  assert.deepEqual(
    sortedChats(state.chats.values()).map(({ chat }) => chat.id),
    [2, 1],
  );
  // Order 0 takes a chat out of the list.
  state.apply({
    '@type': 'updateChatPosition',
    chat_id: 2,
    position: { list: main, order: '0', is_pinned: false },
  });
  assert.deepEqual(
    sortedChats(state.chats.values()).map(({ chat }) => chat.id),
    [1],
  );
  assert.deepEqual(mergePositions([{ list: main, order: '3' }], [], true), []);
  // Signing out forgets everyone.
  state.apply({
    '@type': 'updateAuthorizationState',
    authorization_state: { '@type': 'authorizationStateClosed' },
  });
  assert.equal(state.chats.size, 0);
});

test('message text keeps its formatting and links', () => {
  const parts = textParts({
    '@type': 'formattedText',
    text: 'Hi bold see example.com',
    entities: [
      { '@type': 'textEntity', offset: 3, length: 4, type: { '@type': 'textEntityTypeBold' } },
      { '@type': 'textEntity', offset: 12, length: 11, type: { '@type': 'textEntityTypeUrl' } },
      { '@type': 'textEntity', offset: 40, length: 5, type: { '@type': 'textEntityTypeBold' } },
    ],
  });
  assert.deepEqual(
    parts.map((p) => [p.text, !!p.bold, p.url || '']),
    [
      ['Hi ', false, ''],
      ['bold', true, ''],
      [' see ', false, ''],
      ['example.com', false, 'https://example.com'],
    ],
  );
  assert.equal(
    messageSummary({
      content: {
        '@type': 'messageDocument',
        document: { file_name: 'a.pdf' },
        caption: { text: '' },
      },
    }),
    '📎 a.pdf',
  );
});

test('files sent from the board get safe names', () => {
  assert.equal(fileName('Plan: v2?', 'image/png'), 'Plan- v2-.png');
  assert.equal(fileName('report.pdf', 'application/pdf'), 'report.pdf');
  assert.equal(fileName('con', 'image/jpeg'), 'File.jpg');
  assert.equal(fileName('', undefined), 'File');
});

test('downloaded files without an extension get their type from their content', () => {
  const dir = scratch();
  const jpg = path.join(dir, 'photo');
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(mimeOf(jpg), 'image/jpeg');
  assert.equal(mimeOf(path.join(dir, 'clip.mp4')), 'video/mp4');
});

test('Telegram Web is never pictured into a board', () => {
  assert.equal(privateSite('https://web.telegram.org/a/#123'), true);
  assert.equal(privateSite('https://telegram.org/'), false);
  assert.equal(privateSite('not a url'), false);
});

// TDLib itself replaced by a script that answers like it.
function fakeKoffi(sent) {
  const queue = [];
  const answer = (event) => queue.push(JSON.stringify({ ...event, '@client_id': 1 }));
  const lib = {
    func(signature) {
      if (signature.includes('td_create_client_id')) return () => 1;
      if (signature.includes('td_execute')) return () => '{"@type":"ok"}';
      if (signature.includes('td_send'))
        return (_client, json) => {
          const query = JSON.parse(json);
          sent.push(query);
          if (query['@type'] === 'getOption')
            answer({
              '@type': 'updateAuthorizationState',
              authorization_state: { '@type': 'authorizationStateWaitTdlibParameters' },
            });
          else if (query['@type'] === 'close' || query['@type'] === 'logOut') {
            if (query['@extra']) answer({ '@type': 'ok', '@extra': query['@extra'] });
            answer({
              '@type': 'updateAuthorizationState',
              authorization_state: { '@type': 'authorizationStateClosed' },
            });
          } else {
            answer({ '@type': 'ok', '@extra': query['@extra'] });
            if (query['@type'] === 'setTdlibParameters')
              answer({
                '@type': 'updateAuthorizationState',
                authorization_state: { '@type': 'authorizationStateWaitPhoneNumber' },
              });
          }
        };
      const receive = () => queue.shift() ?? null;
      receive.async = (_timeout, callback) => setTimeout(() => callback(null, receive()), 2);
      return receive;
    },
    unload() {},
  };
  return { load: () => lib };
}

test('frames reach TDLib only through checked requests', async () => {
  const dir = scratch();
  const library = path.join(dir, 'ext');
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, 'tdjson.dll'), '');
  const sent = [];
  const batches = [];
  const telegram = createTelegram({
    dir: path.join(dir, 'data'),
    location: () => library,
    safeStorage: fakeSafe(),
    load: () => fakeKoffi(sent),
    send: (batch) => batches.push(batch),
    platform: 'win32',
  });
  assert.equal(telegram.status().credentials, false);
  await assert.rejects(telegram.invoke({ '@type': 'getChats' }), /API ID/);
  await telegram.setCredentials({ apiId: '42', apiHash: '0123456789abcdef0123456789abcdef' });
  // Kept encrypted, never as plain text.
  const saved = fs.readFileSync(path.join(dir, 'data', 'credentials.bin'), 'utf8');
  assert.ok(!saved.includes('0123456789abcdef'));
  for (
    let i = 0;
    i < 50 && telegram.snapshot().auth?.['@type'] !== 'authorizationStateWaitPhoneNumber';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const parameters = sent.find((q) => q['@type'] === 'setTdlibParameters');
  assert.equal(parameters.api_id, 42);
  assert.ok(parameters.database_encryption_key.length >= 40, 'the database is encrypted');
  assert.equal(parameters.use_secret_chats, false);

  await assert.rejects(telegram.invoke({ '@type': 'logOut' }), /doesn’t send/);
  await assert.rejects(telegram.invoke({ '@type': 'getPasswordState' }), /doesn’t send/);
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'private');
  const document = (file, extra = {}) => ({
    '@type': 'sendMessage',
    chat_id: 5,
    input_message_content: {
      '@type': 'inputMessageDocument',
      document: {
        '@type': 'inputDocument',
        document: { '@type': 'inputFileLocal', path: file },
        ...extra,
      },
    },
  });
  // A file nobody dropped or picked can't be sent.
  await assert.rejects(telegram.invoke(document(secret)), /again/);
  const [staged] = await telegram.stage([{ path: secret }]);
  await telegram.invoke(
    document(staged.path, {
      thumbnail: {
        '@type': 'inputThumbnail',
        thumbnail: { '@type': 'inputFileLocal', path: 'C:\\other.txt' },
      },
    }),
  );
  const request = sent.filter((q) => q['@type'] === 'sendMessage').pop();
  assert.deepEqual(request.input_message_content.document, {
    '@type': 'inputDocument',
    document: { '@type': 'inputFileLocal', path: path.resolve(secret) },
  });
  await assert.rejects(
    telegram.invoke({
      '@type': 'sendMessage',
      chat_id: 5,
      input_message_content: { '@type': 'inputMessageForwarded', from_chat_id: 1, message_id: 2 },
    }),
    /text and files only/,
  );
  // Only Telegram's own folders are served or dragged.
  assert.equal(telegram.draggable(secret), path.resolve(secret));
  assert.equal(telegram.draggable(path.join(dir, 'other.txt')), null);
  // Frames get changes in batches, at most every 40 ms.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(batches.some((b) => b.auth?.['@type'] === 'authorizationStateWaitPhoneNumber'));

  await telegram.forget();
  assert.equal(fs.existsSync(path.join(dir, 'data', 'credentials.bin')), false);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'database-key.bin')), false);
  assert.equal(telegram.status().credentials, false);
});

test('commits that would add Telegram credentials are refused', () => {
  const diff = (file, line) => `+++ b/${file}
+${line}
`;
  const hash = 'f'.repeat(8) + '0'.repeat(24);
  assert.equal(findSecrets(diff('a.py', `api_hash = '${hash}'`)).length, 1);
  assert.equal(findSecrets(diff('a.js', `apiId: ${2012 * 10000 + 3456},`)).length, 1);
  assert.equal(findSecrets(diff('.env', `TERRA_TELEGRAM_API_HASH=${hash}`)).length, 1);
  // Placeholders and the tests' made-up values pass.
  assert.equal(findSecrets(diff('a.ts', "apiHash: '0123456789abcdef0123456789abcdef'")).length, 0);
  assert.equal(findSecrets(diff('a.ts', 'placeholder="1234567"')).length, 0);
  // A value known to be real is refused anywhere, even unassigned.
  const known = new Set(['20123456']);
  assert.equal(findSecrets(diff('notes.md', 'my id is 20123456'), { known }).length, 1);
  assert.ok(forbiddenFile('Library/telegram/credentials.bin'));
  assert.ok(forbiddenFile('anon.session'));
  assert.ok(forbiddenFile('electron/generated/telegram-app.json'));
  assert.ok(!forbiddenFile('electron/telegram.cjs'));
});

test('voice message waveforms pack five bits a value, as Telegram does', () => {
  const values = Array.from({ length: 100 }, (_, i) => i % 32);
  const packed = packWaveform(values);
  assert.equal(Buffer.from(packed, 'base64').length, 63);
  assert.deepEqual(unpackWaveform(packed).slice(0, 100), values);
  assert.deepEqual(unpackWaveform('not base64!'), []);
});

// A WebM file as Chromium's recorder writes it: segment and cluster of unknown
// size, an Opus track with its header, and blocks of 20 ms packets.
function webm(packets) {
  const el = (id, body) => {
    const size = body.length;
    return Buffer.concat([Buffer.from(id), Buffer.from([0x40 | (size >> 8), size & 0xff]), body]);
  };
  const unknown = (id, body) =>
    Buffer.concat([
      Buffer.from(id),
      Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      body,
    ]);
  const head = Buffer.alloc(19);
  head.write('OpusHead');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  const track = el(
    [0x16, 0x54, 0xae, 0x6b],
    el([0xae], Buffer.concat([el([0x86], Buffer.from('A_OPUS')), el([0x63, 0xa2], head)])),
  );
  const blocks = packets.map((p, i) =>
    el([0xa3], Buffer.concat([Buffer.from([0x81, 0, i * 20, 0x80]), p])),
  );
  const cluster = unknown(
    [0x1f, 0x43, 0xb6, 0x75],
    Buffer.concat([el([0xe7], Buffer.from([0])), ...blocks]),
  );
  return Buffer.concat([
    el([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])),
    unknown([0x18, 0x53, 0x80, 0x67], Buffer.concat([track, cluster])),
  ]);
}

test('recorded voice moves from WebM to Ogg without re-encoding', () => {
  // TOC 0xf8: CELT, 20 ms, one frame.
  const packets = Array.from({ length: 60 }, (_, i) => Buffer.from([0xf8, i, 1, 2, 3]));
  assert.equal(packetSamples(packets[0]), 960);
  const { bytes, seconds } = webmToOgg(webm(packets));
  assert.equal(seconds, 1.2);
  const ogg = Buffer.from(bytes);
  const pages = [];
  for (let at = ogg.indexOf('OggS'); at >= 0; at = ogg.indexOf('OggS', at + 4)) pages.push(at);
  assert.equal(ogg.subarray(28, 36).toString(), 'OpusHead');
  assert.equal(ogg[pages[0] + 5], 0x02, 'the first page begins the stream');
  assert.equal(ogg[pages[pages.length - 1] + 5], 0x04, 'the last page ends it');
  // The last granule counts every sample after the 312-sample pre-skip.
  assert.equal(Number(ogg.readBigInt64LE(pages[pages.length - 1] + 6)), 312 + 60 * 960);
  assert.ok(ogg.includes(Buffer.from([0xf8, 59, 1, 2, 3])), 'the packets are carried as they are');
  assert.throws(() => webmToOgg(Buffer.from([1, 2, 3])), /empty/);
});
