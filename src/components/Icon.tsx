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
};
export const iconNames = Object.keys(icons);
export function BoardGlyph({ name, size = 20 }: { name: string; size?: number }) {
  const Icon = icons[name] || Lightbulb;
  return <Icon size={size} strokeWidth={1.65} aria-hidden />;
}
