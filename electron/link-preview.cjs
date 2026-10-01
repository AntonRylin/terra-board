const https = require('node:https');
const http = require('node:http');
const dns = require('node:dns');
const { isIP, BlockList } = require('node:net');
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked.addSubnet(address, prefix);
function publicAddress(address) {
  return isIP(address) === 4
    ? !blocked.check(address)
    : isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address);
}
function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw Error('Invalid preview URL');
  const u = new URL(value);
  if (
    !['https:', 'http:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !['80', '443'].includes(u.port))
  )
    throw Error('Invalid preview URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || (isIP(host) && !publicAddress(host)))
    throw Error('Private preview URL');
  return u;
}
async function readPublic(
  value,
  limit = 1024 * 1024,
  redirects = 0,
  signal = AbortSignal.timeout(8000),
) {
  const u = webUrl(value);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(
      u,
      {
        signal,
        agent: false,
        headers: {
          'User-Agent': 'LocalCanvas/0.1 link-preview',
          Accept: 'text/html,application/json,image/*',
          'Accept-Encoding': 'identity',
        },
        lookup(host, options, callback) {
          dns.lookup(host, { all: true }, (error, addresses) => {
            if (error) return callback(error);
            if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
              return callback(Error('Private preview address'));
            options.all
              ? callback(null, addresses)
              : callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (redirects >= 4 || !res.headers.location)
            return reject(Error('Preview redirect limit'));
          return resolve(
            readPublic(new URL(res.headers.location, u).href, limit, redirects + 1, signal),
          );
        }
        if (res.statusCode !== 200) {
          res.destroy();
          return reject(Error('Preview unavailable'));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) res.destroy(Error('Preview too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            bytes: Buffer.concat(chunks),
            type: res.headers['content-type'] || '',
            url: u.href,
          }),
        );
      },
    );
    req.on('error', reject);
  });
}
function clean(value = '', limit = 500) {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
      if (entity[0] !== '#')
        return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[
          entity.toLowerCase()
        ];
      const code =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}
function metadata(html, url) {
  const values = new Map();
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (attrs.content && !values.has(key)) values.set(key, attrs.content);
  }
  const title = clean(
    values.get('og:title') ||
      values.get('twitter:title') ||
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ||
      new URL(url).hostname,
    300,
  );
  let description = clean(
    values.get('og:description') || values.get('description') || values.get('twitter:description'),
  );
  // Google's public homepage often omits its description. Use a concise
  // product summary only for that exact homepage, never for search results.
  const page = new URL(url);
  const googleHome =
    ['google.com', 'www.google.com'].includes(page.hostname) && page.pathname === '/';
  if (!description && googleHome)
    description = 'Search the web for webpages, images, videos, news and more.';
  let icon;
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    if (/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.rel || '') && attrs.href) {
      try {
        icon = webUrl(new URL(clean(attrs.href, 8192), url).href).href;
      } catch {}
      if (icon && /png/i.test(attrs.type || attrs.href)) break;
    }
  }
  if (googleHome && values.get('image')) {
    try {
      icon = webUrl(new URL(clean(values.get('image'), 8192), url).href).href;
    } catch {}
  }
  let image;
  try {
    image = webUrl(
      new URL(clean(values.get('og:image') || values.get('twitter:image'), 8192), url).href,
    ).href;
  } catch {}
  return {
    title,
    description,
    image: values.get('og:image') || values.get('twitter:image') ? image : undefined,
    ...(icon ? { icon } : {}),
  };
}
async function fetchPreview(url, read = readPublic) {
  webUrl(url);
  // Keep the accepted URL forms aligned with the renderer's youtubeId helper.
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const candidate =
    host === 'youtu.be'
      ? u.pathname.slice(1)
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(
            host,
          )
        ? u.pathname === '/watch'
          ? u.searchParams.get('v')
          : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1]
        : null;
  const id = candidate && /^[\w-]{11}$/.test(candidate) ? candidate : null;
  let meta;
  if (id) {
    meta = {
      title: 'YouTube video',
      description: 'YouTube',
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
    try {
      const result = await read(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
      );
      const data = JSON.parse(result.bytes.toString());
      meta.title = clean(data.title, 300) || meta.title;
      meta.description = clean(data.author_name) || 'YouTube';
    } catch {}
  } else {
    const result = await read(url);
    if (!/text\/html|application\/xhtml/i.test(result.type))
      return { title: u.hostname, description: '' };
    meta = metadata(result.bytes.toString('utf8'), result.url);
  }
  let imageBytes;
  if (meta.image) {
    try {
      const result = await read(meta.image, 5 * 1024 * 1024);
      if (/^image\/(jpeg|png|webp|gif|avif)\b/i.test(result.type)) imageBytes = result.bytes;
    } catch {}
  }
  let iconBytes;
  if (meta.icon) {
    try {
      const result = await read(meta.icon, 512 * 1024);
      if (/^image\//i.test(result.type)) iconBytes = result.bytes;
    } catch {}
  }
  return { title: meta.title, description: meta.description, imageBytes, iconBytes };
}
module.exports = { publicAddress, webUrl, metadata, fetchPreview, readPublic };
