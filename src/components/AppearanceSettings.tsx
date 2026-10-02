import { Folder, Hand, MousePointer2, Plus, Square, Type } from 'lucide-react';
import { defaultPanelTransparency } from './useGlassAppearance';

export default function AppearanceSettings({
  transparency,
  onTransparency,
}: {
  transparency: number;
  onTransparency: (value: number) => void;
}) {
  return (
    <section className="settings-section appearance-settings" aria-label="Appearance">
      <div className="appearance-heading">
        <div>
          <h2>Liquid glass</h2>
          <p>A lighter layer for your boards and tools.</p>
        </div>
        <button
          className="button glass-reset"
          onClick={() => onTransparency(defaultPanelTransparency)}
        >
          Reset
        </button>
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
    </section>
  );
}
