import { useEffect, useState } from 'react';
import { Lock, Plus, RotateCcw, Search } from 'lucide-react';
import { updatePreferences, usePreferences } from '../../settings/preferences';
import {
  bindingsFor,
  commandById,
  commands,
  conflictFor,
  fixedShortcuts,
  maxBindings,
  type Command,
  type CommandId,
  type ShortcutOverrides,
} from '../../shortcuts/commands';
import {
  bindingFromEvent,
  bindingKeys,
  formatBinding,
  reservedReason,
  sameBinding,
  type Binding,
} from '../../shortcuts/keys';
import { Group, Row } from './controls';

type Recording = { id: CommandId; index: number };
type Pending = Recording & { binding: Binding; other: Command };

const groups = ['Tools', 'Edit', 'View', 'App'] as const;

function withBindings(overrides: ShortcutOverrides, id: CommandId, list: Binding[]) {
  const next = { ...overrides };
  const defaults = commandById(id)?.defaults ?? [];
  // Matching the defaults again drops the override, so future default changes apply.
  if (list.length === defaults.length && list.every((b, i) => sameBinding(b, defaults[i])))
    delete next[id];
  else next[id] = list;
  return next;
}

function Keys({ binding }: { binding: Binding }) {
  return (
    <>
      {bindingKeys(binding).map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </>
  );
}

export function ShortcutSettings() {
  const { shortcuts } = usePreferences();
  const [recording, setRecording] = useState<Recording | null>(null);
  const [held, setHeld] = useState<Binding | null>(null);
  const [problem, setProblem] = useState<{ id: CommandId; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [filter, setFilter] = useState('');

  const store = (id: CommandId, index: number, binding: Binding | null, base = shortcuts) => {
    const list = [...bindingsFor(id, base)];
    if (binding) list[index] = binding;
    else list.splice(index, 1);
    updatePreferences({ shortcuts: withBindings(base, id, list.slice(0, maxBindings)) });
  };

  useEffect(() => {
    if (!recording) return;
    const command = commandById(recording.id)!;
    const down = (event: KeyboardEvent) => {
      // Capture before the settings page so Escape cancels recording instead of closing it.
      event.preventDefault();
      event.stopPropagation();
      const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      if (plain && event.key === 'Escape') {
        setRecording(null);
        return;
      }
      if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
        if (recording.index < bindingsFor(recording.id, shortcuts).length)
          store(recording.id, recording.index, null);
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) {
        setHeld({
          code: '',
          ctrl: event.ctrlKey || event.metaKey,
          shift: event.shiftKey,
          alt: event.altKey,
        });
        return;
      }
      const reason = reservedReason(binding, command.scope);
      if (reason) {
        setProblem({ id: recording.id, text: `${formatBinding(binding)}: ${reason}` });
        return;
      }
      setRecording(null);
      setProblem(null);
      const other = conflictFor(binding, shortcuts, recording.id);
      if (other) setPending({ ...recording, binding, other });
      else store(recording.id, recording.index, binding);
    };
    const up = (event: KeyboardEvent) => {
      event.stopPropagation();
      setHeld(
        event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
          ? {
              code: '',
              ctrl: event.ctrlKey || event.metaKey,
              shift: event.shiftKey,
              alt: event.altKey,
            }
          : null,
      );
    };
    const cancel = () => setRecording(null);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', cancel);
      setHeld(null);
    };
  }, [recording, shortcuts]);

  const start = (id: CommandId, index: number) => {
    setPending(null);
    setProblem(null);
    setRecording({ id, index });
  };

  const replace = () => {
    if (!pending) return;
    const otherList = bindingsFor(pending.other.id as CommandId, shortcuts).filter(
      (b) => !sameBinding(b, pending.binding),
    );
    const base = withBindings(shortcuts, pending.other.id as CommandId, otherList);
    store(pending.id, pending.index, pending.binding, base);
    setPending(null);
  };

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (name: string, keys: string) =>
    words.every((w) => (name + ' ' + keys).toLowerCase().includes(w));

  const renderCommand = (command: Command) => {
    const id = command.id as CommandId;
    const list = bindingsFor(id, shortcuts);
    if (!visible(command.name, list.map(formatBinding).join(' '))) return null;
    const isRecording = (index: number) => recording?.id === id && recording.index === index;
    const changed = id in shortcuts;
    const live =
      held && (held.ctrl || held.shift || held.alt)
        ? bindingKeys({ ...held, code: '' })
            .slice(0, -1)
            .join('+') + '+…'
        : 'Press keys…';
    return (
      <Row
        key={id}
        id={'shortcut-' + id}
        title={command.name}
        description={command.scope === 'app' ? 'Works everywhere, even while typing.' : undefined}
        below={
          <>
            {problem?.id === id && (
              <p className="st-row-problem" role="alert">
                {problem.text}
              </p>
            )}
            {pending?.id === id && (
              <div className="st-row-conflict" role="alert">
                <span>
                  {formatBinding(pending.binding)} is already used by{' '}
                  <strong>{pending.other.name}</strong>.
                </span>
                <button type="button" className="st-button primary" onClick={replace}>
                  Replace
                </button>
                <button type="button" className="st-button" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            )}
          </>
        }
      >
        <div className="st-shortcut">
          {list.map((binding, index) => (
            <button
              key={index}
              type="button"
              className="st-keys"
              data-recording={isRecording(index) || undefined}
              aria-label={`Change ${command.name} shortcut ${formatBinding(binding)}`}
              onClick={() => (isRecording(index) ? setRecording(null) : start(id, index))}
            >
              {isRecording(index) ? (
                <span className="st-recording">{live}</span>
              ) : (
                <Keys binding={binding} />
              )}
            </button>
          ))}
          {isRecording(list.length) && (
            <button
              type="button"
              className="st-keys"
              data-recording
              onClick={() => setRecording(null)}
            >
              <span className="st-recording">{live}</span>
            </button>
          )}
          {!list.length && !isRecording(0) && <span className="st-unset">Not set</span>}
          {list.length < maxBindings && !isRecording(list.length) && (
            <button
              type="button"
              className="st-icon-button"
              aria-label={`Add ${command.name} shortcut`}
              title="Add shortcut"
              onClick={() => start(id, list.length)}
            >
              <Plus size={15} />
            </button>
          )}
          <button
            type="button"
            className="st-icon-button"
            aria-label={`Reset ${command.name} shortcut`}
            title={`Reset to ${command.defaults.map(formatBinding).join(' / ') || 'none'}`}
            style={{ visibility: changed ? 'visible' : 'hidden' }}
            onClick={() => {
              const next = { ...shortcuts };
              delete next[id];
              updatePreferences({ shortcuts: next });
              setProblem(null);
            }}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </Row>
    );
  };

  const customized = Object.keys(shortcuts).length > 0;
  return (
    <>
      <div className="st-toolbar">
        <label className="st-filter">
          <Search size={15} />
          <input
            aria-label="Search shortcuts"
            placeholder="Search shortcuts"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="st-button"
          disabled={!customized}
          onClick={() => {
            updatePreferences({ shortcuts: {} });
            setProblem(null);
            setPending(null);
          }}
        >
          Reset all
        </button>
      </div>
      <p className="st-hint">
        While recording, press Backspace to remove a shortcut or Esc to cancel.
      </p>
      {groups.map((group) => {
        const items = commands
          .filter((c) => c.group === group)
          .map(renderCommand)
          .filter(Boolean);
        return items.length ? (
          <Group key={group} title={group}>
            {items}
          </Group>
        ) : null;
      })}
      {(() => {
        const fixed = fixedShortcuts.filter((f) => visible(f.name, f.keys));
        return fixed.length ? (
          <Group title="Fixed for now">
            {fixed.map((f) => (
              <Row key={f.name} title={f.name}>
                <span className="st-fixed">
                  <span>{f.keys}</span>
                  <Lock size={13} aria-label="Cannot be changed yet" />
                </span>
              </Row>
            ))}
          </Group>
        ) : null;
      })()}
    </>
  );
}
