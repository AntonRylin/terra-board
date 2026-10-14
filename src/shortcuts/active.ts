import { getPreferences, usePreferences } from '../settings/preferences.ts';
import { bindingsFor, commandForEvent, type CommandId } from './commands.ts';
import { formatBinding, matchesEvent, type ShortcutScope } from './keys.ts';

type KeyInput = Parameters<typeof commandForEvent>[0];

// Resolves a key event against the user's current bindings.
export const activeCommand = (e: KeyInput, scope: ShortcutScope) =>
  commandForEvent(e, scope, getPreferences().shortcuts);

export const isCommand = (e: KeyInput, id: CommandId) =>
  bindingsFor(id, getPreferences().shortcuts).some((b) => matchesEvent(b, e));

// The first binding, for tooltips and hints. Empty when the command is unbound.
export function useShortcutLabel(id: CommandId) {
  const { shortcuts } = usePreferences();
  const [first] = bindingsFor(id, shortcuts);
  return first ? formatBinding(first) : '';
}

export function useShortcutLabels() {
  const { shortcuts } = usePreferences();
  return (id: CommandId) => {
    const [first] = bindingsFor(id, shortcuts);
    return first ? formatBinding(first) : '';
  };
}
