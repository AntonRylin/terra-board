import { useState } from 'react';
import {
  Frame,
  Hand,
  Highlighter,
  ImagePlus,
  Images,
  Link2,
  ListTodo,
  NotebookPen,
  CodeXml,
  MousePointer2,
  MoveUpRight,
  Settings2,
  Square,
  StickyNote,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { updatePreferences, usePreferences, type ZoomSpeed } from '../../settings/preferences';
import { defaultRadialLayout, radialSectors } from '../radial-layout';
import { toolbarIds, type ToolbarId } from '../toolbar-layout';
import { useShortcutLabel } from '../../shortcuts/active';
import { Group, Row, Select, Switch } from './controls';

export function CanvasSettings() {
  const preferences = usePreferences();
  return (
    <Group>
      <Row id="wheel">
        <Select
          label="Mouse wheel"
          value={preferences.wheel}
          onChange={(wheel) => updatePreferences({ wheel })}
          options={[
            { value: 'zoom', label: 'Zoom', description: 'The wheel zooms toward the pointer.' },
            {
              value: 'pan',
              label: 'Pan',
              description: 'The wheel scrolls the board. Hold Ctrl to zoom.',
            },
          ]}
        />
      </Row>
      <Row id="zoomSpeed">
        <Select<ZoomSpeed>
          label="Zoom speed"
          value={preferences.zoomSpeed}
          onChange={(zoomSpeed) => updatePreferences({ zoomSpeed })}
          options={[
            { value: 'slow', label: 'Slow' },
            { value: 'normal', label: 'Normal' },
            { value: 'fast', label: 'Fast' },
          ]}
        />
      </Row>
      <Row id="snapping">
        <Switch
          label="Snap to objects"
          checked={preferences.snapping}
          onChange={(snapping) => updatePreferences({ snapping })}
        />
      </Row>
    </Group>
  );
}

const toolInfo: Record<ToolbarId, { label: string; icon: LucideIcon }> = {
  select: { label: 'Select', icon: MousePointer2 },
  hand: { label: 'Pan', icon: Hand },
  text: { label: 'Text', icon: Type },
  note: { label: 'Note', icon: StickyNote },
  rect: { label: 'Shape', icon: Square },
  arrow: { label: 'Arrow', icon: MoveUpRight },
  highlight: { label: 'Highlighter', icon: Highlighter },
  frame: { label: 'Frame', icon: Frame },
  link: { label: 'Link', icon: Link2 },
  list: { label: 'List', icon: ListTodo },
  paper: { label: 'Document', icon: NotebookPen },
  html: { label: 'HTML embed', icon: CodeXml },
  media: { label: 'Files', icon: ImagePlus },
  gallery: { label: 'Gallery', icon: Images },
};
const directions = [
  'Up',
  'Up right',
  'Right',
  'Down right',
  'Down',
  'Down left',
  'Left',
  'Up left',
];

// Sector 0 points up; sectors advance clockwise in 45° steps.
const sectorPosition = (sector: number) => {
  const angle = (sector * Math.PI) / 4;
  return { left: `${50 + Math.sin(angle) * 36}%`, top: `${50 - Math.cos(angle) * 36}%` };
};

export function RadialSettings() {
  const { radial } = usePreferences();
  const [focus, setFocus] = useState<number | null>(null);
  const trigger = useShortcutLabel('view.radial');
  const changed = radial.some((id, index) => id !== defaultRadialLayout()[index]);
  const setSlot = (index: number, id: ToolbarId) => {
    const next = [...radial];
    // A tool appears once; the slot that had it receives the replaced tool.
    const previous = next.indexOf(id);
    if (previous >= 0) next[previous] = next[index];
    next[index] = id;
    updatePreferences({ radial: next });
  };
  return (
    <Group
      action={
        <button
          type="button"
          className="st-text-button"
          disabled={!changed}
          onClick={() => updatePreferences({ radial: defaultRadialLayout() })}
        >
          Reset
        </button>
      }
    >
      <Row
        id="radialSlots"
        below={
          <div className="st-radial">
            <div className="st-radial-wheel" aria-hidden="true">
              {radial.map((id, index) => {
                const Icon = toolInfo[id].icon;
                return (
                  <span
                    key={index}
                    className="st-radial-slot"
                    data-focus={focus === index || undefined}
                    style={sectorPosition(radialSectors[index])}
                  >
                    <Icon size={18} />
                  </span>
                );
              })}
              <span className="st-radial-slot customize" style={sectorPosition(4)}>
                <Settings2 size={16} />
              </span>
              <span className="st-radial-center">{trigger || 'Off'}</span>
            </div>
            <div className="st-radial-list">
              {radial.map((id, index) => (
                <div
                  className="st-radial-item"
                  key={index}
                  onPointerEnter={() => setFocus(index)}
                  onPointerLeave={() => setFocus(null)}
                  onFocus={() => setFocus(index)}
                  onBlur={() => setFocus(null)}
                >
                  <span>{directions[radialSectors[index]]}</span>
                  <Select<ToolbarId>
                    label={`${directions[radialSectors[index]]} slot`}
                    value={id}
                    onChange={(tool) => setSlot(index, tool)}
                    options={toolbarIds.map((tool) => ({
                      value: tool,
                      label: toolInfo[tool].label,
                    }))}
                  />
                </div>
              ))}
            </div>
          </div>
        }
      />
    </Group>
  );
}
