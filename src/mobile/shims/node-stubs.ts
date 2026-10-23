// node:os and node:stream for code the storage worker bundles but only
// partly uses on Android.
export const hostname = () => {
  // "Android 16; Pixel 7 Build/BP2A…; wv": the model without the build number.
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/
    .exec(navigator.userAgent)?.[1]
    ?.trim();
  return model && model !== 'K' ? model : 'Android';
};
export const platform = () => 'android';
export const homedir = () => '/';
export const tmpdir = () => '/tmp';
export class Readable {
  static from(): never {
    throw Error('Streams are not available on Android');
  }
}
export default { hostname, platform, homedir, tmpdir, Readable };
