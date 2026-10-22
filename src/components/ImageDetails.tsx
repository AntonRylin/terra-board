import { useEffect, useState } from 'react';
import type { CanvasObject } from '../model';
import { assetInfo, type AssetInfo } from '../bridge';
import { addedTimeText } from '../canvas/image-added';
import { formatBytes, relativeTime } from './board-info-text';
import { Modal } from './Dialogs';

const kind = (mime: string) =>
  mime
    .replace(/^image\//, '')
    .replace(/^svg\+xml$/, 'svg')
    .toUpperCase();

// Right-click an image → Details: when it was added, who added it, and its file.
export default function ImageDetails({
  object,
  onClose,
}: {
  object: CanvasObject;
  onClose: () => void;
}) {
  const [file, setFile] = useState<AssetInfo | null>(null);
  useEffect(() => {
    let live = true;
    if (object.assetId)
      assetInfo(object.assetId).then(
        (info) => live && setFile(info),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [object.assetId]);
  const added = object.added;
  const name = file?.name || object.text;
  return (
    <Modal title="Image details" onClose={onClose}>
      <dl className="image-details">
        <dt>Added</dt>
        <dd>
          {added ? (
            <>
              {addedTimeText(added.at)}
              <span className="image-details-muted"> · {relativeTime(added.at)}</span>
            </>
          ) : (
            <span className="image-details-muted">Not recorded</span>
          )}
        </dd>
        {added?.by && (
          <>
            <dt>Added by</dt>
            <dd>{added.by}</dd>
          </>
        )}
        {object.imageTitle?.trim() && (
          <>
            <dt>Title</dt>
            <dd>{object.imageTitle}</dd>
          </>
        )}
        {name && (
          <>
            <dt>File</dt>
            <dd>{name}</dd>
          </>
        )}
        {file && (
          <>
            <dt>Format</dt>
            <dd>{kind(file.mime)}</dd>
            {file.width > 0 && file.height > 0 && (
              <>
                <dt>Size</dt>
                <dd>
                  {file.width.toLocaleString()} × {file.height.toLocaleString()} px
                </dd>
              </>
            )}
            {file.bytes > 0 && (
              <>
                <dt>File size</dt>
                <dd>{formatBytes(file.bytes)}</dd>
              </>
            )}
            {file.linkedPath && (
              <>
                <dt>Linked to</dt>
                <dd>{file.linkedPath}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {!added && (
        <p className="quiet small image-details-note">
          This image was added before Terra kept this, or while “Remember who added images” was off
          in Settings → Canvas.
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
