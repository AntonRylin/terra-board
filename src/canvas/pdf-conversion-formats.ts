import type { CanvasObject } from '../model';
import { documentKind } from './document-files';

export const officeExtensions =
  /\.(doc|docm|dot|dotx|rtf|odt|ott|xls|xlsx|xlsm|xlsb|ods|ots|ppt|pptx|pptm|odp|odg)$/i;
export function convertibleDocument(name: string, mime = '') {
  return (
    documentKind(name, mime) !== 'file' ||
    mime.startsWith('text/') ||
    /\.(html?|text|txt)$/i.test(name) ||
    officeExtensions.test(name)
  );
}
export function convertibleFile(file: Pick<File, 'name' | 'type'>) {
  return (
    file.type.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif|ico)$/i.test(file.name) ||
    convertibleDocument(file.name, file.type)
  );
}
export function needsOfficeConversion(object: CanvasObject) {
  return (
    object.type === 'document' &&
    documentKind(object.text || '', object.documentMime) === 'file' &&
    officeExtensions.test(object.text || '')
  );
}
