import { Folder, Hand, MousePointer2, Plus, Square, Type } from 'lucide-react';
import { defaultPanelTransparency } from './useGlassAppearance';
import type { Appearance } from './useAppearance';
import ThemeSwitch from './ThemeSwitch';
import { Group, Row, Switch } from './settings/controls';

export default function AppearanceSettings({
  transparency,
  onTransparency,
  appearance,
}: {
  transparency: number;
  onTransparency: (value: number) => void;
  appearance: Appearance;
}) {
  return (
    <div className="appearance-settings">
      <Group>
        <Row
          id="theme"
          description={
            appearance.preference === 'system'
              ? 'Follows your device’s appearance.'
              : appearance.theme === 'dark'
                ? 'A quiet canvas after dark.'
                : 'A little room for daylight.'
          }
        >
          <ThemeSwitch value={appearance.preference} onChange={appearance.setPreference} />
        </Row>
      </Group>
      <Group
        title="Glass"
        action={
          <button
            type="button"
            className="st-text-button glass-reset"
            disabled={transparency === defaultPanelTransparency}
            onClick={() => onTransparency(defaultPanelTransparency)}
          >
            Reset
          </button>
        }
      >
        <Row
          id="transparency"
          below={
            <div className="st-glass">
              <div className="glass-preview" aria-hidden="true">
                <div className="glass-preview-landscape" />
                <div className="glass-preview-note">Room for ideas.</div>
                <div className="glass-preview-tools glass-surface">
                  <span className="preview-tool selected">
                    <MousePointer2 size={19} />
                  </span>
                  <span className="preview-tool">
                    <Hand size={19} />
                  </span>
                  <span className="preview-tool">
                    <Type size={19} />
                  </span>
                  <span className="preview-tool">
                    <Square size={19} />
                  </span>
                  <span className="preview-tool">
                    <Plus size={19} />
                  </span>
                </div>
                <div className="glass-preview-boards glass-surface">
                  <span className="preview-board blue">T</span>
                  <span className="preview-board green">C</span>
                  <span className="preview-board purple">
                    <Folder size={19} />
                  </span>
                  <span className="preview-tool">
                    <Plus size={19} />
                  </span>
                </div>
              </div>
              <input
                id="panel-transparency"
                className="glass-slider"
                type="range"
                min="0"
                max="100"
                step="1"
                value={transparency}
                aria-label="Panel transparency"
                onChange={(event) => onTransparency(Number(event.currentTarget.value))}
              />
              <div className="glass-slider-scale">
                <span>Solid</span>
                <span>Clear</span>
              </div>
            </div>
          }
        >
          <output className="st-value" htmlFor="panel-transparency">
            {transparency}%
          </output>
        </Row>
      </Group>
      <Group>
        <Row
          id="nightGlow"
          title={
            <>
              Night glow <span className="experimental-label">Experimental</span>
            </>
          }
        >
          <Switch
            label="Night glow"
            checked={appearance.nightGlow}
            onChange={appearance.setNightGlow}
          />
        </Row>
      </Group>
    </div>
  );
}
