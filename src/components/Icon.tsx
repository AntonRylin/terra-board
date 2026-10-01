import { mediaUrl } from '../bridge';
import {
  House,
  Lightbulb,
  Notebook,
  Palette,
  Camera,
  Mountain,
  Flower2,
  Rocket,
  Sparkles,
  Layers,
  BookOpen,
  Briefcase,
  Plane,
  Image as ImageIcon,
  Folder,
  Heart,
  Star,
  Sun,
  Moon,
  Cloud,
  Leaf,
  TreePine,
  Flame,
  Zap,
  Globe,
  Compass,
  Map,
  MapPin,
  Calendar,
  Clock,
  Check,
  Flag,
  Target,
  Trophy,
  Music,
  Headphones,
  Gamepad2,
  Film,
  Video,
  MessageCircle,
  Users,
  User,
  GraduationCap,
  Code,
  Terminal,
  Monitor,
  Smartphone,
  ShoppingBag,
  Gift,
  Coffee,
  Utensils,
  PenTool,
  Scissors,
  Wrench,
  Settings,
  Lock,
  KeyRound,
  Gem,
  Smile,
  Cat,
  Dog,
  Bike,
} from 'lucide-react';
const icons: Record<string, typeof House> = {
  house: House,
  lightbulb: Lightbulb,
  notebook: Notebook,
  palette: Palette,
  camera: Camera,
  mountain: Mountain,
  'flower-2': Flower2,
  rocket: Rocket,
  sparkles: Sparkles,
  layers: Layers,
  'book-open': BookOpen,
  briefcase: Briefcase,
  plane: Plane,
  image: ImageIcon,
  folder: Folder,
  heart: Heart,
  star: Star,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  leaf: Leaf,
  'tree-pine': TreePine,
  flame: Flame,
  zap: Zap,
  globe: Globe,
  compass: Compass,
  map: Map,
  'map-pin': MapPin,
  calendar: Calendar,
  clock: Clock,
  check: Check,
  flag: Flag,
  target: Target,
  trophy: Trophy,
  music: Music,
  headphones: Headphones,
  'gamepad-2': Gamepad2,
  film: Film,
  video: Video,
  'message-circle': MessageCircle,
  users: Users,
  user: User,
  'graduation-cap': GraduationCap,
  code: Code,
  terminal: Terminal,
  monitor: Monitor,
  smartphone: Smartphone,
  'shopping-bag': ShoppingBag,
  gift: Gift,
  coffee: Coffee,
  utensils: Utensils,
  'pen-tool': PenTool,
  scissors: Scissors,
  wrench: Wrench,
  settings: Settings,
  lock: Lock,
  'key-round': KeyRound,
  gem: Gem,
  smile: Smile,
  cat: Cat,
  dog: Dog,
  bike: Bike,
};
export const iconNames = Object.keys(icons);
export function BoardGlyph({
  name,
  size = 20,
  boardName = '',
  showInitial = true,
}: {
  name: string;
  size?: number;
  boardName?: string;
  showInitial?: boolean;
}) {
  if (name === 'none') {
    const first =
      new Intl.Segmenter('und', { granularity: 'grapheme' })
        .segment(boardName.trim())
        [Symbol.iterator]()
        .next().value?.segment || '';
    return showInitial && first ? (
      <span className="board-initial" style={{ fontSize: size }} aria-hidden="true">
        {first.toLocaleUpperCase()}
      </span>
    ) : null;
  }
  if (name.startsWith('emoji:'))
    return (
      <span className="board-emoji" style={{ fontSize: size }} aria-hidden="true">
        {name.slice(6)}
      </span>
    );
  if (/^asset-[a-f0-9]{64}$/.test(name))
    return (
      <img
        className="board-image-icon"
        src={mediaUrl(name.slice(6), 'thumb')}
        width={size}
        height={size}
        alt=""
        draggable={false}
      />
    );
  const Icon = icons[name] || Lightbulb;
  return <Icon size={size} strokeWidth={1.65} aria-hidden />;
}
