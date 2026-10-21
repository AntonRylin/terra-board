const { normalizeAddress } = require('./cloud-config.cjs');

const SCHEME = 'terraboard';
const PREFIX = `${SCHEME}://`;
const MAX_LINK_LENGTH = 2048;

// Links come from outside the app (a browser, an email), so anything unexpected is ignored.
function parseDeepLink(url) {
  if (typeof url !== 'string' || url.length > MAX_LINK_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:`) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  if (parsed.hostname !== 'connect') return null;
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null;
  const addresses = parsed.searchParams.getAll('address');
  if (addresses.length !== 1) return null;
  try {
    return { kind: 'connect', address: normalizeAddress(addresses[0]) };
  } catch {
    return null;
  }
}

function findDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  const link = argv.find(
    (arg) => typeof arg === 'string' && arg.slice(0, PREFIX.length).toLowerCase() === PREFIX,
  );
  return link ?? null;
}

module.exports = { SCHEME, parseDeepLink, findDeepLink };
