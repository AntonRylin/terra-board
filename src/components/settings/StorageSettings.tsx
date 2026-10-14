import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { AppInfo } from '../../bridge';
import { Group, Notice, Row, useNotice } from './controls';

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
