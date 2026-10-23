// The sharp pipelines electron/store.cjs runs, on the WebView's own decoders:
// metadata, rotate (decoding already applies EXIF orientation), extract,
// resize to fit inside, and WebP/PNG/JPEG output.
import { Buffer } from 'buffer';
import { readFileSync } from './fs.ts';

type Format = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff' | 'bmp';
function format(b: Uint8Array): Format | undefined {
  const text = (start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && text(1, 4) === 'PNG') return 'png';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'webp';
  if (text(0, 4) === 'GIF8') return 'gif';
  if (text(4, 8) === 'ftyp' && /^avi[fs]$/.test(text(8, 12))) return 'avif';
  if (text(0, 4) === 'II*\0' || text(0, 4) === 'MM\0*') return 'tiff';
  if (text(0, 2) === 'BM') return 'bmp';
}
const mime: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' };

class Pipeline {
  private extractRect?: { left: number; top: number; width: number; height: number };
  private size?: { width: number; height: number; withoutEnlargement?: boolean };
  private output: { type: string; quality?: number } = { type: 'image/png' };
  private limit: number;
  private input: Uint8Array | string;
  constructor(input: Uint8Array | string, options?: { limitInputPixels?: number }) {
    this.input = input;
    this.limit = options?.limitInputPixels || 268402689;
  }
  private bytes() {
    return typeof this.input === 'string' ? readFileSync(this.input) : this.input;
  }
  private async bitmap() {
    const data = this.bytes() as Uint8Array;
    const kind = format(data);
    if (!kind || kind === 'tiff')
      throw Error(
        kind === 'tiff' ? 'TIFF images are not supported on Android' : 'Unsupported image format',
      );
    const image = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/' + kind }), {
      imageOrientation: 'from-image',
    });
    if (image.width * image.height > this.limit) {
      image.close();
      throw Error('Image is too large');
    }
    return { image, kind };
  }
  async metadata() {
    const { image, kind } = await this.bitmap();
    const { width, height } = image;
    image.close();
    // Width and height are already upright, so orientation is reported as normal.
    return { format: kind, width, height, orientation: 1 };
  }
  rotate() {
    return this;
  }
  extract(rect: { left: number; top: number; width: number; height: number }) {
    this.extractRect = rect;
    return this;
  }
  resize(options: { width: number; height: number; withoutEnlargement?: boolean }) {
    this.size = options;
    return this;
  }
  webp(options?: { quality?: number }) {
    this.output = { type: 'image/webp', quality: (options?.quality ?? 80) / 100 };
    return this;
  }
  jpeg(options?: { quality?: number }) {
    this.output = { type: 'image/jpeg', quality: (options?.quality ?? 80) / 100 };
    return this;
  }
  png() {
    this.output = { type: 'image/png' };
    return this;
  }
  async toBuffer() {
    const { image } = await this.bitmap();
    try {
      const src = this.extractRect || { left: 0, top: 0, width: image.width, height: image.height };
      let scale = 1;
      if (this.size) {
        scale = Math.min(this.size.width / src.width, this.size.height / src.height);
        if (this.size.withoutEnlargement) scale = Math.min(scale, 1);
      }
      const width = Math.max(1, Math.round(src.width * scale)),
        height = Math.max(1, Math.round(src.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, src.left, src.top, src.width, src.height, 0, 0, width, height);
      const blob = await canvas.convertToBlob(this.output);
      if (blob.type !== this.output.type && mime.webp === this.output.type)
        throw Error('This device cannot encode WebP images');
      return Buffer.from(await blob.arrayBuffer());
    } finally {
      image.close();
    }
  }
}

export default function sharp(input: Uint8Array | string, options?: { limitInputPixels?: number }) {
  return new Pipeline(input, options);
}
