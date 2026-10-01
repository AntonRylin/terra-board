export type ObjectType =
  'text' | 'note' | 'rect' | 'ellipse' | 'frame' | 'image' | 'video' | 'link';
export interface CanvasObject {
  id: string;
  type: ObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  text?: string;
  color?: string;
  fontSize?: number;
  groupId?: string;
  assetId?: string;
  url?: string;
}
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface Board {
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
export type Tool = 'select' | 'hand' | 'text' | 'note' | 'rect' | 'ellipse' | 'frame' | 'link';
export const uid = () => crypto.randomUUID();
