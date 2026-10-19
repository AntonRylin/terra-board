const fs = require('node:fs/promises');
const path = require('node:path');

// Helpers for AI tools working on HTML embeds (mcp-tools.cjs): bundling a local
// page with its files, small source edits, placement and compact board reads.
const sourceLimit = 1000000;
const fileLimit = 5 * 1024 * 1024;
const mediaTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

async function readFile(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > fileLimit)
      throw Error(`${path.basename(file)} must be a regular file up to 5 MB.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function replaceAsync(text, pattern, replace) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index), await replace(...match));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.join('');
}
const attribute = (tag, name) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    .exec(tag)
    ?.slice(1)
    .find((v) => v !== undefined);
// A file next to the page, or null for web, data and in-page references.
function localFile(base, reference) {
  if (!reference || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference.trim())) return null;
  const clean = reference.trim().split(/[?#]/)[0];
  return clean ? path.resolve(base, decodeURI(clean)) : null;
}
async function dataUri(file) {
  const type = mediaTypes[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
}
const inlineCssUrls = (css, base) =>
  replaceAsync(css, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (match, quote, reference) => {
    const file = localFile(base, reference);
    return file ? `url("${await dataUri(file)}")` : match;
  });

// One self-contained page from an HTML file and the stylesheets, scripts,
// images and fonts it references next to it.
async function bundleHtmlFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Use an absolute file path.');
  const base = path.dirname(file);
  let html = (await readFile(file)).toString('utf8');
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) return tag;
    const sheet = localFile(base, attribute(tag, 'href'));
    if (!sheet) return tag;
    const css = await inlineCssUrls((await readFile(sheet)).toString('utf8'), path.dirname(sheet));
    return `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`;
  });
  html = await replaceAsync(
    html,
    /<script\b([^>]*?)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script>/gi,
    async (tag, before, a, b, c, after) => {
      const script = localFile(base, a ?? b ?? c);
      if (!script) return tag;
      const js = (await readFile(script)).toString('utf8').replace(/<\/script/gi, '<\\/script');
      const attributes = `${before} ${after}`.trim();
      return `<script${attributes ? ' ' + attributes : ''}>\n${js}\n</script>`;
    },
  );
  html = await replaceAsync(html, /<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) =>
    inlineCssUrls(block, base),
  );
  html = await replaceAsync(
    html,
    /(<(?:img|source|video|audio|link)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi,
    async (match, before, quote, reference) => {
      const media = localFile(base, reference);
      if (!media || !mediaTypes[path.extname(media).toLowerCase()]) return match;
      return before + quote + (await dataUri(media)) + quote;
    },
  );
  if (html.length > sourceLimit)
    throw Error(
      `The bundled page has ${html.length.toLocaleString('en-US')} characters; embeds hold up to 1,000,000. Use smaller or web-hosted images.`,
    );
  return html;
}

// Exact-text replacements, each found where the source is unambiguous.
function applyEdits(source, edits) {
  let result = source;
  for (const [index, edit] of edits.entries()) {
    const count = result.split(edit.find).length - 1;
    if (!count) throw Error(`Edit ${index + 1}: the find text is not in the page.`);
    if (count > 1 && !edit.all)
      throw Error(
        `Edit ${index + 1}: the find text appears ${count} times. Include more surrounding text, or set all.`,
      );
    result = edit.all
      ? result.split(edit.find).join(edit.replace)
      : result.replace(edit.find, () => edit.replace);
  }
  if (result.length > sourceLimit) throw Error('Embeds hold up to 1,000,000 characters.');
  return result;
}

// A spot for a new card: right of everything on the board, top-aligned.
function placeBeside(objects, width) {
  const placed = objects.filter((o) => o.type !== 'arrow' && o.type !== 'highlight');
  if (!placed.length) return { x: -width / 2, y: 0 };
  const right = Math.max(...placed.map((o) => o.x + o.width)),
    top = Math.min(...placed.map((o) => o.y));
  return { x: right + 80, y: top };
}

// Board reads show embed sources by size only; read_html_embed returns them.
const compactObject = (o) => {
  if (o.type !== 'html' || o.html === undefined) return o;
  const { html, ...rest } = o;
  return { ...rest, htmlChars: html.length };
};

const numbered = (source, start = 1, end = Infinity) =>
  source
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([n]) => n >= start && n <= end)
    .map(([n, line]) => `${n}\t${line}`)
    .join('\n');

module.exports = { bundleHtmlFile, applyEdits, placeBeside, compactObject, numbered };
