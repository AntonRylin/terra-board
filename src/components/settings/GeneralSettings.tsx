import { useEffect, useState } from 'react';
import { updatePreferences, usePreferences } from '../../settings/preferences';
import { Group, Notice, Row, Switch, useNotice } from './controls';

export function GeneralSettings() {
  const preferences = usePreferences();
  const [login, setLogin] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [notice, setNotice] = useNotice();
  useEffect(() => {
    window.canvas
      ?.appInfo()
      .then((info) => setLogin({ supported: info.loginItemSupported, enabled: info.openAtLogin }))
      .catch(() => setLogin(null));
  }, []);
  return (
    <>
      <Group>
        <Row id="openLastBoard">
          <Switch
            label="Open last board on start"
            checked={preferences.openLastBoard}
            onChange={(openLastBoard) => updatePreferences({ openLastBoard })}
          />
        </Row>
        <Row id="confirmTrash">
          <Switch
            label="Ask before moving a board to Trash"
            checked={preferences.confirmTrash}
            onChange={(confirmTrash) => updatePreferences({ confirmTrash })}
          />
        </Row>
        <Row
          id="openAtLogin"
          description={
            login?.supported
              ? undefined
              : window.canvas?.platform === 'linux'
                ? "On Linux, add Terra Board to your desktop's startup applications."
                : 'Available in the installed app.'
          }
        >
          <Switch
            label="Launch at login"
            checked={!!login?.enabled}
            disabled={!login?.supported}
            onChange={(enabled) =>
              void window.canvas
                ?.setOpenAtLogin(enabled)
                .then((value) => setLogin({ supported: true, enabled: value }))
                .catch((error) => setNotice({ text: String(error), error: true }))
            }
          />
        </Row>
      </Group>
      <Notice notice={notice} />
    </>
  );
}

export type PanelOptions = {
  hidden: boolean;
  minimal: boolean;
  centered: boolean;
  setHidden: (value: boolean) => void;
  setMinimal: (value: boolean) => void;
  setCentered: (value: boolean) => void;
};

export function PanelSettings({ panel }: { panel: PanelOptions }) {
  return (
    <Group>
      <Row id="panelShown">
        <Switch
          label="Show board panel"
          checked={!panel.hidden}
          onChange={(shown) => panel.setHidden(!shown)}
        />
      </Row>
      <Row id="panelMinimal">
        <Switch label="Minimal mode" checked={panel.minimal} onChange={panel.setMinimal} />
      </Row>
      <Row id="panelCentered">
        <Switch label="Center panel" checked={panel.centered} onChange={panel.setCentered} />
      </Row>
    </Group>
  );
}
