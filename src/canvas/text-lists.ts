// Enter inside a list item continues the list: "2. milk" + Enter starts "3. ",
// "- milk" starts "- ". Enter on an empty item ends the list instead.

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}
export interface ListBreak {
  // Applied in order; each edit's offsets are in the text left by the previous one.
  edits: TextEdit[];
  text: string;
  caret: number;
}

const marker = /^([ \t]*)(?:(\d{1,9})([.)])|([-*•]))([ \t]+)/;

const lineStartAt = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1;
const lineEndAt = (text: string, index: number) => {
  const end = text.indexOf('\n', index);
  return end < 0 ? text.length : end;
};

export function listBreak(text: string, start: number, end: number): ListBreak | null {
  if (text.slice(start, end).includes('\n')) return null;
  const lineStart = lineStartAt(text, start),
    lineEnd = lineEndAt(text, end);
  const match = marker.exec(text.slice(lineStart, lineEnd));
  // Enter typed in front of (or inside) the marker is an ordinary line break.
  if (!match || start < lineStart + match[0].length) return null;
  const [whole, indent, number, separator, bullet, gap] = match;
  const edits: TextEdit[] = [];
  let working = text;
  const apply = (edit: TextEdit) => {
    edits.push(edit);
    working = working.slice(0, edit.start) + edit.text + working.slice(edit.end);
  };

  const content = text.slice(lineStart + whole.length, start) + text.slice(end, lineEnd);
  if (!content.trim()) {
    // An empty item: drop its marker and leave the caret on the now blank line.
    apply({ start: lineStart, end: lineEnd, text: '' });
    return { edits, text: working, caret: lineStart };
  }

  const next = number === undefined ? bullet : String(Number(number) + 1) + separator;
  const inserted = '\n' + indent + next + gap;
  apply({ start, end, text: inserted });
  const caret = start + inserted.length;

  if (number !== undefined) {
    // Shift the numbers of the items below so the list stays in sequence.
    let expected = Number(number) + 2,
      at = lineEndAt(working, caret);
    while (at < working.length) {
      const from = at + 1,
        to = lineEndAt(working, from);
      const line = working.slice(from, to);
      const item = marker.exec(line);
      if (item && item[1].length > indent.length) {
        at = to; // A nested item: leave it and keep going.
        continue;
      }
      if (!item || item[1] !== indent || item[3] !== separator) break;
      if (Number(item[2]) !== expected - 1) break;
      const digits = from + indent.length;
      apply({ start: digits, end: digits + item[2].length, text: String(expected) });
      expected++;
      at = lineEndAt(working, from);
    }
  }
  return { edits, text: working, caret };
}
