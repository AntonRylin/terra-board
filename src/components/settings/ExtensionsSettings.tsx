import { Download, RefreshCw, Trash2, X } from 'lucide-react';
import type { ExtensionStatus } from '../../bridge';
import { useExtensions } from '../../extensions';
import { errorText, Group, Notice, Row, useNotice } from './controls';

const megabytes = (bytes: number) => {
  const mb = bytes / 1048576;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
};
// Each extension's row id in the settings search index (settings-index.ts):
// 'background-removal' → 'extensionBackgroundRemoval'.
const rowId = (id: string) => 'extension' + id.replace(/(?:^|-)(\w)/g, (_, c) => c.toUpperCase());

function Details({ extension }: { extension: ExtensionStatus }) {
  const { state, progress, error, notice } = extension;
  if (state === 'installing') {
    const total = progress?.total || extension.downloadBytes;
    const received = Math.min(progress?.received ?? 0, total);
    const percent = total ? Math.round((received * 100) / total) : 0;
    return (
      <div className="st-extension-details">
        <div
          className="st-progress"
          role="progressbar"
          aria-label={`Installing ${extension.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <span>
          {progress?.label ?? 'Installing'} · {megabytes(received)} of {megabytes(total)}
        </span>
      </div>
    );
  }
  return (
    <div className="st-extension-details">
      <span>
        {extension.unavailable
          ? extension.unavailable
          : state !== 'installed'
            ? `${megabytes(extension.downloadBytes)} download`
            : extension.system
              ? window.canvas?.platform === 'win32'
                ? 'Uses the LibreOffice installed in Windows.'
                : 'Uses the LibreOffice installed on this computer.'
              : `Uses ${megabytes(extension.installedBytes ?? 0)} on this PC.`}
        {extension.outdated && ' A newer version is ready to install.'}
      </span>
      {notice && <span>{notice}</span>}
      {error && (
        <span className="st-extension-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// Settings → Extensions: optional parts that download when wanted and can be
// removed again (electron/extensions.cjs).
export function ExtensionsSettings() {
  const list = useExtensions();
  const [notice, setNotice] = useNotice();
  if (!window.canvas)
    return (
      <Group>
        <Row title="Extensions" description="Available in the desktop app." />
      </Group>
    );
  if (!list) return null;
  const api = window.canvas.extensions;
  // Install errors show in their row; only failed removals need a notice.
  const install = (id: string) => void api.install(id).catch(() => {});
  const remove = (id: string) =>
    void api.remove(id).catch((e) => setNotice({ text: errorText(e), error: true }));
  const installed = list.filter((e) => e.state === 'installed' && !e.system);
  const used = installed.reduce((sum, e) => sum + (e.installedBytes ?? 0), 0);
  return (
    <>
      <p className="st-hint">
        {installed.length
          ? `${installed.length} installed · ${megabytes(used)} on this PC`
          : 'Nothing installed yet.'}
      </p>
      <Group>
        {list.length === 0 && (
          <Row title="No extensions in this build" description="Build them with npm run package." />
        )}
        {list.map((extension) => (
          <Row
            key={extension.id}
            id={rowId(extension.id)}
            title={
              <>
                {extension.name}
                {extension.state === 'installed' && <span className="st-chip">Installed</span>}
              </>
            }
            description={extension.description}
            below={<Details extension={extension} />}
          >
            {extension.state === 'installing' ? (
              <button
                type="button"
                className="st-button"
                onClick={() => void api.cancel(extension.id)}
              >
                <X size={14} />
                Cancel
              </button>
            ) : extension.state === 'installed' ? (
              !extension.system && (
                <>
                  {extension.outdated && (
                    <button
                      type="button"
                      className="st-button"
                      onClick={() => install(extension.id)}
                    >
                      <RefreshCw size={14} />
                      Update
                    </button>
                  )}
                  <button type="button" className="st-button" onClick={() => remove(extension.id)}>
                    <Trash2 size={14} />
                    Remove
                  </button>
                </>
              )
            ) : extension.unavailable ? null : (
              <button type="button" className="st-button" onClick={() => install(extension.id)}>
                <Download size={14} />
                Install
              </button>
            )}
          </Row>
        ))}
      </Group>
      <Notice notice={notice} />
      <p className="st-hint st-extensions-note">
        {window.canvas.platform === 'linux'
          ? "Extensions download from GitHub, and every file is checked before it's installed."
          : "Extensions download from GitHub and LibreOffice's website, and every file is checked before it's installed."}
      </p>
    </>
  );
}
