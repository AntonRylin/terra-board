import type { Album, AlbumImage, Asset, CanvasObject, Edit, ImageAdded } from '../model';
import { addedValue } from './image-added.ts';
import { uid } from '../model.ts';

// An album is an image card: its picture is the cover, one of `album.images`.
// Everything else an image card does (crop, rotation, the viewer) acts on the
// cover; the album's own actions live here.
export const isAlbum = (o: CanvasObject | undefined | null): o is CanvasObject & { album: Album } =>
  !!o && o.type === 'image' && !!o.album;

export const albumName = (o: CanvasObject) => o.album?.name.trim() || 'Album';

export const albumCountLabel = (n: number) => `${n} image${n === 1 ? '' : 's'}`;

// Images and albums that can be made into one album together.
export function canMakeAlbum(objects: CanvasObject[]) {
  return (
    objects.length > 1 &&
    objects.every((o) => o.type === 'image' && !!o.assetId && !o.locked && !o.galleryId)
  );
}

function asAlbumImage(o: CanvasObject): AlbumImage[] {
  if (o.album) return o.album.images;
  return [
    {
      id: o.id,
      assetId: o.assetId!,
      width: o.width,
      height: o.height,
      ...(o.imageTitle?.trim() ? { title: o.imageTitle } : {}),
      ...(o.crop ? { crop: { ...o.crop } } : {}),
      ...(o.rotation ? { rotation: o.rotation } : {}),
      ...(o.added ? { added: { ...o.added } } : {}),
    },
  ];
}

// Reading order: rows top to bottom, then left to right, so an album made
// from a laid-out set keeps the order the eye read them in.
function readingOrder(objects: CanvasObject[]) {
  const rowHeight = Math.max(1, Math.min(...objects.map((o) => o.height)) / 2);
  return [...objects].sort(
    (a, b) => Math.round(a.y / rowHeight) - Math.round(b.y / rowHeight) || a.x - b.x,
  );
}

// The selection becomes one album card where the first image was. Albums in
// the selection pour their images in; the first album keeps its name and storage.
export function makeAlbum(objects: CanvasObject[], name = 'Album'): Edit & { id: string } {
  const ordered = readingOrder(objects);
  const first = ordered[0];
  const firstAlbum = ordered.find((o) => o.album)?.album;
  const images = ordered.flatMap(asAlbumImage);
  const seen = new Set<string>();
  const unique = images.map((image) =>
    seen.has(image.id) ? { ...image, id: uid() } : (seen.add(image.id), image),
  );
  const id = uid();
  const card: CanvasObject = {
    ...first,
    id,
    imageTitle: undefined,
    galleryId: undefined,
    galleryIndex: undefined,
    galleryRow: undefined,
    galleryColumn: undefined,
    z: Math.max(...objects.map((o) => o.z)),
    album: {
      name: firstAlbum?.name || name,
      storage: firstAlbum?.storage || 'copy',
      images: unique,
    },
  };
  return { id, upserts: [card], deleted: objects.map((o) => o.id) };
}

