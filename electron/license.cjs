// Terra Board server license keys (company self-hosting, see ee/LICENSE).
//
// A self-hosted server is free for up to FREE_PEOPLE people. Above that it needs a license
// key, which the server admin pastes into Settings → Server admin. The key is checked here,
// in the app, with Web Crypto (no Node API), so the desktop and Android apps share it.
//
// Key format: TBL1.<base64url JSON payload>.<base64url Ed25519 signature of the payload part>
// Payload:    { v: 1, id, customer, email, seats, issued, expires, servers? }
//   issued/expires are YYYY-MM-DD (expires: the last day it is valid, in UTC).
//   servers (optional) lists the hosts it is for: "terra.acme.eu" or "*.acme.eu".
//
// Nothing is ever blocked by a missing or expired key: the app only says so.

const FREE_PEOPLE = 10;
const GRACE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 4096;

// Raw Ed25519 public keys (base64url) whose signatures are accepted. Add a new one here
// before signing with it, so keys can be rotated.
const PUBLIC_KEYS = ['xcuoYmaobzh_qWwcouaT7UIyVy8qSzz0MxwhBv9jbLI'];

const KEY_SHAPE = /^TBL1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodePayload(part) {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
  } catch {
    return null;
  }
}

const isDate = (value) =>
  typeof value === 'string' && DATE.test(value) && !isNaN(Date.parse(value));

// Reads a key without checking its signature. Returns { payload, signed, signature } or null
// for anything that isn't a well-formed key.
function parseLicense(key) {
  const text = typeof key === 'string' ? key.trim() : '';
  if (!text || text.length > MAX_KEY_LENGTH) return null;
  const match = KEY_SHAPE.exec(text);
  if (!match) return null;
  const payload = decodePayload(match[1]);
  if (
    !payload ||
    typeof payload !== 'object' ||
    payload.v !== 1 ||
    typeof payload.customer !== 'string' ||
    !payload.customer.trim() ||
    !Number.isInteger(payload.seats) ||
    payload.seats < 1 ||
    !isDate(payload.expires) ||
    (payload.issued !== undefined && !isDate(payload.issued)) ||
    (payload.servers !== undefined &&
      (!Array.isArray(payload.servers) || !payload.servers.every((s) => typeof s === 'string')))
  )
    return null;
  let signature;
  try {
    signature = fromBase64Url(match[2]);
  } catch {
    return null;
  }
  if (signature.length !== 64) return null;
  return { payload, signed: new TextEncoder().encode(match[1]), signature };
}

async function signatureOk(parsed, publicKeys) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return false;
  for (const raw of publicKeys) {
    try {
      const key = await subtle.importKey('raw', fromBase64Url(raw), { name: 'Ed25519' }, false, [
        'verify',
      ]);
      if (await subtle.verify({ name: 'Ed25519' }, key, parsed.signature, parsed.signed))
        return true;
    } catch {}
  }
  return false;
}

const hostOf = (value) => {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};

function serverMatches(servers, hosts) {
  if (!servers?.length) return true;
  const known = hosts.map(hostOf).filter(Boolean);
  return servers.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p.startsWith('*.')) return known.some((h) => h.endsWith(p.slice(1)) && h !== p.slice(2));
    return known.includes(hostOf(p));
  });
}

// Checks a key for a server. hosts: the server's address and Supabase URL.
// Returns { state, customer, seats, expires, id, daysLeft, message }, where state is
//   'valid'    – good to use (daysLeft: until it expires)
//   'grace'    – expired less than GRACE_DAYS ago; still counts, renew soon
//   'expired'  – expired longer ago; the server is treated as unlicensed
//   'server'   – made for another server
//   'invalid'  – not a Terra Board license key, or the signature is wrong
// message is a sentence for the person.
async function verifyLicense(key, { hosts = [], now = Date.now(), publicKeys = PUBLIC_KEYS } = {}) {
  const parsed = parseLicense(key);
  if (!parsed || !(await signatureOk(parsed, publicKeys)))
    return { state: 'invalid', message: 'This is not a valid Terra Board license key.' };
  const { payload } = parsed;
  const info = {
    id: typeof payload.id === 'string' ? payload.id : null,
    customer: payload.customer.trim(),
    email: typeof payload.email === 'string' ? payload.email : null,
    seats: payload.seats,
    expires: payload.expires,
  };
  if (!serverMatches(payload.servers, hosts))
    return {
      ...info,
      state: 'server',
      message: `This license is for ${payload.servers.join(', ')}, not this server.`,
    };
  const end = Date.parse(payload.expires + 'T00:00:00Z') + DAY;
  const daysLeft = Math.ceil((end - now) / DAY);
  if (daysLeft > 0)
    return {
      ...info,
      state: 'valid',
      daysLeft,
      message: `Licensed to ${info.customer} for ${info.seats} people until ${payload.expires}.`,
    };
  if (-daysLeft < GRACE_DAYS)
    return {
      ...info,
      state: 'grace',
      daysLeft,
      message: `The license for ${info.customer} expired on ${payload.expires}. Renew it within ${GRACE_DAYS + daysLeft} days.`,
    };
  return {
    ...info,
    state: 'expired',
    daysLeft,
    message: `The license for ${info.customer} expired on ${payload.expires}.`,
  };
}

// What the app tells people about a server's license, from company_status() and the key's
// check: { licensed, over, limit, people, note }. note is null when nothing needs saying.
function licenseSummary({ people = 0, freePeople = FREE_PEOPLE, license = null }) {
  const counts = license && (license.state === 'valid' || license.state === 'grace');
  const limit = counts ? license.seats : freePeople;
  const over = people > limit;
  let note = null;
  if (over && counts)
    note = `This server has ${people} people; its license covers ${limit}. Your admin can add seats.`;
  else if (over)
    note = `Free self-hosting covers ${freePeople} people; this server has ${people}. Your admin can add a license.`;
  else if (license?.state === 'grace') note = license.message;
  return { licensed: !!counts, over, limit, people, note };
}

module.exports = {
  FREE_PEOPLE,
  GRACE_DAYS,
  PUBLIC_KEYS,
  parseLicense,
  verifyLicense,
  licenseSummary,
};
