import type { CanvasObject } from '../model';

export const compactLinkHeight = 76;
export const descriptionLinkHeight = 112;
export const linkCornerRadius = 16;
export function normalizeLinkSize(o: CanvasObject): CanvasObject {
  // Migrate old automatic layouts, preserving cards the user resized.
  return !o.assetId && [76, 168, 314].includes(o.height)
    ? { ...o, height: linkFallbackHeight(o) }
    : o;
}
export function linkFallbackHeight(o: Partial<CanvasObject>) {
  return o.linkDescription?.trim() ? descriptionLinkHeight : compactLinkHeight;
}
export function withLinkPreview(o: CanvasObject, meta: Partial<CanvasObject>): CanvasObject {
  const automatic = !o.assetId && [compactLinkHeight, descriptionLinkHeight].includes(o.height);
  const merged = { ...o, ...meta };
  return {
    ...merged,
    height: automatic
      ? meta.assetId
        ? ((o.width - 24) * 9) / 16 + 80
        : linkFallbackHeight(merged)
      : o.height,
  };
}

export function youtubeId(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const host = u.hostname.toLowerCase();
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1)
        : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(
              host,
            )
          ? u.pathname === '/watch'
            ? u.searchParams.get('v')
            : /^\/(?:embed|shorts|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1]
          : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function linkLayout(width: number, height: number) {
  const padding = Math.min(12, width / 20, height / 20);
  const footer = Math.min(56, height * 0.24);
  return {
    padding,
    x: padding,
    y: padding,
    width: width - padding * 2,
    height: Math.max(1, height - footer - padding * 2),
    footer,
  };
}

export function hitsLinkPlay(
  o: {
    type: string;
    url?: string;
    assetId?: string;
    linkDescription?: string;
    width: number;
    height: number;
  },
  p: { x: number; y: number },
) {
  if (o.type !== 'link') return false;
  if (
    !o.assetId &&
    p.x >= o.width - 48 &&
    p.x <= o.width - 12 &&
    Math.abs(p.y - (o.linkDescription ? 36 : o.height / 2)) <= 18
  )
    return true;
  if (!youtubeId(o.url || '')) return false;
  const box = linkLayout(o.width, o.height);
  return Math.abs(p.x - o.width / 2) <= 40 && Math.abs(p.y - box.y - box.height / 2) <= 30;
}
