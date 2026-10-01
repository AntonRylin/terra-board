export type ObjectType =
  'text' | 'note' | 'rect' | 'ellipse' | 'frame' | 'image' | 'video' | 'link' | 'arrow';
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
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
export interface CanvasObject {
  arrow?: ArrowStyle;
  id: string;
  type: ObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  text?: string;
  imageTitle?: string;
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
export interface Board {
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
export interface Library {
  boards: Board[];
  folders: Folder[];
  lastBoard: string | null;
  backupError?: string | null;
}
export interface Document {
  board: Board;
  objects: CanvasObject[];
  camera: Camera;
  revision: number;
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
  'select' | 'hand' | 'text' | 'note' | 'rect' | 'ellipse' | 'frame' | 'link' | 'arrow';
export const uid = () => crypto.randomUUID();
