#!/usr/bin/env node
// Terra Board server setup. Part of ee/ (Terra Board Enterprise License, see ee/LICENSE).
//
// Downloads Supabase's official self-hosting files (the docker/ folder of
// github.com/supabase/supabase at SUPABASE_TAG) into ./supabase and writes ./.env with fresh
// secrets and the Terra Board settings. Run it again at any time: secrets and your own edits in
// .env are kept, and the Supabase files are downloaded again only when SUPABASE_TAG changed
// (or with --download).
//
//   node setup.mjs --host terra.acme.eu --admin it@acme.eu --name "Acme boards"
//
// Options:
//   --host <name>     DNS name of the server (required the first time). No https://, no path.
//   --admin <email>   First server admin. Added to public.server_admins by terra-migrate.
//   --name <text>     Name people see when they connect ("Found <name> at <host>").
//   --sso             Turn on SAML company sign-in (SAML_ENABLED=true).
//   --no-sso          Turn it off again.
//   --http            Plain http instead of https. Only for trying it out on localhost.
//   --download        Download the Supabase files again even if the tag did not change.
//
// Needs Node.js 18 or newer and nothing else (no npm packages).

import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Supabase self-hosting release this package is tested with. Change it in one place.
// Tags: https://github.com/supabase/supabase/tags?q=self-hosted
export const SUPABASE_TAG = 'self-hosted/v0.8.3';
const SUPABASE_REPO = 'supabase/supabase';

const here = dirname(fileURLToPath(import.meta.url));
const supabaseDir = join(here, 'supabase');
const envPath = join(here, '.env');
const stampPath = join(supabaseDir, '.terra-source');

// ---------- command line ----------

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`Unknown argument: ${a}`);
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (['sso', 'no-sso', 'http', 'download', 'help'].includes(key)) {
      out.flags.add(key);
    } else if (['host', 'admin', 'name'].includes(key)) {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`--${key} needs a value`);
      out[key] = v;
    } else {
      fail(`Unknown option: --${key}`);
    }
  }
  return out;
}

function fail(msg) {
  console.error(`setup: ${msg}`);
  process.exit(1);
}

// ---------- secrets ----------

const hex = (n) => randomBytes(n).toString('hex');
const b64 = (n) => randomBytes(n).toString('base64');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hs256(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function samlPrivateKey() {
  // GoTrue wants a base64 (standard alphabet) DER RSA key in PKCS#1 form.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  return Buffer.from(privateKey).toString('base64');
}

// True when token is an HS256 JWT for role, signed with secret.
function signedBy(token, secret, role) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const sig = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  return sig === parts[2] && jwtPayload(token)?.role === role;
}

// ANON_KEY and SERVICE_ROLE_KEY are made in main() from JWT_SECRET (10 years, like Supabase's
// own generate-keys.sh but twice as long).
function freshSecrets() {
  return {
    POSTGRES_PASSWORD: hex(16),
    JWT_SECRET: b64(30),
    DASHBOARD_PASSWORD: hex(16),
    SECRET_KEY_BASE: b64(48),
    REALTIME_DB_ENC_KEY: hex(8),
    VAULT_ENC_KEY: hex(16),
    PG_META_CRYPTO_KEY: b64(24),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: b64(24),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: b64(24),
    S3_PROTOCOL_ACCESS_KEY_ID: hex(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32),
    MINIO_ROOT_PASSWORD: hex(16),
    POOLER_TENANT_ID: `terra-${hex(6)}`,
  };
}

// Keys whose .env.example value is a public placeholder: never keep that placeholder.
const SECRET_KEYS = Object.keys(freshSecrets());

// ---------- download ----------

async function getJson(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'terra-board-setup' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  return res.json();
}

