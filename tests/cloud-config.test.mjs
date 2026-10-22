import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  normalizeAddress,
  parseServerFile,
  resolveServer,
  saveServerChoice,
  personalServerFile,
  managedServerFile,
  terraCloud,
  discover,
  checkServer,
  manualServer,
} = require('../electron/cloud-config.cjs');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terra-server-'));
const publicKey = 'sb_publishable_' + 'x'.repeat(20);
const description = (name, extra = {}) => ({
  name,
  supabaseUrl: 'https://api.acme.eu',
  publicKey,
  ...extra,
});
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const packageJson = { terraCloud: { url: 'https://cloud.terra.test', key: 'k'.repeat(30) } };

test('normalizeAddress accepts host names and keeps localhost on http', () => {
  assert.equal(normalizeAddress('terra.acme.eu'), 'https://terra.acme.eu');
  assert.equal(normalizeAddress('https://terra.acme.eu/'), 'https://terra.acme.eu');
  assert.equal(normalizeAddress(' HTTPS://Terra.Acme.EU '), 'https://terra.acme.eu');
  assert.equal(normalizeAddress('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeAddress('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(normalizeAddress('[::1]:9000'), 'http://[::1]:9000');
  assert.equal(normalizeAddress('https://localhost:8787'), 'https://localhost:8787');
});

test('normalizeAddress rejects unsafe or unclear input', () => {
  const unclear = /Enter just the server address, like terra\.example\.com\./;
  assert.throws(() => normalizeAddress('http://terra.acme.eu'), /Use an https:\/\/ address\./);
  assert.throws(() => normalizeAddress('https://terra.acme.eu/boards'), unclear);
  assert.throws(() => normalizeAddress('terra.acme.eu?x=1'), unclear);
  assert.throws(() => normalizeAddress('https://me@terra.acme.eu'), unclear);
  assert.throws(() => normalizeAddress('ftp://terra.acme.eu'), unclear);
  assert.throws(() => normalizeAddress('javascript:alert(1)'), unclear);
  assert.throws(() => normalizeAddress(''), unclear);
  assert.throws(() => normalizeAddress('   '), unclear);
  assert.throws(() => normalizeAddress('a'.repeat(251) + '.eu'), Error);
});

test('parseServerFile fills sign-in defaults and refuses secret keys', () => {
  assert.deepEqual(parseServerFile(description('Acme boards'), 'https://terra.acme.eu'), {
    kind: 'custom',
    name: 'Acme boards',
    url: 'https://api.acme.eu',
    key: 'sb_publishable_xxxxxxxxxxxxxxxxxxxx',
    address: 'https://terra.acme.eu',
    signIn: { email: true, google: false, microsoft: false },
  });
  assert.deepEqual(
    parseServerFile(description(' Acme ', { signIn: { google: true }, extra: 1 }), null).signIn,
    { email: true, google: true, microsoft: false },
  );
  assert.equal(parseServerFile(description(' Acme '), null).name, 'Acme');

  const secret = /secret key/;
  assert.throws(
    () => parseServerFile(description('A', { publicKey: 'sb_secret_' + 'x'.repeat(20) }), null),
    secret,
  );
  const jwt = (role) =>
    [
      'eyJhbGciOiJIUzI1NiJ9',
      Buffer.from(JSON.stringify({ role })).toString('base64url'),
      'sig',
    ].join('.');
  assert.throws(
    () => parseServerFile(description('A', { publicKey: jwt('service_role') }), null),
    secret,
  );
  assert.equal(parseServerFile(description('A', { publicKey: jwt('anon') }), null).kind, 'custom');
  assert.throws(
    () => parseServerFile(description('A', { supabaseUrl: 'http://api.acme.eu' }), null),
    /https/,
  );
  const notServer = /This is not a Terra Board server description\./;
  assert.throws(() => parseServerFile([], null), notServer);
  assert.throws(() => parseServerFile(description(''), null), notServer);
  assert.throws(() => parseServerFile(description('A', { publicKey: 'short' }), null), notServer);
});

test('terraCloud reads the built-in server from package.json', () => {
  assert.deepEqual(terraCloud(packageJson), {
    kind: 'terra',
    name: 'Terra Cloud',
    url: 'https://cloud.terra.test',
    key: 'k'.repeat(30),
    address: null,
    signIn: { email: true, google: true, microsoft: true },
  });
  assert.equal(terraCloud({}), null);
  assert.equal(terraCloud({ terraCloud: { url: 'https://x.test' } }), null);
});

test('server file locations', () => {
  assert.equal(
    managedServerFile({ ProgramData: 'D:\\PD' }, 'win32'),
    path.win32.join('D:\\PD', 'Terra Board', 'server.json'),
  );
  assert.equal(
    managedServerFile({}, 'win32'),
    path.win32.join('C:\\ProgramData', 'Terra Board', 'server.json'),
  );
  // Linux: one fixed system-wide location, whatever the environment says.
  assert.equal(
    managedServerFile({ ProgramData: 'D:\\PD' }, 'linux'),
    '/etc/terra-board/server.json',
  );
  if (process.platform === 'win32')
    assert.equal(managedServerFile({}), path.join('C:\\ProgramData', 'Terra Board', 'server.json'));
  assert.equal(personalServerFile('lib'), path.join('lib', 'settings', 'server.json'));
});

test('resolveServer follows the documented order', () => {
  const root = tempDir();
  const managedFile = path.join(tempDir(), 'server.json');
  const input = { env: {}, root, packageJson, managedFile };

  let result = resolveServer(input);
  assert.equal(result.source, 'default');
  assert.equal(result.config.kind, 'terra');
  assert.equal(result.locked, false);

  assert.deepEqual(resolveServer({ ...input, packageJson: {} }), {
    config: null,
    locked: false,
    source: 'none',
  });

  writeJson(personalServerFile(root), description('Personal'));
  result = resolveServer(input);
  assert.equal(result.source, 'personal');
  assert.equal(result.locked, false);
  assert.equal(result.config.name, 'Personal');

  writeJson(managedFile, description('Managed'));
  result = resolveServer(input);
  assert.equal(result.source, 'personal');

  fs.rmSync(personalServerFile(root));
  result = resolveServer(input);
  assert.equal(result.source, 'managed');
  assert.equal(result.locked, false);
  assert.equal(result.config.name, 'Managed');

  writeJson(personalServerFile(root), description('Personal'));
  writeJson(managedFile, description('Managed', { locked: true }));
  result = resolveServer(input);
  assert.equal(result.source, 'managed');
  assert.equal(result.locked, true);

  const env = { TERRA_CLOUD_URL: 'https://dev.terra.test', TERRA_CLOUD_KEY: 'd'.repeat(30) };
  result = resolveServer({ ...input, env });
  assert.equal(result.source, 'env');
  assert.equal(result.config.kind, 'dev');
  assert.equal(result.config.name, 'Development server');
  assert.equal(result.config.url, 'https://dev.terra.test');
  assert.equal(result.config.key, 'd'.repeat(30));
});

test('resolveServer ignores broken files', () => {
  const root = tempDir();
  const managedFile = path.join(tempDir(), 'server.json');
  writeJson(personalServerFile(root), '{oops');
  writeJson(managedFile, '[]');
  const result = resolveServer({ env: {}, root, packageJson, managedFile });
  assert.equal(result.source, 'default');
  assert.equal(result.config.kind, 'terra');

  writeJson(managedFile, {
    ...description('Managed'),
    locked: true,
    publicKey: 'sb_secret_' + 'x'.repeat(20),
  });
  assert.equal(resolveServer({ env: {}, root, packageJson, managedFile }).source, 'default');
});

test('saveServerChoice writes a file resolveServer reads back, and null removes it', () => {
  const root = tempDir();
  const managedFile = path.join(tempDir(), 'server.json');
  const input = { env: {}, root, packageJson, managedFile };
  const config = parseServerFile(
    description('Acme boards', { signIn: { email: true, google: true, microsoft: false } }),
    'https://terra.acme.eu',
  );

  saveServerChoice(root, config);
  assert.deepEqual(JSON.parse(fs.readFileSync(personalServerFile(root), 'utf8')), {
    name: 'Acme boards',
    supabaseUrl: 'https://api.acme.eu',
    publicKey,
    signIn: { email: true, google: true, microsoft: false },
    address: 'https://terra.acme.eu',
  });
  assert.equal(fs.existsSync(personalServerFile(root) + '.tmp'), false);
  assert.deepEqual(resolveServer(input), { config, locked: false, source: 'personal' });

  saveServerChoice(root, null);
  assert.equal(fs.existsSync(personalServerFile(root)), false);
  assert.equal(resolveServer(input).source, 'default');
  saveServerChoice(root, null);
});

test('the Terra Cloud marker beats an unlocked managed file, not a locked one', () => {
  const root = tempDir();
  const managedFile = path.join(tempDir(), 'server.json');
  const input = { env: {}, root, packageJson, managedFile };

  saveServerChoice(root, 'terra');
  assert.deepEqual(JSON.parse(fs.readFileSync(personalServerFile(root), 'utf8')), { terra: true });
  assert.equal(fs.existsSync(personalServerFile(root) + '.tmp'), false);
  let result = resolveServer(input);
  assert.equal(result.source, 'personal');
  assert.equal(result.config.kind, 'terra');
  assert.equal(result.locked, false);

  writeJson(managedFile, description('Managed'));
  result = resolveServer(input);
  assert.equal(result.source, 'personal');
  assert.equal(result.config.kind, 'terra');

  writeJson(managedFile, description('Managed', { locked: true }));
  result = resolveServer(input);
  assert.equal(result.source, 'managed');
  assert.equal(result.locked, true);

  const env = { TERRA_CLOUD_URL: 'https://dev.terra.test', TERRA_CLOUD_KEY: 'd'.repeat(30) };
  assert.equal(resolveServer({ ...input, env }).source, 'env');

  // No built-in server in this build: the marker counts as absent.
  writeJson(managedFile, description('Managed'));
  result = resolveServer({ ...input, packageJson: {} });
  assert.equal(result.source, 'managed');

  saveServerChoice(root, null);
  assert.equal(resolveServer(input).source, 'managed');
});

const json = (body, init = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
const stubFetch = (respond) => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return respond(url, options);
  };
  return { fetch, calls };
};
const aServer = { schema: 1, minClientSchema: 1, name: 'Acme', billing: false };
const serverConfig = parseServerFile(description('Acme boards'), 'https://terra.acme.eu');

test('discover reads the well-known file', async () => {
  const { fetch, calls } = stubFetch(() => json(description('Acme boards')));
  const config = await discover('terra.acme.eu', { fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://terra.acme.eu/.well-known/terra-board.json');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal);
  assert.equal(config.name, 'Acme boards');
  assert.equal(config.address, 'https://terra.acme.eu');
});

test('discover rejects html and oversized bodies', async () => {
  const notFound = /No Terra Board server found at terra\.acme\.eu/;
  const html = stubFetch(
    () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(discover('terra.acme.eu', { fetch: html.fetch }), notFound);
  const big = stubFetch(() => json(JSON.stringify({ name: 'x'.repeat(70000) })));
  await assert.rejects(discover('terra.acme.eu', { fetch: big.fetch }), notFound);
  const missing = stubFetch(() => json({}, { status: 404 }));
  await assert.rejects(discover('terra.acme.eu', { fetch: missing.fetch }), notFound);
});

test('discover reports an unreachable server', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    discover('terra.acme.eu', { fetch: down }),
    /Could not reach terra\.acme\.eu\./,
  );
});

test('discover times out', async () => {
  const hangs = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    });
  const started = Date.now();
  await assert.rejects(
    discover('terra.acme.eu', { fetch: hangs, timeout: 50 }),
    /Could not reach terra\.acme\.eu/,
  );
  assert.ok(Date.now() - started < 1000);
});

