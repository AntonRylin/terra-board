import {
  Cable,
  Cloud,
  KeyRound,
  CircleDot,
  CircleUserRound,
  HardDrive,
  Info,
  Keyboard,
  MousePointer2,
  Palette,
  PanelLeft,
  Puzzle,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { commands } from '../../shortcuts/commands';
import { android } from '../../bridge';

export type SectionId =
  | 'profile'
  | 'general'
  | 'appearance'
  | 'panel'
  | 'extensions'
  | 'canvas'
  | 'radial'
  | 'shortcuts'
  | 'account'
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
    id: 'extensions',
    label: 'Extensions',
    group: 'Extensions',
    icon: Puzzle,
    subtitle: 'Add the features you use. Removing one never deletes anything on your boards.',
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
    subtitle: 'A quick-tools wheel over the board; release the trigger to pick.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    group: 'Board',
    icon: Keyboard,
    subtitle: 'Click a shortcut, then press the keys you want.',
  },
  {
    id: 'account',
    label: 'Account',
    group: 'Data',
    icon: KeyRound,
    subtitle: 'Sign in to reach your cloud boards from any computer.',
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
// Android (docs/android.md) shows only what works on a phone: profiles,
// extensions, shortcuts, storage folders, AI tools and updates are desktop parts.
// Its Account page is the phone's own (src/mobile/ui/AccountSettings.tsx), listed first.
const androidSections = new Set<SectionId>(['account', 'appearance', 'panel', 'canvas']);
if (android)
  Object.assign(sectionById('account'), {
    group: 'App',
    subtitle: 'Your Terra Cloud boards on this phone.',
  });
export const visibleSections = android
  ? sections
      .filter((s) => androidSections.has(s.id))
      .sort((a, b) => Number(b.id === 'account') - Number(a.id === 'account'))
  : sections;
export const sectionVisible = (id: SectionId) => !android || androidSections.has(id);

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
    description: 'Plays for a few seconds when you open a shared board.',
    keywords: 'music sound entrance join audio',
  },
  publishSong: {
    section: 'profile',
    title: 'Let others hear my song when I join',
    keywords: 'music sound entrance',
  },
  hearOwnSong: {
    section: 'profile',
    title: 'Hear my song when I join a board',
    description: 'Only on boards shared with other people.',
    keywords: 'music sound entrance mute own',
  },
  playSongs: {
    section: 'profile',
    title: "Hear other people's songs",
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
    description: 'Open Terra Board when you sign in to your computer.',
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
  recordImageDetails: {
    section: 'canvas',
    title: 'Remember who added images',
    description:
      'New images keep the date and time they were added, and your profile name if you have one. Right-click an image and choose Details to see them.',
    keywords: 'image details added date time timestamp user name author history info',
  },
  radialSlots: {
    section: 'radial',
    title: 'Tools in the wheel',
    description: 'Choose the tool for each direction.',
    keywords: 'quick tools tab',
  },
  accountSignIn: {
    section: 'account',
    title: 'Sign in',
    description: 'Sign in to sync your boards and share them.',
    keywords: 'account login log in email code google microsoft',
  },
  accountClaim: {
    section: 'account',
    title: "Add a sign-in so you can't lose your cloud boards",
    description:
      'This computer syncs without an account. Sign in once and your cloud boards, shares and profile move to your account.',
    keywords: 'account login email google claim anonymous',
  },
  accountSignedIn: {
    section: 'account',
    title: 'Signed in',
    keywords: 'account email sign out log out logout',
  },
  accountDevices: {
    section: 'account',
    title: 'Your computers',
    description: 'Computers you sign in on appear here.',
    keywords: 'devices computers remove sign out',
  },
  accountDelete: {
    section: 'account',
    title: 'Delete account',
    description:
      'Delete your cloud library, its files and shares, and your sign-in. Boards on this computer stay.',
    keywords: 'delete remove erase gdpr privacy data account',
  },
  accountDeleteAnonymous: {
    section: 'account',
    title: 'Delete my cloud data',
    description:
      'Delete what this computer stored in the cloud, with its files and shares. Boards on this computer stay.',
    keywords: 'delete remove erase gdpr privacy data',
  },
  cloudServer: {
    section: 'account',
    title: 'Server',
    description: "Where your cloud boards are kept: Terra Cloud or your organization's server.",
    keywords: 'server address self-hosted company organization supabase connect',
  },
  cloudSignIn: {
    section: 'cloud',
    title: 'Sign in to sync',
    keywords: 'account login cloud sync',
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
    description: 'Upload your boards and keep them in sync on every computer you sign in on.',
    keywords: 'cloud backup supabase devices',
  },
  cloudJoin: {
    section: 'cloud',
    title: 'Join with a code',
    description: 'An invite someone sent you.',
    keywords: 'cloud code invite share',
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
  cloudDisable: {
    section: 'cloud',
    title: 'Turn off sync on this computer',
    description: 'Boards stay here and you stay signed in. Your other computers keep syncing.',
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
  // Each extension's row (ExtensionsSettings.tsx); descriptions match the manifests.
  extensionBackgroundRemoval: {
    section: 'extensions',
    title: 'Background removal',
    description: 'Cut people and objects out of photos. Runs on this PC.',
    keywords: 'extension install remove cutout cut out photo transparent image',
  },
  extensionSongLinks: {
    section: 'extensions',
    title: 'Song links',
    description: 'Pick your entrance song from a YouTube or other link.',
    keywords: 'extension install yt-dlp youtube audio music entrance',
  },
  extensionOfficeFiles: {
    section: 'extensions',
    title: 'Office files',
    description:
      'Open and convert .doc, .xls, .ppt, .rtf and OpenDocument files, using LibreOffice.',
    keywords: 'extension install word excel powerpoint libreoffice convert pdf',
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
  updates: {
    section: 'about',
    title: 'Updates',
    description: 'Terra Board checks for new versions and installs them when you close it.',
    keywords: 'update upgrade new version release download',
  },
  autoUpdates: {
    section: 'about',
    title: 'Check automatically',
    description:
      'Asks GitHub for a new version after launch and every 4 hours. When off, use Check now.',
    keywords: 'update automatic privacy network github offline',
  },
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
  return (
    all
      .filter((r) => sectionVisible(r.section))
      // The desktop's account rows are not on the phone's Account page.
      .filter((r) => !android || r.section !== 'account')
      .filter((r) => {
        const text = [r.title, r.description, r.keywords, sectionById(r.section).label]
          .join(' ')
          .toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .map(({ keywords: _, ...r }) => r)
  );
}
