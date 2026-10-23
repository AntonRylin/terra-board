import type { CloudServer } from '../../bridge';

// The Server row's description: "Terra Cloud", "Acme · terra.acme.eu",
// plus "Set by your organization." when the person cannot change it.
export function serverDescription(server: CloudServer | null): string {
  let text = server?.name ?? 'None';
  const host = server?.address?.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (server?.kind === 'custom' && host) text += ' · ' + host;
  if (server?.locked) text += ' · Set by your organization.';
  return text;
}

export const switchWarning =
  'Switching servers signs you out and turns off sync on this computer. Boards other people shared with you will be removed from it; your own boards stay.';

// "3 changes haven't uploaded yet." Empty when everything has uploaded.
export function unsentText(pending: number): string {
  if (pending <= 0) return '';
  return pending === 1
    ? "1 change hasn't uploaded yet."
    : `${pending} changes haven't uploaded yet.`;
}

// Shown with the count: what switching now costs.
export const unsentLoss =
  "If you switch now, edits to boards other people shared with you that haven't uploaded are lost. Your own boards and their edits stay on this computer.";
