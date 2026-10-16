import type { TextMark } from './canvas/rich-text';
export type ObjectType =
  | 'text'
  | 'note'
  | 'rect'
  | 'ellipse'
  | 'frame'
  | 'image'
  | 'video'
  | 'document'
  | 'link'
  | 'arrow'
  | 'highlight'
  | 'list'
  // A written document of A4 pages; 'document' is an attached file.
  | 'paper';
export interface ListItem {
  id: string;
  text: string;
  checked: boolean;
  marks?: TextMark[];
}
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfComposerSource {
  id: string;
  assetId: string;
  name: string;
  kind: 'pdf' | 'image';
  pageCount: number;
}
export interface PdfComposerPage {
  id: string;
  sourceId: string;
  pageIndex: number;
  rotation: number;
  row?: number;
}
export interface PdfComposerColumn {
  id: string;
  name: string;
  pages: PdfComposerPage[];
  slotCount?: number;
}
export interface PdfComposer {
  view?: 'stacked' | 'full';
  zoom?: number;
  sources: PdfComposerSource[];
  columns: PdfComposerColumn[];
}
export type ArrowHead = 'none' | 'arrow' | 'triangle' | 'open' | 'diamond' | 'circle';
export interface ArrowStyle {
  points: { x: number; y: number }[];
  line: 'straight' | 'curve' | 'elbow';
  start: ArrowHead;
  end: ArrowHead;
  dash: 'solid' | 'dashed' | 'dotted';
  thickness: number;
}
export interface HighlightStroke {
  points: { x: number; y: number }[];
  size: number;
}
export interface CanvasObject {
  frameLink?: { boardId: string; frameId: string };
  locked?: boolean;
  // Whole-object spoiler: media and documents blur under dust, frames hide
  // what they hold, until a viewer clicks. Reveals are local to each viewer.
  spoiler?: boolean;
  items?: ListItem[];
  listScale?: number;
  gallery?: { direction: 'right' | 'below'; size: number; gap: number };
  pdfComposer?: PdfComposer;
  galleryId?: string;
  galleryIndex?: number;
  galleryRow?: number;
  galleryColumn?: number;
  arrow?: ArrowStyle;
  highlight?: HighlightStroke;
  id: string;
  type: ObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  text?: string;
  // Inline formatting of `text`: edited on list titles, board text and notes.
  textMarks?: TextMark[];
  imageTitle?: string;
  documentTitle?: string;
  documentMime?: string;
  documentBytes?: number;
  documentPreviewId?: string;
  documentExcerpt?: string;
  documentPageCount?: number;
  color?: string;
  fontSize?: number;
  bold?: boolean;
  strikethrough?: boolean;
  centerX?: boolean;
  centerY?: boolean;
  rotation?: number;
  textBox?: boolean;
  groupId?: string;
  assetId?: string;
  crop?: ImageCrop;
  url?: string;
  linkDescription?: string;
  linkIconId?: string;
  linkCompact?: boolean;
  linkPreviewHeight?: number;
}
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface BackgroundAppearance {
  blur: number;
  brightness: number;
  saturation: number;
  sharpness: number;
  filter: 'none' | 'sepia' | 'mono' | 'warm' | 'cool';
}
export interface Board {
  backgroundAppearance?: BackgroundAppearance;
  backgroundAssetId?: string | null;
  showInitial?: boolean;
  iconShape?: 'rounded' | 'circle';
  id: string;
  name: string;
  icon: string;
  color: string;
  folderId: string | null;
  position: number;
  trashed: boolean;
  updated: number;
}
export interface Folder {
  id: string;
  name: string;
  position: number;
}
// 'owner': this person shares it; 'view' / 'edit': someone shared it with them.
export type SharingMark = { shared: 'owner' | 'view' | 'edit'; owner?: string };
export interface Library {
  boards: Board[];
  folders: Folder[];
  lastBoard: string | null;
  backupError?: string | null;
  sharing?: {
    boards: Record<string, SharingMark>;
    folders: Record<string, SharingMark>;
    // Boards taken out of the cloud: kept here, never synced.
    local?: string[];
  };
}
export interface Document {
  board: Board;
  objects: CanvasObject[];
  camera: Camera;
  revision: number;
}
export interface ContentSearchResult {
  boardId: string;
  objectId: string;
  type: ObjectType;
  excerpt: string;
}
export interface ContentSearchResponse {
  results: ContentSearchResult[];
  hasMore: boolean;
}
export interface Asset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}
export interface Edit {
  upserts: CanvasObject[];
  deleted: string[];
}
export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'note'
  | 'rect'
  | 'ellipse'
  | 'frame'
  | 'link'
  | 'arrow'
  | 'highlight';
export const uid = () => crypto.randomUUID();