// The images go back onto the board in a grid where the card was.
export function releaseAlbum(album: CanvasObject, gap = 24): Edit {
  const images = album.album?.images || [];
  const columns = Math.max(1, Math.ceil(Math.sqrt(images.length)));
  const placed: CanvasObject[] = [];
  let x = album.x,
    y = album.y,
    rowHeight = 0;
  images.forEach((image, index) => {
    if (index && index % columns === 0) {
      x = album.x;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    placed.push(imageObject(image, x, y, album.z + index / images.length));
    x += image.width + gap;
    rowHeight = Math.max(rowHeight, image.height);
  });
  return { upserts: placed, deleted: [album.id] };
}

function imageObject(image: AlbumImage, x: number, y: number, z: number): CanvasObject {
  return {
    id: uid(),
    type: 'image',
    x,
    y,
    width: image.width,
    height: image.height,
    z,
    assetId: image.assetId,
    ...(image.title ? { imageTitle: image.title } : {}),
    ...(image.crop ? { crop: { ...image.crop } } : {}),
    ...(image.rotation ? { rotation: image.rotation } : {}),
    ...(image.added ? { added: { ...image.added } } : {}),
  };
}

// The card keeps its width and takes the new cover's proportions.
function withCover(album: CanvasObject & { album: Album }, image: AlbumImage): CanvasObject {
  return {
    ...album,
    assetId: image.assetId,
    crop: image.crop ? { ...image.crop } : undefined,
    rotation: image.rotation || undefined,
    height: Math.max(1, (album.width * image.height) / image.width),
  };
}

export function setAlbumCover(album: CanvasObject & { album: Album }, imageId: string) {
  const image = album.album.images.find((i) => i.id === imageId);
  return image ? withCover(album, image) : album;
}

// New images join at the end, at the size an imported image has on the board.
export function addToAlbum(
  album: CanvasObject & { album: Album },
  assets: Asset[],
  added?: ImageAdded,
): CanvasObject {
  const images = assets
    .filter((a) => a.mime.startsWith('image/'))
    .map((a): AlbumImage => {
      const scale = Math.min(1, 480 / Math.max(a.width, a.height));
      return {
        id: uid(),
        assetId: a.id,
        width: Math.max(1, a.width * scale),
        height: Math.max(1, a.height * scale),
        ...(added ? { added: { ...added } } : {}),
      };
    });
  return { ...album, album: { ...album.album, images: [...album.album.images, ...images] } };
}

// One image leaves the album and lands beside the card. The last image
// cannot leave: releasing the album is that.
export function removeFromAlbum(album: CanvasObject & { album: Album }, imageId: string): Edit {
  const index = album.album.images.findIndex((i) => i.id === imageId);
  if (index < 0 || album.album.images.length < 2) return { upserts: [], deleted: [] };
  const image = album.album.images[index];
  const images = album.album.images.filter((i) => i.id !== imageId);
  let next: CanvasObject & { album: Album } = { ...album, album: { ...album.album, images } };
  if (image.assetId === album.assetId && !images.some((i) => i.assetId === album.assetId))
    next = withCover(next, images[Math.min(index, images.length - 1)]) as typeof next;
  return {
    upserts: [next, imageObject(image, album.x + album.width + 32, album.y, album.z + 1)],
    deleted: [],
  };
}

// What a pasted album may carry. The store checks it again, strictly.
export function albumValue(value: any, coverAssetId: unknown): Album {
  if (
    !value ||
    typeof value.name !== 'string' ||
    value.name.length > 200 ||
    !['copy', 'link'].includes(value.storage) ||
    !Array.isArray(value.images) ||
    value.images.length < 1 ||
    value.images.length > 2000 ||
    !value.images.every(
      (i: any) =>
        i &&
        typeof i.id === 'string' &&
        /^[\w-]{1,100}$/.test(i.id) &&
        typeof i.assetId === 'string' &&
        /^[a-f0-9]{64}$/.test(i.assetId) &&
        Number.isFinite(i.width) &&
        Number.isFinite(i.height) &&
        i.width >= 1 &&
        i.height >= 1,
    ) ||
    !value.images.some((i: any) => i.assetId === coverAssetId)
  )
    throw Error('Invalid album');
  return {
    name: value.name,
    storage: value.storage,
    images: value.images.map((i: any) => ({
      id: i.id,
      assetId: i.assetId,
      width: i.width,
      height: i.height,
      ...(typeof i.title === 'string' ? { title: i.title.slice(0, 1000) } : {}),
      ...(i.crop
        ? { crop: { x: i.crop.x, y: i.crop.y, width: i.crop.width, height: i.crop.height } }
        : {}),
      ...(Number.isFinite(i.rotation) ? { rotation: i.rotation } : {}),
      ...(addedValue(i.added) ? { added: addedValue(i.added) } : {}),
    })),
  };
}
