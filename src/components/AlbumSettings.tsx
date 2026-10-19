import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Album, CanvasObject } from '../model';
import { assetLinks, boardSyncs, type AssetLink } from '../bridge';
import { albumCountLabel } from '../canvas/album';
import { Modal } from './Dialogs';
import './album.css';

// Why "link to the original files" cannot be chosen here, or '' when it can.
export function linkBlockedReason(desktop: boolean, syncs: boolean | null) {
  if (!desktop) return 'Linking to files works in the desktop app.';
  if (syncs === null) return 'Checking whether this board syncs…';
  if (syncs)
    return 'This board syncs to the cloud, and other computers cannot open files on this one. Keep the board on this computer (Remove from cloud) to link files.';
  return '';
}

export default function AlbumSettings({
  album,
  boardId,
  onSave,
  onClose,
  onError,
}: {
  album: CanvasObject & { album: Album };
  boardId: string;
  onSave: (name: string, storage: Album['storage']) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState(album.album.name);
  const [storage, setStorage] = useState(album.album.storage);
  const [syncs, setSyncs] = useState<boolean | null>(null);
  const [links, setLinks] = useState<AssetLink[]>([]);
  const desktop = !!window.canvas;
  useEffect(() => {
    let live = true;
    boardSyncs(boardId).then((value) => live && setSyncs(value), onError);
    assetLinks(album.album.images.map((i) => i.assetId)).then(
      (list) => live && setLinks(list),
      onError,
    );
    return () => {
      live = false;
    };
  }, []);
  const blocked = linkBlockedReason(desktop, syncs);
  const broken = links.filter((l) => l.state !== 'ok');
  const locate = async (link: AssetLink) => {
    try {
      const found = await window.canvas?.locateAsset({
        id: link.id,
        name: link.path.split(/[\\/]/).pop() || 'the image',
      });
      if (found) setLinks((list) => list.map((l) => (l.id === found.id ? found : l)));
    } catch (e) {
      onError(e);
    }
  };
  // In <body>, above the image viewer, which makes the rest of the app inert
  // while it is open: settings can be opened from inside an album.
  return createPortal(
    <div className="album-settings-layer">
      <Modal title="Album settings" onClose={onClose}>
        <form
          className="album-settings"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(name.trim() || 'Album', storage);
          }}
        >
          <label>
            Name
            <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset>
            <legend>New images</legend>
            <label className="album-choice">
              <input
                type="radio"
                name="album-storage"
                checked={storage === 'copy'}
                onChange={() => setStorage('copy')}
              />
              <span>
                <b>Copy into the board</b>
                The whole image is saved in Terra's library. Nothing breaks if the file is moved or
                deleted.
              </span>
            </label>
            <label className="album-choice" data-disabled={!!blocked || undefined}>
              <input
                type="radio"
                name="album-storage"
                checked={storage === 'link'}
                disabled={!!blocked}
                onChange={() => setStorage('link')}
              />
              <span>
                <b>Link to the original files</b>
                Only a small preview is saved; the full image is read from where it is on this
                computer. Saves space.
                {blocked && <em>{blocked}</em>}
              </span>
            </label>
            <p className="album-note">
              This applies to images added from now on. Images already in the album stay as they
              are. Pasted images have no file to link to, so they are always copied.
            </p>
            {storage === 'link' && syncs && (
              <p className="album-warning" role="alert">
                This album links files, but the board now syncs to the cloud: new images are copied
                until the board is kept on this computer again.
              </p>
            )}
          </fieldset>
          <p className="album-count">
            {albumCountLabel(album.album.images.length)}
            {links.length ? ` · ${links.length} linked to files` : ''}
            {broken.length ? ` · ${broken.length} missing` : ''}
          </p>
          {broken.length > 0 && (
            <ul className="album-missing">
              {broken.map((link) => (
                <li key={link.id}>
                  <span>
                    {link.state === 'missing' ? 'Missing' : 'Changed since added'}: {link.path}
                  </span>
                  {desktop && (
                    <button type="button" className="button" onClick={() => void locate(link)}>
                      Locate file…
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button primary">
              Save
            </button>
          </div>
        </form>
      </Modal>
    </div>,
    document.body,
  );
}