async function getBytes(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'terra-board-setup' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function downloadSupabase() {
  const ref = encodeURIComponent(SUPABASE_TAG);
  const commit = await getJson(`https://api.github.com/repos/${SUPABASE_REPO}/commits/${ref}`);
  const tree = await getJson(`https://api.github.com/repos/${SUPABASE_REPO}/git/trees/${commit.sha}:docker?recursive=1`);
  if (tree.truncated) throw new Error('GitHub returned a truncated file list');
  const files = tree.tree.filter((e) => e.type === 'blob' && !e.path.startsWith('tests/'));
  if (!files.some((f) => f.path === 'docker-compose.yml') || !files.some((f) => f.path === '.env.example')) {
    throw new Error(`docker/ at ${SUPABASE_TAG} has no docker-compose.yml or .env.example`);
  }

  // Download into a new folder first, so a failed download leaves the old one working.
  const tmp = `${supabaseDir}.download`;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`Downloading Supabase ${SUPABASE_TAG} (${commit.sha.slice(0, 7)}), ${files.length} files…`);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const data = await getBytes(`https://raw.githubusercontent.com/${SUPABASE_REPO}/${commit.sha}/docker/${f.path}`);
      const dest = join(tmp, ...f.path.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      if (f.mode === '100755') chmodSync(dest, 0o755);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  writeFileSync(
    join(tmp, '.terra-source'),
    `# Written by ee/server/setup.mjs. Do not edit.\ntag=${SUPABASE_TAG}\ncommit=${commit.sha}\n`,
  );

  // The database and file storage live in ../data (see docker-compose.terra.yml), so the
  // downloaded folder holds no data and can be replaced. Keep anything that still lives in an
  // old supabase/volumes/{db/data,storage} (should not exist, but never delete data).
  if (existsSync(supabaseDir)) {
    for (const p of [['volumes', 'db', 'data'], ['volumes', 'storage']]) {
      const old = join(supabaseDir, ...p);
      if (existsSync(old)) fail(`${old} exists and may hold data. Move it out of supabase/ first.`);
    }
    rmSync(supabaseDir, { recursive: true, force: true, maxRetries: 5 });
  }
  await moveDir(tmp, supabaseDir);
}

// rename, retried: on Windows a virus scanner can briefly hold the files just written.
async function moveDir(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 5) {
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true, maxRetries: 5 });
        return;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function downloadedTag() {
  if (!existsSync(stampPath)) return null;
  const m = /^tag=(.*)$/m.exec(readFileSync(stampPath, 'utf8'));
  return m ? m[1].trim() : null;
}

// ---------- .env ----------

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
    else if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    map.set(m[1], v);
  }
  return map;
}