test('checkServer accepts a matching server', async () => {
  const { fetch, calls } = stubFetch(() => json(aServer));
  assert.deepEqual(await checkServer(serverConfig, { fetch }), {
    name: 'Acme',
    billing: false,
    schema: 1,
  });
  assert.equal(calls[0].url, 'https://api.acme.eu/rest/v1/rpc/server_info');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{}');
  assert.equal(calls[0].options.headers.apikey, serverConfig.key);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${serverConfig.key}`);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('checkServer explains version mismatches', async () => {
  const check = (response) => checkServer(serverConfig, { fetch: stubFetch(() => response).fetch });
  await assert.rejects(check(json({}, { status: 404 })), /needs an update/);
  await assert.rejects(
    check(json({ code: 'PGRST202', message: 'no function' }, { status: 200 })),
    /needs an update/,
  );
  await assert.rejects(check(json({ schema: 0, minClientSchema: 0 })), /needs an update/);
  await assert.rejects(check(json(null)), /needs an update/);
  await assert.rejects(check(json({ name: 'x' })), /needs an update/);
  await assert.rejects(check(json({ schema: 'one', minClientSchema: 1 })), /needs an update/);
  await assert.rejects(check(json({ schema: 2, minClientSchema: 2 })), /Update Terra Board/);
});

test('checkServer reports unreachable and wrong servers', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    checkServer(serverConfig, { fetch: down }),
    /Could not reach api\.acme\.eu\./,
  );
  const wrong = stubFetch(() => json({ message: 'nope' }, { status: 400 }));
  await assert.rejects(
    checkServer(serverConfig, { fetch: wrong.fetch }),
    /No Terra Board server found at api\.acme\.eu\./,
  );
  const html = stubFetch(() => new Response('<html>', { status: 200 }));
  await assert.rejects(
    checkServer(serverConfig, { fetch: html.fetch }),
    /No Terra Board server found at api\.acme\.eu\./,
  );
});

test('manualServer validates like a discovery file', () => {
  const config = manualServer('https://abc.supabase.co', publicKey);
  assert.equal(config.kind, 'custom');
  assert.equal(config.name, 'abc.supabase.co');
  assert.equal(config.address, null);
  assert.equal(config.url, 'https://abc.supabase.co');
  assert.throws(
    () => manualServer('https://abc.supabase.co', 'sb_secret_' + 'x'.repeat(20)),
    /secret key/,
  );
  assert.throws(() => manualServer('http://abc.supabase.co', publicKey), /https/);
});

test('checkServer tells a refused key and a broken server apart', async () => {
  const check = (response) => checkServer(serverConfig, { fetch: stubFetch(() => response).fetch });
  for (const status of [401, 403])
    await assert.rejects(
      check(json({ message: 'Invalid API key' }, { status })),
      /^Error: This server refused the key\. Check the public key\.$/,
    );
  for (const status of [500, 502, 503])
    await assert.rejects(
      check(new Response('<html>', { status })),
      /^Error: The server at api\.acme\.eu has a problem\. Try again later\.$/,
    );
  await assert.rejects(
    check(json({ message: 'nope' }, { status: 418 })),
    /No Terra Board server found at api\.acme\.eu\./,
  );
});

test('checkServer spots a missing function from the body alone', async () => {
  const missing = stubFetch(() => json({ code: 'PGRST202', message: 'x' }, { status: 400 }));
  await assert.rejects(checkServer(serverConfig, { fetch: missing.fetch }), /needs an update/);
});

test('manualServer explains an unusable address', () => {
  assert.throws(() => manualServer('not a url', publicKey), /Enter just the server address/);
  assert.throws(
    () => manualServer('https://abc.supabase.co/rest', publicKey),
    /Enter just the server address/,
  );
});
