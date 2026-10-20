// Third-party files Terra Board's extensions are made of, each pinned to a
// version and checksum. The prepare-* scripts fetch them for the build, and
// build-extensions.mjs writes their download addresses into the catalog.

// Background removal's model, from rembg's release. Pinned after verifying
// rembg's published MD5: 60024c5c889badc19c04ad937298a77b.
export const u2net = {
  file: 'assets/models/u2net.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
  sha256: '8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491',
};

// yt-dlp, which fetches the audio of a song link (YouTube and many other sites)
// for entrance songs. The checksum is from the release's SHA2-256SUMS.
const ytDlpVersion = '2026.08.19';
export const ytDlp = {
  version: ytDlpVersion,
  file: 'build/yt-dlp/yt-dlp.exe',
  url: `https://github.com/yt-dlp/yt-dlp/releases/download/${ytDlpVersion}/yt-dlp.exe`,
  sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
};
