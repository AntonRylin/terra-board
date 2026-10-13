import { Container, Graphics, Text, type Texture } from 'pixi.js';
import type { CanvasObject } from '../model';
import { linkedFrameTitle, type FrameScene } from './frame-links.ts';
import { hasLinkImage } from './link-preview.ts';

export function frameMediaKey(o: CanvasObject): string | null {
  const id =
    o.type === 'document'
      ? o.documentPreviewId
      : o.type === 'image' || (o.type === 'link' && hasLinkImage(o))
        ? o.assetId
        : o.type === 'link'
          ? o.linkIconId
          : undefined;
  return id ? `${id}/${o.type === 'link' && !hasLinkImage(o) ? 'thumb' : 'preview'}` : null;
}

export function renderLinkedFrame(
  scene: FrameScene,
  resolution: number,
  dark: boolean,
  render: (object: CanvasObject, texture: Texture | null, icon: Texture | null) => Container,
  texture: (key: string) => Texture | null,
): Container {
  const o = scene.object;
  const shell = render(
    {
      ...o,
      frameLink: undefined,
      text: `↗ ${linkedFrameTitle(scene)}`,
      fontSize: scene.source?.fontSize,
      bold: scene.source?.bold,
      strikethrough: scene.source?.strikethrough,
    },
    null,
    null,
  );
  const content = new Container();
  const mask = new Graphics().rect(0, 0, o.width, o.height).fill('#ffffff');
  shell.addChild(content, mask);
  content.mask = mask;
  if (!scene.source) {
    const messages = {
      missing: 'Original frame unavailable',
      loading: 'Loading linked frame…',
      circular: 'Circular frame link',
      limit: 'Frame link nesting limit',
    };
    const label = new Text({
      text: messages[scene.status || 'missing'],
      resolution,
      style: {
        fontFamily: 'Segoe UI',
        fontSize: Math.min(14, o.width / 20, o.height / 5),
        fill: dark ? '#a6b3c5' : '#7b8797',
        wordWrap: true,
        wordWrapWidth: Math.max(1, o.width - 24),
      },
    });
    label.anchor.set(0.5);
    label.position.set(o.width / 2, o.height / 2);
    content.addChild(label);
    return shell;
  }
  const source = scene.source;
  const scale = Math.min(o.width / source.width, o.height / source.height);
  content.scale.set(scale);
  content.position.set(
    (o.width - source.width * scale) / 2,
    (o.height - source.height * scale) / 2,
  );
  if (source.pdfComposer) {
    const view = render(
      { ...source, x: 0, y: 0, rotation: 0 },
      texture(`composer:${JSON.stringify(source.pdfComposer)}:${source.width}:${source.height}`),
      null,
    );
    content.addChild(view);
  }
  for (const child of scene.children) {
    const item = child.object;
    const key = frameMediaKey(item);
    const composerKey = item.pdfComposer
      ? `composer:${JSON.stringify(item.pdfComposer)}:${item.width}:${item.height}`
      : null;
    const view = item.frameLink
      ? renderLinkedFrame(child, resolution * scale, dark, render, texture)
      : render(
          item,
          composerKey ? texture(composerKey) : key ? texture(key) : null,
          item.linkIconId ? texture(`${item.linkIconId}/thumb`) : null,
        );
    view.pivot.set(item.width / 2, item.height / 2);
    view.position.set(item.x + item.width / 2, item.y + item.height / 2);
    view.rotation = ((item.rotation || 0) * Math.PI) / 180;
    content.addChild(view);
  }
  return shell;
}
