import { useId } from 'react';
import { mediaUrl } from '../bridge';
import type { BackgroundAppearance } from '../model';

export const defaultBackgroundAppearance: BackgroundAppearance = {
  blur: 0,
  brightness: 100,
  saturation: 100,
  sharpness: 0,
  filter: 'none',
};
const filters = {
  none: '',
  sepia: 'sepia(1)',
  mono: 'grayscale(1)',
  warm: 'sepia(.3) saturate(1.15)',
  cool: 'sepia(.25) hue-rotate(165deg)',
};

export function BackgroundImage({
  assetId,
  appearance = defaultBackgroundAppearance,
}: {
  assetId: string;
  appearance?: BackgroundAppearance;
}) {
  const id = 'background-sharp-' + useId().replace(/[^a-zA-Z0-9-]/g, '');
  const strength = appearance.sharpness / 100;
  const spread = appearance.blur * 3;
  return (
    <>
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: 'absolute', pointerEvents: 'none' }}
      >
        <defs>
          <filter
            id={id}
            colorInterpolationFilters="sRGB"
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feConvolveMatrix
              order="3"
              kernelMatrix={`0 ${-strength} 0 ${-strength} ${1 + strength * 4} ${-strength} 0 ${-strength} 0`}
              divisor="1"
              bias="0"
              preserveAlpha="true"
              edgeMode="duplicate"
            />
          </filter>
        </defs>
      </svg>
      <img
        className="board-wallpaper"
        src={mediaUrl(assetId)}
        alt=""
        draggable={false}
        style={{
          filter: `${strength ? `url("#${id}") ` : ''}blur(${appearance.blur}px) brightness(${appearance.brightness}%) saturate(${appearance.saturation}%) ${filters[appearance.filter]}`,
          inset: -spread,
          width: `calc(100% + ${spread * 2}px)`,
          height: `calc(100% + ${spread * 2}px)`,
        }}
      />
    </>
  );
}

export default function BoardBackgroundSettings({
  assetId,
  value,
  onChange,
}: {
  assetId: string;
  value: BackgroundAppearance;
  onChange: (value: BackgroundAppearance) => void;
}) {
  return (
    <div className="background-settings">
      <div className="background-settings-preview">
        <BackgroundImage assetId={assetId} appearance={value} />
      </div>
      {(
        [
          ['blur', 'Blur', 40, 'px'],
          ['sharpness', 'Sharpness', 100, '%'],
          ['brightness', 'Brightness', 200, '%'],
          ['saturation', 'Saturation', 200, '%'],
        ] as const
      ).map(([key, label, max, unit]) => (
        <div key={key}>
          <div className="glass-slider-label">
            <label htmlFor={'background-' + key}>{label}</label>
            <output>
              {value[key]}
              {unit}
            </output>
          </div>
          <input
            id={'background-' + key}
            className="glass-slider"
            type="range"
            min="0"
            max={max}
            step="1"
            value={value[key]}
            onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })}
          />
        </div>
      ))}
      <label className="background-filter-label">
        Filter
        <select
          aria-label="Background filter"
          value={value.filter}
          onChange={(event) =>
            onChange({ ...value, filter: event.target.value as BackgroundAppearance['filter'] })
          }
        >
          <option value="none">Original</option>
          <option value="sepia">Sepia</option>
          <option value="mono">Black &amp; white</option>
          <option value="warm">Warm</option>
          <option value="cool">Cool</option>
        </select>
      </label>
      <button
        className="button"
        type="button"
        onClick={() => onChange({ ...defaultBackgroundAppearance })}
      >
        Reset adjustments
      </button>
    </div>
  );
}
