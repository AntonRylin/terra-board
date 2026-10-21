const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const CLIENT_SCHEMA = 1;
const MIN_SERVER_SCHEMA = 1;

const NOT_A_SERVER = 'This is not a Terra Board server description.';
const UNCLEAR_ADDRESS = 'Enter just the server address, like terra.example.com.';
const NEEDS_HTTPS = 'Use an https:// address.';
const SECRET_KEY = 'This file contains a secret key. Use the public key instead.';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALL_SIGN_IN = { email: true, google: true, microsoft: true };

function normalizeAddress(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 253) throw new Error(UNCLEAR_ADDRESS);
  const hasScheme = text.includes('://');
  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    throw new Error(UNCLEAR_ADDRESS);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(UNCLEAR_ADDRESS);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error(UNCLEAR_ADDRESS);
  if (hasScheme && url.protocol === 'http:' && !local) throw new Error(NEEDS_HTTPS);
  const protocol = !hasScheme && local ? 'http:' : url.protocol;
  return `${protocol}//${url.host}`;
}

function isServiceRoleJwt(key) {
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'service_role';
  } catch {
    return false;
  }
}

const serverFileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  supabaseUrl: z.string().transform((value, ctx) => {
    try {
      return normalizeAddress(value);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e.message });
      return z.NEVER;
    }
  }),
  publicKey: z
    .string()
    .min(20)
    .max(400)
    .superRefine((key, ctx) => {
      if (key.startsWith('sb_secret_') || isServiceRoleJwt(key))
        ctx.addIssue({ code: 'custom', message: SECRET_KEY });
    }),
  signIn: z
    .object({
      email: z.boolean().default(true),
      google: z.boolean().default(false),
      microsoft: z.boolean().default(false),
    })
    .prefault({}),
});

function parseServerFile(data, address) {
  const parsed = serverFileSchema.safeParse(data);
  if (!parsed.success) {
    // Our own checks carry a message meant for the person; everything else is a wrong shape.
    const ours = parsed.error.issues.find((issue) => issue.code === 'custom');
    throw new Error(ours ? ours.message : NOT_A_SERVER);
  }
  const { name, supabaseUrl, publicKey, signIn } = parsed.data;
  return {
    kind: 'custom',
    name,
    url: supabaseUrl,
    key: publicKey,
    address: address ?? null,
    signIn,
  };
}

function terraCloud(packageJson) {
  const cloud = packageJson?.terraCloud;
  if (!cloud?.url || !cloud?.key) return null;
  return {
    kind: 'terra',
    name: 'Terra Cloud',
    url: cloud.url,
    key: cloud.key,
    address: null,
    signIn: { ...ALL_SIGN_IN },
  };
}

const managedServerFile = (env = process.env) =>
  path.join(env.ProgramData || 'C:\\ProgramData', 'Terra Board', 'server.json');
const personalServerFile = (root) => path.join(root, 'settings', 'server.json');

// A missing, unreadable or invalid file counts as absent, so the next source is used.
function readServerFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let address = null;
    try {
      address = normalizeAddress(data.address);
    } catch {}
    return { config: parseServerFile(data, address), locked: data.locked === true };
  } catch {
    return null;
  }
}

function resolveServer({ env = process.env, root, packageJson, managedFile }) {
  if (env.TERRA_CLOUD_URL && env.TERRA_CLOUD_KEY) {
    const config = {
      kind: 'dev',
      name: 'Development server',
      url: env.TERRA_CLOUD_URL,
      key: env.TERRA_CLOUD_KEY,
      address: null,
      signIn: { ...ALL_SIGN_IN },
    };
    return { config, locked: false, source: 'env' };
  }
  const managed = readServerFile(managedFile || managedServerFile(env));
  if (managed?.locked) return { config: managed.config, locked: true, source: 'managed' };
  const personal = readServerFile(personalServerFile(root));
  if (personal) return { config: personal.config, locked: false, source: 'personal' };
  if (managed) return { config: managed.config, locked: false, source: 'managed' };
  const config = terraCloud(packageJson);
  return config
    ? { config, locked: false, source: 'default' }
    : { config: null, locked: false, source: 'none' };
}

function saveServerChoice(root, config) {
  const file = personalServerFile(root);
  if (!config) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const { name, url, key, signIn, address } = config;
  fs.writeFileSync(
    temp,
    JSON.stringify({ name, supabaseUrl: url, publicKey: key, signIn, address }),
  );
  fs.renameSync(temp, file);
}

module.exports = {
  CLIENT_SCHEMA,
  MIN_SERVER_SCHEMA,
  normalizeAddress,
  parseServerFile,
  terraCloud,
  managedServerFile,
  personalServerFile,
  resolveServer,
  saveServerChoice,
};
