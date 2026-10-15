import { forwardRef, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  paragraphStarts,
  type RecognizedText,
  type RecognizedWord,
} from '../canvas/recognized-text';
import './text-layer.css';

interface Props {
  text: RecognizedText;
  /** Displayed size of the image or page the boxes are fractions of. */
  width: number;
  height: number;
  style?: CSSProperties;
}

let measureContext: CanvasRenderingContext2D | null = null;
function textWidth(text: string, size: number) {
  measureContext ||= document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * size * 0.5;
  measureContext.font = `${size}px sans-serif`;
  return measureContext.measureText(text).width;
}

function Word({
  word,
  width,
  height,
  top,
}: {
  word: RecognizedWord;
  width: number;
  height: number;
  top: number;
}) {
  const size = Math.max(1, word.height * height),
    box = Math.max(1, word.width * width);
  const natural = textWidth(word.text, size);
  return (
    <span
      className="text-layer-word"
      style={{ width: box, height: size, fontSize: size, top: word.y * height - top }}
    >
      <span style={{ transform: `scaleX(${natural > 0 ? box / natural : 1})` }}>{word.text}</span>
    </span>
  );
}

// Invisible text laid over an image or PDF page, so it can be selected and copied
// with the mouse like text in a document. Each line is real flowing text so a
// drag across the gaps between words selects smoothly.
const TextLayer = forwardRef<HTMLDivElement, Props>(function TextLayer(
  { text, width, height, style },
  ref,
) {
  const lines = useMemo(() => {
    const breaks = paragraphStarts(text);
    const result: ReactNode[] = [];
    text.lines.forEach((line, lineIndex) => {
      const words = line.words.filter((word) => word.text);
      if (!words.length) return;
      // Rotated PDF runs are placed one by one; their neighbours rarely share a baseline.
      const groups = words.some((word) => word.angle) ? words.map((word) => [word]) : [words];
      groups.forEach((group, groupIndex) => {
        const top = Math.min(...group.map((word) => word.y)) * height,
          bottom = Math.max(...group.map((word) => (word.y + word.height) * height)),
          left = group[0].x * width;
        const content: ReactNode[] = [];
        let end = left;
        group.forEach((word, index) => {
          const start = word.x * width,
            gap = start - end;
          if (index) {
            const size = bottom - top;
            content.push(
              <span
                key={'g' + index}
                className="text-layer-gap"
                style={{
                  width: Math.max(0, gap),
                  marginRight: Math.min(0, gap),
                  fontSize: size,
                  // Stretch the space across the whole gap so a selection reads as one band.
                  letterSpacing: Math.max(0, gap) - textWidth(' ', size),
                }}
              >
                {word.join ? '' : ' '}
              </span>,
            );
          }
          content.push(<Word key={index} word={word} width={width} height={height} top={top} />);
          end = Math.max(end, start + word.width * width);
        });
        result.push(
          <div
            key={`${lineIndex}:${groupIndex}`}
            className="text-layer-line"
            data-paragraph={(breaks[lineIndex] && !groupIndex) || undefined}
            style={{
              left,
              top,
              height: bottom - top,
              transform: group[0].angle ? `rotate(${group[0].angle}deg)` : undefined,
            }}
          >
            {content}
          </div>,
        );
      });
    });
    return result;
  }, [text, width, height]);
  return (
    <div
      ref={ref}
      className="text-layer"
      style={{ width, height, ...style }}
      onCopy={(event) => {
        const value = selectedLayerText(event.currentTarget);
        if (value === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData.setData('text/plain', value);
      }}
    >
      {lines}
    </div>
  );
});
export default TextLayer;

// The selected text, one line per recognized line, or null when the selection is elsewhere.
export function selectedLayerText(layer: HTMLElement): string | null {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(layer)) return null;
  const parts: string[] = [];
  for (const line of layer.querySelectorAll<HTMLElement>('.text-layer-line')) {
    if (!range.intersectsNode(line)) continue;
    const part = document.createRange();
    part.selectNodeContents(line);
    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
      part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
      part.setEnd(range.endContainer, range.endOffset);
    const value = part.toString().replace(/\s+$/, '');
    if (!value.trim()) continue;
    parts.push((parts.length && line.dataset.paragraph ? '\n' : '') + value);
  }
  return parts.length ? parts.join('\n') : null;
}

export function selectLayerText(layer: HTMLElement | null) {
  const selection = getSelection();
  if (!layer || !selection || !layer.querySelector('.text-layer-line')) return false;
  selection.selectAllChildren(layer);
  return true;
}

// Selecting text starts on a recognized word; everywhere else keeps its usual drag.
export const startsTextSelection = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('.text-layer-word, .text-layer-gap');
