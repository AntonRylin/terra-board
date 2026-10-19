import { useEffect, useRef, useState } from 'react';
import { ImageMinus, ImagePlus, Settings2, Star } from 'lucide-react';
import type { Album, CanvasObject } from '../model';
import { assetLinks, downloadAsset, type AssetLink } from '../bridge';
import { albumName } from '../canvas/album';
import ImageViewer from './ImageViewer';

type AlbumCard = CanvasObject & { album: Album };

export function linkWarning(link: AssetLink | undefined) {
  if (!link || link.state === 'ok') return '';
  return link.state === 'missing'
    ? `The original file is missing: ${link.path}. Showing the preview saved in the board.`
    : `The original file has changed since it was added: ${link.path}. Showing the preview saved in the board.`;
}

// Flip through an album's images in the full image viewer.
export default function AlbumViewer({
  album,
  index,
  readOnly,
  onIndex,
  onClose,
  onSetCover,
  onRemove,
  onAddImages,
  onSettings,
  onError,
}: {
  album: AlbumCard;
  index: number;
  readOnly: boolean;
  onIndex: (index: number) => void;
  onClose: () => void;
  onSetCover: (imageId: string) => void;
  onRemove: (imageId: string) => void;
  onAddImages: () => void;
  onSettings: () => void;
  onError: (e: unknown) => void;
}) {
  const images = album.album.images;
  const at = Math.max(0, Math.min(index, images.length - 1));
  const image = images[at];
  // The viewer opens once; flipping to another image shows it in place.
  const first = useRef(image.id);
  const flipped = first.current !== image.id;
  const [links, setLinks] = useState(new Map<string, AssetLink>());
  const ids = images.map((i) => i.assetId).join();
  useEffect(() => {
    let live = true;
    assetLinks(images.map((i) => i.assetId)).then(
      (list) => live && setLinks(new Map(list.map((l) => [l.id, l]))),
      onError,
    );
    return () => {
      live = false;
    };
  }, [ids]);
  const name = albumName(album);
  const link = links.get(image.assetId);
  const warning = linkWarning(link);
  const cover = image.assetId === album.assetId;
  const locate = async () => {
    try {
      const found = await window.canvas?.locateAsset({
        id: image.assetId,
        name: link?.path.split(/[\\/]/).pop() || 'the image',
      });
      if (found) setLinks((current) => new Map(current).set(found.id, found));
    } catch (e) {
      onError(e);
    }
  };
  return (
    <ImageViewer
      object={{
        ...album,
        assetId: image.assetId,
        crop: image.crop,
        album: undefined,
        imageTitle: image.title ? `${name} · ${image.title}` : name,
      }}
      onClose={onClose}
      onDownload={() => downloadAsset(image.assetId, image.title || name).then(() => undefined)}
      nav={{
        index: at,
        count: images.length,
        flipped,
        go: (delta) => onIndex((at + delta + images.length) % images.length),
      }}
      notice={
        warning ? (
          <>
            <span role="alert">{warning}</span>
            {window.canvas && !readOnly && (
              <button type="button" onClick={() => void locate()}>
                Locate file…
              </button>
            )}
          </>
        ) : null
      }
      tools={
        readOnly ? null : (
          <>
            <button
              type="button"
              aria-label={cover ? 'This image is the cover' : 'Set as cover'}
              data-tooltip={cover ? 'This image is the cover' : 'Set as cover'}
              aria-pressed={cover}
              disabled={cover}
              onClick={() => onSetCover(image.id)}
            >
              <Star size={18} />
            </button>
            <button
              type="button"
              aria-label="Take out of the album"
              data-tooltip={
                images.length < 2
                  ? 'The last image stays: use Release images on the board'
                  : 'Take out of the album'
              }
              disabled={images.length < 2}
              onClick={() => onRemove(image.id)}
            >
              <ImageMinus size={18} />
            </button>
            <button
              type="button"
              aria-label="Add images"
              data-tooltip="Add images"
              onClick={onAddImages}
            >
              <ImagePlus size={18} />
            </button>
            <button
              type="button"
              aria-label="Album settings"
              data-tooltip="Album settings"
              onClick={onSettings}
            >
              <Settings2 size={18} />
            </button>
          </>
        )
      }
    />
  );
}
