// A POSIX node:path for the storage worker. The library lives at a fixed
// absolute root in the worker's file system, so resolve() starts from '/'.
function normalizeParts(parts: string[]) {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}
export function resolve(...paths: string[]) {
  let joined = '';
  for (let i = paths.length - 1; i >= 0 && !joined.startsWith('/'); i--)
    joined = paths[i] + (joined ? '/' + joined : '');
  return '/' + normalizeParts(joined.split('/')).join('/');
}
export function normalize(p: string) {
  const absolute = p.startsWith('/');
  const result = normalizeParts(p.split('/')).join('/');
  return (absolute ? '/' : '') + result || (absolute ? '/' : '.');
}
export const join = (...paths: string[]) => normalize(paths.filter(Boolean).join('/'));
export const isAbsolute = (p: string) => p.startsWith('/');
export function dirname(p: string) {
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : p.slice(0, i);
}
export function basename(p: string, ext?: string) {
  const base = p.replace(/\/+$/, '').split('/').pop() || '';
  return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
}
export function extname(p: string) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}
export function relative(from: string, to: string) {
  const a = resolve(from).split('/').filter(Boolean),
    b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export const sep = '/';
export const delimiter = ':';
const path = {
  resolve,
  normalize,
  join,
  isAbsolute,
  dirname,
  basename,
  extname,
  relative,
  sep,
  delimiter,
} as const;
export const posix = path;
export const win32 = path;
export default { ...path, posix, win32 };
