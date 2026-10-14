import {
  Cable,
  Cloud,
  CircleDot,
  CircleUserRound,
  HardDrive,
  Info,
  Keyboard,
  MousePointer2,
  Palette,
  PanelLeft,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { commands } from '../../shortcuts/commands';

export type SectionId =
  | 'profile'
  | 'general'
  | 'appearance'
  | 'panel'
  | 'canvas'
  | 'radial'
  | 'shortcuts'
  | 'cloud'
  | 'storage'
  | 'ai'
  | 'about';

export type Section = {
  id: SectionId;
  label: string;
  group: string;
  icon: LucideIcon;
  subtitle: string;
};

export const sections: Section[] = [
  {
    id: 'profile',
    label: 'Profile',
    group: 'App',
    icon: CircleUserRound,
    subtitle: 'How you appear to people you share boards with.',
  },
  {
    id: 'general',
    label: 'General',
    group: 'App',
    icon: Settings2,
    subtitle: 'How Terra Board starts and behaves.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    group: 'App',
    icon: Palette,
    subtitle: 'A different light. The same space.',
  },
  {
    id: 'panel',
    label: 'Board panel',
    group: 'App',
    icon: PanelLeft,
    subtitle: 'The strip of board icons beside your canvas.',
  },
  {
    id: 'canvas',
    label: 'Canvas',
    group: 'Board',
    icon: MousePointer2,
    subtitle: 'Moving around and placing things on a board.',
  },
  {
    id: 'radial',
    label: 'Radial menu',
    group: 'Board',
    icon: CircleDot,
    subtitle: 'Quick tools that open at your cursor.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    group: 'Board',
    icon: Keyboard,
    subtitle: 'Click a shortcut, then press the keys you want.',
  },
  {
    id: 'cloud',
    label: 'Cloud sync',
    group: 'Data',
    icon: Cloud,
    subtitle: 'Your boards on every computer you use.',
  },
  {
    id: 'storage',
    label: 'Storage',
    group: 'Data',
    icon: HardDrive,
    subtitle: 'Where your boards live on this computer.',
  },
  {
    id: 'ai',
    label: 'AI connections',
    group: 'Data',
    icon: Cable,
    subtitle: 'Connect AI apps on this computer to your boards.',
  },
  {
    id: 'about',
    label: 'About',
    group: 'Other',
    icon: Info,
    subtitle: 'Terra Board on this computer.',
  },
];

export const sectionById = (id: SectionId) => sections.find((s) => s.id === id)!;

type RowInfo = { section: SectionId; title: string; description?: string; keywords?: string };

// Every searchable row. Components read their title and description from here,
// so search results always match what the page shows.
export const rows = {
  profileName: {
    section: 'profile',
    title: 'Name',
    description: 'Shown next to your cursor and picture.',
    keywords: 'nickname display account',
  },
  profilePicture: {
    section: 'profile',
    title: 'Picture',
    description: 'Drag to position, then save.',
    keywords: 'avatar photo image crop',
  },
  profileSong: {
    section: 'profile',
    title: 'Your song',
    description: 'Plays for others when you open a board they are on, for up to 12 seconds.',
    keywords: 'music sound entrance join audio',
  },
  publishSong: {
    section: 'profile',
    title: 'Play my song when I join a board',
    keywords: 'music sound entrance',
  },
  playSongs: {
    section: 'profile',
    title: "Play other people's songs",
    description: 'When someone opens the board you are on.',
    keywords: 'music sound mute entrance',
  },
  openLastBoard: {
    section: 'general',
    title: 'Open last board on start',
    description: 'Return to the board you had open. Otherwise start with the first board.',
  },
  confirmTrash: {
    section: 'general',
    title: 'Ask before moving a board to Trash',
    description: 'Show a confirmation first. Boards in Trash can always be restored.',
    keywords: 'delete confirm',
  },
  openAtLogin: {
    section: 'general',
    title: 'Launch at login',
    description: 'Open Terra Board when you sign in to Windows.',
    keywords: 'startup autostart',
  },
  theme: {
    section: 'appearance',
    title: 'Color theme',
    description: 'Light, dark, or follow your device.',
    keywords: 'dark mode light night',
  },
  transparency: {
    section: 'appearance',
    title: 'Panel transparency',
    description: 'Applies to the boards panel and tool panels. Icons stay crisp.',
    keywords: 'glass blur',
  },
  nightGlow: {
    section: 'appearance',
    title: 'Night glow',
    description:
      'Colored notes and shapes cast soft light and shadows across your board in dark mode.',
    keywords: 'dark lighting',
  },
  panelShown: {
    section: 'panel',
    title: 'Show board panel',
    description: 'Hide it for more room. Bring it back from the board name.',
    keywords: 'launcher sidebar hide',
  },
  panelMinimal: {
    section: 'panel',
    title: 'Minimal mode',
    description: 'A slimmer panel with smaller controls.',
    keywords: 'launcher compact',
  },
  panelCentered: {
    section: 'panel',
    title: 'Center panel',
    description: 'Keep the board icons centered along the edge.',
    keywords: 'launcher align',
  },
  wheel: {
    section: 'canvas',
    title: 'Mouse wheel',
    description: 'Zoom toward the pointer, or scroll the board like a page.',
    keywords: 'scroll trackpad pan zoom',
  },
  zoomSpeed: {
    section: 'canvas',
    title: 'Zoom speed',
    description: 'How far each wheel step zooms.',
  },
  snapping: {
    section: 'canvas',
    title: 'Snap to objects',
    description: 'Align edges and centers while moving or resizing. Hold Alt to skip once.',
    keywords: 'guides align',
  },
  radialSlots: {
    section: 'radial',
    title: 'Tools in the wheel',
    description: 'Choose the tool for each direction.',
    keywords: 'quick tools tab',
  },
  cloudName: {
    section: 'cloud',
    title: 'Your name',
    description: 'Shown to the people you share folders and boards with.',
    keywords: 'profile display name sharing',
  },
  cloudEnable: {
    section: 'cloud',
    title: 'Sync my whole library',
    description: 'Upload your boards and keep them in sync on every computer you add.',
    keywords: 'cloud backup supabase devices',
  },
  cloudJoin: {
    section: 'cloud',
    title: 'Join with a code',
    description: 'An invite someone sent you, or a code from another of your computers.',
    keywords: 'cloud pair code device invite share',
  },
  cloudLibrary: {
    section: 'cloud',
    title: 'Sync my whole library',
    keywords: 'cloud backup devices',
  },
  cloudShared: {
    section: 'cloud',
    title: 'Nothing shared yet',
    keywords: 'share people access invite',
  },
  cloudReceived: {
    section: 'cloud',
    title: 'Nothing shared with you yet',
    keywords: 'share invite friends',
  },
  cloudStatus: { section: 'cloud', title: 'Status', keywords: 'cloud sync' },
  cloudAddDevice: {
    section: 'cloud',
    title: 'Add a computer',
    description: 'Create a one-time code to enter on your other computer.',
    keywords: 'cloud pair code device',
  },
  cloudDisable: {
    section: 'cloud',
    title: 'Turn off sync on this computer',
    description: 'Boards stay here. Your other computers keep syncing.',
    keywords: 'cloud stop leave',
  },
  libraryFolder: {
    section: 'storage',
    title: 'Library folder',
    description: 'Boards, images and files are stored here.',
    keywords: 'location data path',
  },
  backups: {
    section: 'storage',
    title: 'Daily backups',
    description: 'A snapshot of your library is kept for each day you use Terra Board.',
    keywords: 'restore snapshot',
  },
  exportAll: {
    section: 'storage',
    title: 'Export all boards',
    description: 'Save every board with its media as .canvas files in a folder you choose.',
    keywords: 'backup copy move',
  },
  mcpAccess: {
    section: 'ai',
    title: 'AI access',
    description: 'Let Codex or Claude read and edit your boards.',
    keywords: 'mcp codex claude',
  },
  mcpPort: {
    section: 'ai',
    title: 'Port',
    description: 'Local port the AI connection listens on.',
    keywords: 'mcp',
  },
  version: { section: 'about', title: 'Version' },
  licenses: {
    section: 'about',
    title: 'Open-source licenses',
    description: 'Packages bundled with Terra Board.',
    keywords: 'third party notices',
  },
} satisfies Record<string, RowInfo>;

export type RowId = keyof typeof rows;

export type SearchResult = { id: string; section: SectionId; title: string; description?: string };

export function searchSettings(query: string): SearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all: (SearchResult & { keywords?: string })[] = [
    ...Object.entries(rows).map(([id, row]) => ({ id, ...(row as RowInfo) })),
    ...commands.map((c) => ({
      id: 'shortcut-' + c.id,
      section: 'shortcuts' as const,
      title: c.name,
      description: `${c.group} shortcut`,
      keywords: 'key shortcut',
    })),
  ];
  return all
    .filter((r) => {
      const text = [r.title, r.description, r.keywords, sectionById(r.section).label]
        .join(' ')
        .toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .map(({ keywords: _, ...r }) => r);
}
