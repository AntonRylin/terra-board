import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { AppInfo } from '../../bridge';
import { Group, Notice, Row, useNotice } from './controls';
import { installUpdate, newerOnGitHub, openUpdatePage, useUpdateStatus } from '../../updates';
import type { UpdateStatus } from '../../bridge';

function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    window.canvas
      ?.appInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return info;
}

const desktopOnly = 'Available in the desktop app.';

export function StorageSettings() {
  const info = useAppInfo();
  const [notice, setNotice] = useNotice();
  const [exporting, setExporting] = useState(false);
  const open = (which: 'library' | 'backups') =>
    void window.canvas
      ?.openFolder(which)
      .catch((error) => setNotice({ text: String(error), error: true }));
  return (
    <>
      <Group>
        <Row
          id="libraryFolder"
          below={info && <code className="st-path">{info.libraryPath}</code>}
          description={info ? undefined : desktopOnly}
        >
          <button
            type="button"
            className="st-button"
            disabled={!info}
            onClick={() => open('library')}
          >
            <FolderOpen size={15} />
            Open
          </button>
        </Row>
        <Row id="backups" below={info && <code className="st-path">{info.backupsPath}</code>}>
          <button
            type="button"
            className="st-button"
            disabled={!info}
            onClick={() => open('backups')}
          >
            <FolderOpen size={15} />
            Open
          </button>
        </Row>
        <Row id="exportAll">
          <button
            type="button"
            className="st-button"
            disabled={!info || exporting}
            onClick={() => {
              setExporting(true);
              window
                .canvas!.exportLibrary()
                .then((result) => {
                  if (result)
                    setNotice({
                      text: `Exported ${result.count} board${result.count === 1 ? '' : 's'} to ${result.folder}`,
                    });
                })
                .catch((error) => setNotice({ text: String(error), error: true }))
                .finally(() => setExporting(false));
            }}
          >
            {exporting ? 'Exporting…' : 'Export…'}
          </button>
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}

export function AboutSettings() {
  const info = useAppInfo();
  const [licenses, setLicenses] = useState<
    { name: string; version: string; license: string }[] | null
  >(null);
  const [notice, setNotice] = useNotice();
  return (
    <>
      <Group>
        <Row id="version" description={info ? undefined : 'Development preview'}>
          <span className="st-value">{info?.version ?? '—'}</span>
        </Row>
        <UpdateRow />
        <Row
          id="licenses"
          below={
            licenses && (
              <div className="st-licenses" role="region" aria-label="Open-source licenses">
                <table>
                  <thead>
                    <tr>
                      <th>Package</th>
                      <th>Version</th>
                      <th>License</th>
                    </tr>
                  </thead>
                  <tbody>
                    {licenses.map((l) => (
                      <tr key={l.name + l.version}>
                        <td>{l.name}</td>
                        <td>{l.version}</td>
                        <td>{l.license}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        >
          <button
            type="button"
            className="st-button"
            disabled={!window.canvas}
            onClick={() => {
              if (licenses) return setLicenses(null);
              window
                .canvas!.licenses()
                .then(setLicenses)
                .catch((error) => setNotice({ text: String(error), error: true }));
            }}
          >
            {licenses ? 'Hide' : 'View'}
          </button>
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}

function updateText(status: UpdateStatus | null) {
  if (!status?.supported && !status?.notify) return 'Available in the installed app.';
  const latest = newerOnGitHub(status);
  if (latest) return `Version ${latest} is available on GitHub.`;
  switch (status.state) {
    case 'checking':
    case 'idle':
      return 'Checking for updates…';
    case 'current':
      return 'Terra Board is up to date.';
    case 'downloading':
      return `Downloading version ${status.available}… ${status.percent ?? 0}%`;
    case 'ready':
      return `Version ${status.available} is ready. It installs when you close Terra Board.`;
    case 'available':
      return 'A newer version is available on GitHub.';
    case 'error':
      return `Could not check for updates. ${status.error ?? ''}`.trim();
  }
}

function UpdateRow() {
  const status = useUpdateStatus();
  const ready = status?.state === 'ready';
  const latest = newerOnGitHub(status);
  const busy = status?.state === 'checking' || status?.state === 'downloading';
  return (
    <Row id="updates" description={updateText(status)}>
      {ready ? (
        <button type="button" className="st-button primary" onClick={() => void installUpdate()}>
          Restart to update
        </button>
      ) : latest ? (
        <button
          type="button"
          className="st-button primary"
          onClick={() => void openUpdatePage(status).catch(() => {})}
        >
          Get it
        </button>
      ) : (
        <button
          type="button"
          className="st-button"
          disabled={!(status?.supported || status?.notify) || busy}
          onClick={() => void window.canvas?.updates.check()}
        >
          Check now
        </button>
      )}
    </Row>
  );
}
