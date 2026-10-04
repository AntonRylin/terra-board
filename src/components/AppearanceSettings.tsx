import { Folder, Hand, MousePointer2, Plus, Square, Type, Sparkles } from 'lucide-react';
import { defaultPanelTransparency } from './useGlassAppearance';
import type { Appearance } from './useAppearance';
import ThemeSwitch from './ThemeSwitch';

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
    <section className="settings-section appearance-settings" aria-label="Appearance">
      <div className="appearance-heading">
        <div>
          <h2>Appearance</h2>
          <p>A different light. The same space.</p>
        </div>
        <button
          className="button glass-reset"
          onClick={() => onTransparency(defaultPanelTransparency)}
        >
          Reset
        </button>
      </div>
      <div className="theme-setting-row">
        <div>
          <strong>Color theme</strong>
          <p>
            {appearance.preference === 'system'
              ? 'Follows your device’s appearance.'
              : appearance.theme === 'dark'
                ? 'A quiet canvas after dark.'
                : 'A little room for daylight.'}
          </p>
        </div>
        <ThemeSwitch value={appearance.preference} onChange={appearance.setPreference} />
      </div>
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
      <div className="glass-slider-label">
        <label htmlFor="panel-transparency">Panel transparency</label>
        <output htmlFor="panel-transparency">{transparency}%</output>
      </div>
      <input
        id="panel-transparency"
        className="glass-slider"
        type="range"
        min="0"
        max="100"
        step="1"
        value={transparency}
        aria-describedby="panel-transparency-help"
        onChange={(event) => onTransparency(Number(event.currentTarget.value))}
      />
      <div className="glass-slider-scale">
        <span>Solid</span>
        <span>Clear</span>
      </div>
      <p id="panel-transparency-help" className="glass-setting-hint">
        Applies to the boards panel and tool panels. Icons stay crisp.
      </p>
      <div className="night-glow-setting">
        <span className="night-glow-symbol">
          <Sparkles size={20} strokeWidth={1.5} />
        </span>
        <div>
          <strong>
            Night glow <span className="experimental-label">Experimental</span>
          </strong>
          <p id="night-glow-help">
            Colored notes and shapes cast soft light and shadows across your board in dark mode.
          </p>
        </div>
        <button
          type="button"
          className="night-glow-switch"
          role="switch"
          aria-label="Night glow"
          aria-describedby="night-glow-help"
          aria-checked={appearance.nightGlow}
          onClick={() => appearance.setNightGlow(!appearance.nightGlow)}
        >
          <span />
        </button>
      </div>
    </section>
  );
}
