import type { Edit } from '../model';
export class History {
  private back: { forward: Edit; inverse: Edit; bytes: number }[] = [];
  private next: typeof this.back = [];
  private bytes = 0;
  push(forward: Edit, inverse: Edit) {
    const bytes = JSON.stringify([forward, inverse]).length * 2;
    this.back.push({ forward, inverse, bytes });
    this.bytes += bytes;
    this.next = [];
    while (this.back.length > 100 || (this.bytes > 24 * 1024 * 1024 && this.back.length > 1)) {
      this.bytes -= this.back.shift()!.bytes;
    }
  }
  undo(allow: (edit: Edit) => boolean = () => true) {
    if (this.back.length && !allow(this.back.at(-1)!.inverse)) return null;
    const e = this.back.pop();
    if (!e) return null;
    this.bytes -= e.bytes;
    this.next.push(e);
    return e.inverse;
  }
  redo(allow: (edit: Edit) => boolean = () => true) {
    if (this.next.length && !allow(this.next.at(-1)!.forward)) return null;
    const e = this.next.pop();
    if (!e) return null;
    this.back.push(e);
    this.bytes += e.bytes;
    return e.forward;
  }
  get canUndo() {
    return this.back.length > 0;
  }
  get canRedo() {
    return this.next.length > 0;
  }
}