function quote(v) {
  v = String(v);
  if (/[\r\n]/.test(v)) fail('values in .env cannot contain line breaks');
  if (/^[A-Za-z0-9_\-+/=.:@,]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`; // single quotes: taken literally by Compose
  if (v.includes('$')) fail(`value ${JSON.stringify(v)} cannot contain both ' and $`);
  return `"${v.replace(/(["\\])/g, '\\$1')}"`;
}

const TERRA_HEADER = `
############
# Terra Board (ee/server/setup.mjs)
############
`;

function writeEnv(example, values, terraKeys) {
  const exampleKeys = new Set();
  const lines = example.split(/\r?\n/).map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!m) return line;
    exampleKeys.add(m[1]);
    return `${m[1]}=${quote(values.get(m[1]) ?? '')}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const extra = [...values.keys()].filter((k) => !exampleKeys.has(k));
  const terra = terraKeys.filter((k) => extra.includes(k));
  const kept = extra.filter((k) => !terraKeys.includes(k));
  let out = lines.join('\n') + '\n' + TERRA_HEADER;
  out += `# Generated for Supabase ${SUPABASE_TAG}. Edit freely; setup.mjs keeps your values.\n`;
  for (const k of terra) out += `${k}=${quote(values.get(k))}\n`;
  if (kept.length) {
    out += '\n# Kept from the previous .env\n';
    for (const k of kept) out += `${k}=${quote(values.get(k))}\n`;
  }
  writeFileSync(envPath, out, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {}
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has('help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 21).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }

  const old = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : new Map();
  if (!old.size && existsSync(join(here, 'data', 'db', 'PG_VERSION'))) {
    fail('data/db holds a database but .env is missing. Restore the .env that belongs to it (new secrets would lock you out).');
  }

  const host = (args.host ?? old.get('TERRA_HOST') ?? '').trim().toLowerCase();
  if (!host) fail('--host is required (the DNS name people will type, e.g. terra.acme.eu)');
  if (!/^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/.test(host)) {
    fail(`--host must be a bare DNS name like terra.acme.eu, not ${JSON.stringify(host)}`);
  }
  const http = args.flags.has('http') || (!args.host && Boolean(old.get('TERRA_URL')?.startsWith('http://')));
  if (http && host !== 'localhost') fail('--http only works with --host localhost; real servers need https');
  const url = `${http ? 'http' : 'https'}://${host}`;

  const admin = (args.admin ?? old.get('TERRA_ADMIN_EMAIL') ?? '').trim().toLowerCase();
  if (admin && !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(admin)) fail(`--admin is not an email address: ${admin}`);
  const name = (args.name ?? old.get('TERRA_NAME') ?? 'Terra Board server').trim();
  if (!name || name.length > 100) fail('--name must be 1 to 100 characters');

  if (!existsSync(join(here, '..', '..', 'supabase', 'migrations'))) {
    fail('run this from a full checkout of the Terra Board repository (ee/server/setup.mjs), it needs supabase/migrations');
  }

  if (args.flags.has('download') || downloadedTag() !== SUPABASE_TAG) {
    await downloadSupabase();
  } else {
    console.log(`Supabase ${SUPABASE_TAG} is already downloaded.`);
  }

  const example = readFileSync(join(supabaseDir, '.env.example'), 'utf8');
  const defaults = parseEnv(example);
  const fresh = freshSecrets();
  const values = new Map();
  for (const [k, v] of defaults) values.set(k, v);
  for (const [k, v] of old) values.set(k, v);
  for (const k of SECRET_KEYS) {
    const v = old.get(k);
    if (!v || v === defaults.get(k)) values.set(k, fresh[k]);
  }
  // The two API keys must be signed with the JWT secret in use; make new ones if they are not.
  const secret = values.get('JWT_SECRET');
  for (const [key, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']]) {
    if (!signedBy(values.get(key), secret, role)) {
      const iat = Math.floor(Date.now() / 1000);
      values.set(key, hs256({ role, iss: 'supabase', iat, exp: iat + 10 * 365 * 24 * 3600 }, secret));
    }
  }

  // Where Supabase lives and how people sign in.
  values.set('COMPOSE_FILE', 'supabase/docker-compose.yml:docker-compose.terra.yml');
  values.set('SUPABASE_PUBLIC_URL', url);
  values.set('API_EXTERNAL_URL', `${url}/auth/v1`);
  values.set('SITE_URL', url);
  values.set('PROXY_DOMAIN', host);
  const redirects = new Set((values.get('ADDITIONAL_REDIRECT_URLS') || '').split(',').map((s) => s.trim()).filter(Boolean));
  redirects.add('terraboard://auth/callback');
  values.set('ADDITIONAL_REDIRECT_URLS', [...redirects].join(','));
  values.set('ENABLE_EMAIL_SIGNUP', 'true');
  // Must stay false: the server admin check trusts auth.users.email, so addresses must be proven.
  values.set('ENABLE_EMAIL_AUTOCONFIRM', 'false');
  values.set('ENABLE_ANONYMOUS_USERS', 'false');
  values.set('ENABLE_PHONE_SIGNUP', 'false');
  values.set('ENABLE_PHONE_AUTOCONFIRM', 'false');
  if (!old.has('SMTP_SENDER_NAME') || values.get('SMTP_SENDER_NAME') === defaults.get('SMTP_SENDER_NAME')) {
    values.set('SMTP_SENDER_NAME', 'Terra Board');
  }

  // Terra Board's own settings (read by docker-compose.terra.yml).
  const terra = {
    COMPOSE_PATH_SEPARATOR: ':',
    TERRA_HOST: host,
    TERRA_URL: url,
    TERRA_NAME: name,
    TERRA_ADMIN_EMAIL: admin,
    TERRA_HTTP_PORT: old.get('TERRA_HTTP_PORT') || '80',
    TERRA_HTTPS_PORT: old.get('TERRA_HTTPS_PORT') || '443',
    TERRA_MIGRATE_IMAGE: dbImage(),
    TERRA_EMAIL_SUBJECT: old.get('TERRA_EMAIL_SUBJECT') || 'Your Terra Board sign-in code',
    TERRA_FILE_SIZE_LIMIT: old.get('TERRA_FILE_SIZE_LIMIT') || String(256 * 1024 * 1024),
    SAML_ENABLED: args.flags.has('sso') ? 'true' : args.flags.has('no-sso') ? 'false' : old.get('SAML_ENABLED') || 'false',
    SAML_PRIVATE_KEY: old.get('SAML_PRIVATE_KEY') || samlPrivateKey(),
  };
  for (const [k, v] of Object.entries(terra)) values.set(k, v);

  writeEnv(example, values, Object.keys(terra));
  mkdirSync(join(here, 'data'), { recursive: true });

  const smtpUnset = values.get('SMTP_HOST') === defaults.get('SMTP_HOST');
  console.log(`
Wrote ${envPath}
  Server address:   ${host}  (${url})
  Server name:      ${name}
  First admin:      ${admin || '(none: pass --admin <email>)'}
  Company sign-in:  ${terra.SAML_ENABLED === 'true' ? 'SAML on' : 'off (--sso turns it on)'}
  Dashboard:        ${url}/  user ${values.get('DASHBOARD_USERNAME')}, password DASHBOARD_PASSWORD in .env
${smtpUnset ? '\n  ! Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_ADMIN_EMAIL (the sender) in .env,\n    otherwise nobody gets a sign-in code.\n' : ''}
Next: docker compose up -d`);
}

function dbImage() {
  const compose = readFileSync(join(supabaseDir, 'docker-compose.yml'), 'utf8');
  const m = /^\s*image:\s*(supabase\/postgres:\S+)\s*$/m.exec(compose);
  if (!m) fail('could not find the supabase/postgres image in supabase/docker-compose.yml');
  return m[1];
}

main().catch((err) => fail(err.message));
